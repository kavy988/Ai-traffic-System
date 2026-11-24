(function (root) {
  'use strict';

  const SCHEMA_VERSION = 'signal-studio-ml-data/v1';
  const MAX_TRANSITIONS_PER_EPISODE = 1500;
  const REWARD_WEIGHTS = Object.freeze({
    waitingVehicleSeconds: 0.01,
    queuedVehicleSeconds: 0.05,
    completedJourney: 2
  });

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function number(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function totalWaitSeconds(snapshot) {
    const activeWait = (snapshot.vehicles || []).reduce((sum, vehicle) =>
      sum + Math.max(0, number(vehicle.runWaitTime, number(vehicle.waitTime, 0))), 0);
    const completedCount = Math.max(0, number(snapshot.metrics && snapshot.metrics.completed, 0));
    const completedAverage = number(snapshot.metrics && snapshot.metrics.avgWaitOverall, 0);
    const completedWait = number(snapshot.metrics && snapshot.metrics.completedWaitSeconds, null);
    return activeWait + Math.max(0, Number.isFinite(completedWait) ? completedWait : completedCount * completedAverage);
  }

  function stateObservation(engine, snapshot) {
    if (engine && typeof engine.getObservation === 'function') return engine.getObservation();
    return snapshot;
  }

  function decisionKey(decision) {
    return `${decision.nodeId || ''}:${decision.streetId || ''}:${decision.reverse ? '1' : '0'}`;
  }

  function signalFor(snapshot, decision) {
    return (snapshot.signals || []).find((signal) =>
      signal.nodeId === decision.nodeId && signal.streetId === decision.streetId && Boolean(signal.reverse) === Boolean(decision.reverse));
  }

  function queueAwareBaseline(observation) {
    const decision = observation.decision || {};
    const minGreen = Math.max(0, number(decision.minGreen, 10));
    const maxGreen = Math.max(minGreen, number(decision.maxGreen, 30));
    const roads = new Map((observation.roads || []).map((road) => [road.id, road]));
    const peers = (observation.signals || []).filter((signal) => signal.nodeId === decision.nodeId);
    const pressureFor = (signal) => {
      const road = roads.get(signal.streetId);
      if (!road) return 0;
      const load = Math.max(0, number(road.queue, 0)) + Math.max(0, number(road.pedestrians, 0)) * 0.75;
      const speed = Math.max(0.25, number(signal.reverse ? road.reverseSpeedFactor : road.forwardSpeedFactor, road.speedFactor || 1));
      return load / speed;
    };
    const peerPressures = peers.map(pressureFor);
    const totalPressure = peerPressures.reduce((sum, value) => sum + value, 0);
    const peerIndex = peers.findIndex((signal) => signal.streetId === decision.streetId && Boolean(signal.reverse) === Boolean(decision.reverse));
    const localPressure = peerIndex >= 0 ? peerPressures[peerIndex] : 0;
    const averagePressure = peerPressures.length ? totalPressure / peerPressures.length : 0;
    const relativeLoad = averagePressure > 0 ? localPressure / averagePressure : 1;
    // The floor preserves service on light approaches; the simulator independently
    // constrains this proposal to its legal green and red-wait bounds.
    const queueShare = relativeLoad / (1 + relativeLoad);
    const allocation = clamp(0.2 + queueShare * 0.6, 0.2, 0.8);
    return { holdSeconds: minGreen + (maxGreen - minGreen) * allocation };
  }

  function create(engine, options) {
    const config = options || {};
    let policy = 'baseline';
    let runController = 'adaptive';
    let externalModel = null;
    let currentEpisode = null;
    let nextEpisodeNumber = 1;
    let nextTransitionNumber = 1;
    let lastSnapshot = null;
    const episodes = [];
    const pending = new Map();

    function newEpisode(seed, snapshot) {
      currentEpisode = {
        id: `episode-${String(nextEpisodeNumber++).padStart(4, '0')}`,
        seed: number(seed, 42) >>> 0,
        controller: runController,
        controllerHistory: [{ time: number(snapshot && snapshot.time, 0), controller: runController }],
        startedAt: new Date().toISOString(),
        initialObservation: clone(stateObservation(engine, snapshot)),
        transitions: [],
        transitionCountTotal: 0,
        completedTransitionCount: 0,
        cumulativeReward: 0,
        droppedTransitionCount: 0,
        status: 'in_progress',
        summary: null
      };
      episodes.push(currentEpisode);
      while (episodes.length > 20) episodes.shift();
      lastSnapshot = snapshot || engine.getSnapshot();
      pending.clear();
      return currentEpisode;
    }

    function pushTransition(transition) {
      if (!currentEpisode) newEpisode(config.seed, engine.getSnapshot());
      currentEpisode.transitionCountTotal += 1;
      if (Number.isFinite(transition.reward)) {
        currentEpisode.completedTransitionCount += 1;
        currentEpisode.cumulativeReward += transition.reward;
      }
      if (currentEpisode.transitions.length >= MAX_TRANSITIONS_PER_EPISODE) {
        currentEpisode.transitions.shift();
        currentEpisode.droppedTransitionCount += 1;
      }
      currentEpisode.transitions.push(transition);
    }

    function getCurrentState(snapshot) {
      const metrics = snapshot.metrics || {};
      return {
        time: number(snapshot.time, 0),
        queued: number(metrics.queued, 0),
        avgWait: number(metrics.avgWait, null),
        avgWaitSampleCount: number(metrics.avgWaitSampleCount, 0),
        avgWaitLastCompletionAgeSeconds: number(metrics.avgWaitLastCompletionAgeSeconds, null),
        avgWaitOverall: number(metrics.avgWaitOverall, null),
        completed: number(metrics.completed, 0),
        totalArrived: number(metrics.totalArrived, 0),
        throughput: number(metrics.throughput, 0),
        active: number(metrics.active, (snapshot.vehicles || []).length),
        totalWaitSeconds: totalWaitSeconds(snapshot)
      };
    }

    function addQueueExposure(item, snapshot) {
      if (!item.started || !item.lastState) return;
      const current = getCurrentState(snapshot);
      const elapsed = Math.max(0, current.time - item.lastState.time);
      item.queuedVehicleSeconds += ((item.lastState.queued + current.queued) / 2) * elapsed;
      item.lastState = current;
    }

    function finalize(item, snapshot, status, done) {
      if (!item || item.finalized) return;
      item.finalized = true;
      const nextObservation = clone(stateObservation(engine, snapshot));
      const nextState = getCurrentState(snapshot);
      const start = item.startState;
      const waitSeconds = start ? Math.max(0, nextState.totalWaitSeconds - start.totalWaitSeconds) : 0;
      const departures = start ? Math.max(0, nextState.completed - start.completed) : 0;
      const elapsed = start ? Math.max(0, nextState.time - start.time) : 0;
      if (item.started) item.action.observedGreenIntervalSeconds = round(elapsed, 2);
      const queueTerm = -REWARD_WEIGHTS.queuedVehicleSeconds * item.queuedVehicleSeconds;
      const waitTerm = -REWARD_WEIGHTS.waitingVehicleSeconds * waitSeconds;
      const departureTerm = REWARD_WEIGHTS.completedJourney * departures;
      const reward = item.started ? queueTerm + waitTerm + departureTerm : null;
      const transition = {
        id: item.id,
        observation: item.observation,
        action: item.action,
        nextObservation,
        reward,
        rewardTerms: item.started ? {
          waitingVehicleSeconds: round(waitSeconds, 2),
          queuedVehicleSeconds: round(item.queuedVehicleSeconds, 2),
          departures: departures,
          waitingPenalty: round(waitTerm, 4),
          queuePenalty: round(queueTerm, 4),
          departureReward: round(departureTerm, 4),
          elapsedSeconds: round(elapsed, 2),
          weights: REWARD_WEIGHTS
        } : null,
        nextState: {
          time: nextState.time,
          queued: nextState.queued,
          avgWait: nextState.avgWait,
          avgWaitSampleCount: nextState.avgWaitSampleCount,
          avgWaitLastCompletionAgeSeconds: nextState.avgWaitLastCompletionAgeSeconds,
          avgWaitOverall: nextState.avgWaitOverall,
          completed: nextState.completed,
          totalArrived: nextState.totalArrived,
          throughput: nextState.throughput,
          active: nextState.active,
          totalWaitSeconds: round(nextState.totalWaitSeconds, 2),
          phaseQueue: phaseQueue(snapshot, item.decision)
        },
        startedAt: item.startState ? item.startState.time : null,
        endedAt: nextState.time,
        transitionStatus: status,
        done: Boolean(done)
      };
      pushTransition(transition);
    }

    function phaseQueue(snapshot, decision) {
      const road = (snapshot.roads || []).find((entry) => entry.id === decision.streetId);
      return road ? { streetId: road.id, queue: road.queue, count: road.count } : null;
    }

    function issue(observation) {
      const decision = observation.decision || {};
      const minGreen = Math.max(0, number(decision.minGreen, 10));
      const maxGreen = Math.max(minGreen, number(decision.maxGreen, 30));
      const controllerInput = clone(observation);
      let proposed;
      let rawResult;
      let source = policy;
      try {
        if (policy === 'external' && externalModel) {
          rawResult = externalModel(clone(controllerInput));
          source = 'external_model';
        } else {
          rawResult = queueAwareBaseline(controllerInput);
          source = 'queue_aware_baseline';
        }
        proposed = number(rawResult && rawResult.holdSeconds, maxGreen);
      } catch (error) {
        rawResult = { holdSeconds: maxGreen };
        proposed = maxGreen;
        source = `${source}_fallback`;
      }
      const bounded = clamp(proposed, minGreen, maxGreen);
      const snapshot = engine.getSnapshot();
      const signal = signalFor(snapshot, decision);
      const key = decisionKey(decision);
      const prior = pending.get(key);
      if (prior) {
        finalize(prior, snapshot, prior.started ? 'superseded' : 'not_executed', false);
        pending.delete(key);
      }
      const action = {
        type: 'green_duration',
        phase: {
          nodeId: decision.nodeId || null,
          streetId: decision.streetId || null,
          reverse: Boolean(decision.reverse)
        },
        proposedSeconds: round(proposed, 3),
        boundedSeconds: round(bounded, 3),
        minGreenSeconds: round(minGreen, 3),
        maxGreenSeconds: round(maxGreen, 3),
        constrained: Math.abs(proposed - bounded) > 1e-9,
        controller: source
      };
      pending.set(key, {
        id: `transition-${String(nextTransitionNumber++).padStart(6, '0')}`,
        key,
        decision: { ...decision },
        observation: clone(controllerInput),
        action,
        started: false,
        armed: Boolean(signal && signal.color !== 'green'),
        queuedVehicleSeconds: 0,
        startState: null,
        lastState: null,
        finalized: false
      });
      return { holdSeconds: bounded };
    }

    function observeSnapshot(snapshot) {
      if (!snapshot) return;
      if (!currentEpisode) newEpisode(config.seed, snapshot);
      for (const [key, item] of pending) {
        const signal = signalFor(snapshot, item.decision);
        if (!signal) continue;
        if (!item.armed) {
          if (signal.color !== 'green') item.armed = true;
          continue;
        }
        if (!item.started && signal.color === 'green') {
          item.started = true;
          item.startState = getCurrentState(snapshot);
          item.lastState = item.startState;
          continue;
        }
        if (item.started && signal.color === 'green') {
          addQueueExposure(item, snapshot);
        } else if (item.started) {
          addQueueExposure(item, snapshot);
          finalize(item, snapshot, 'completed', false);
          pending.delete(key);
        }
      }
      lastSnapshot = snapshot;
      if (currentEpisode) currentEpisode.summary = summarize(snapshot);
    }

    function summarize(snapshot) {
      const current = snapshot || lastSnapshot || engine.getSnapshot();
      const metrics = current.metrics || {};
      return {
        seed: currentEpisode ? currentEpisode.seed : number(config.seed, 42),
        controller: currentEpisode ? currentEpisode.controller : runController,
        simulatedSeconds: number(current.time, 0),
        transitionCount: currentEpisode ? currentEpisode.transitionCountTotal + pending.size : pending.size,
        completedTransitionCount: currentEpisode ? currentEpisode.completedTransitionCount : 0,
        incompleteTransitionCount: pending.size,
        cumulativeReward: currentEpisode ? round(currentEpisode.cumulativeReward, 4) : 0,
        active: number(metrics.active, (current.vehicles || []).length),
        queued: number(metrics.queued, 0),
        completed: number(metrics.completed, 0),
        avgWait: number(metrics.avgWait, null),
        avgWaitSampleCount: number(metrics.avgWaitSampleCount, 0),
        avgWaitLastCompletionAgeSeconds: number(metrics.avgWaitLastCompletionAgeSeconds, null),
        avgWaitOverall: number(metrics.avgWaitOverall, null),
        throughput: number(metrics.throughput, 0),
        totalArrived: number(metrics.totalArrived, 0),
        droppedTransitionCount: currentEpisode ? currentEpisode.droppedTransitionCount : 0
      };
    }

    function round(value, digits) {
      const factor = 10 ** (digits === undefined ? 3 : digits);
      return Math.round((number(value, 0) + Number.EPSILON) * factor) / factor;
    }

    function endEpisode(snapshot, reason) {
      const current = snapshot || engine.getSnapshot();
      for (const [key, item] of pending) {
        if (item.started) {
          addQueueExposure(item, current);
          finalize(item, current, reason || 'episode_ended', true);
        } else {
          finalize(item, current, 'not_executed', true);
        }
        pending.delete(key);
      }
      if (currentEpisode) {
        currentEpisode.status = 'completed';
        currentEpisode.endedAt = new Date().toISOString();
        currentEpisode.endReason = reason || 'episode_ended';
        currentEpisode.summary = summarize(current);
      }
      lastSnapshot = current;
      return currentEpisode;
    }

    function beginEpisode(seed, snapshot, controllerLabel) {
      if (controllerLabel) runController = String(controllerLabel);
      return newEpisode(seed, snapshot || engine.getSnapshot());
    }

    function setPolicy(nextPolicy) {
      if (nextPolicy === 'external' && !externalModel) return { ok: false, message: 'Register an external model first.' };
      if (!['baseline', 'external'].includes(nextPolicy)) return { ok: false, message: 'Choose the queue-aware baseline or an external model.' };
      policy = nextPolicy;
      runController = nextPolicy === 'baseline' ? 'queue_aware_baseline' : 'external_model';
      if (currentEpisode && currentEpisode.transitions.length === 0) currentEpisode.controller = policy;
      recordControllerChange();
      return { ok: true, message: policy === 'baseline' ? 'Queue-aware AI baseline selected (rules-based, not trained).' : 'External model selected.' };
    }

    function recordControllerChange() {
      if (!currentEpisode) return;
      const last = currentEpisode.controllerHistory[currentEpisode.controllerHistory.length - 1];
      if (!last || last.controller !== runController) {
        currentEpisode.controllerHistory.push({
          time: number(lastSnapshot && lastSnapshot.time, 0),
          controller: runController
        });
      }
      const unique = new Set(currentEpisode.controllerHistory.map((entry) => entry.controller));
      currentEpisode.controller = unique.size > 1 ? 'mixed' : (unique.values().next().value || runController);
    }

    function setRunController(label) {
      runController = String(label || 'unknown');
      recordControllerChange();
      return runController;
    }

    function registerExternalModel(predictor) {
      if (predictor !== null && typeof predictor !== 'function') return { ok: false, message: 'Model adapter must be a synchronous function or null.' };
      externalModel = predictor;
      if (predictor) {
        policy = 'external';
        runController = 'external_model';
        if (currentEpisode && currentEpisode.transitions.length === 0) currentEpisode.controller = runController;
        recordControllerChange();
        return { ok: true, message: 'External model registered. It receives an observation and returns { holdSeconds }.' };
      }
      if (policy === 'external') {
        policy = 'baseline';
        runController = 'queue_aware_baseline';
        recordControllerChange();
      }
      return { ok: true, message: 'External model cleared.' };
    }

    function exportDataset() {
      const snapshot = engine.getSnapshot();
      if (currentEpisode) currentEpisode.summary = summarize(snapshot);
      const exportedEpisodes = episodes.map((episode) => {
        const result = clone(episode);
        result.pendingActions = episode === currentEpisode
          ? Array.from(pending.values(), (item) => ({
            id: item.id,
            observation: clone(item.observation),
            action: clone(item.action),
            started: item.started,
            startedAt: item.startState ? item.startState.time : null,
            transitionStatus: 'in_progress',
            reward: null
          }))
          : [];
        return result;
      });
      return {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        environment: {
          name: 'Signal Studio synthetic traffic simulation',
          rewardWeights: REWARD_WEIGHTS,
          rewardDefinition: 'reward = -0.01 × newly accumulated vehicle waiting seconds - 0.05 × queued vehicle-seconds + 2 × completed journeys during the green interval',
          actionDefinition: 'A proposed green duration in seconds for the stated node and approach. The simulator clamps it to the supplied minGreen/maxGreen legal bounds and applies its phase and red-wait rules.',
          observationDefinition: 'The simulator getObservation() output at decision time; nextObservation is sampled when the chosen approach completes its green interval.',
          queueExposure: 'Queued vehicle-seconds are network-wide and trapezoid-integrated from app snapshots while the selected approach is green; polling cadence is the map refresh cadence. Transitions for concurrently active junctions can overlap.',
          waitingMetric: 'The reward uses active visible-run vehicle runWaitTime plus the simulator completedWaitSeconds metric; older engines fall back to completed-trip count × avgWaitOverall. It never uses the display rolling avgWait.',
          queueMetric: 'The next-state phaseQueue uses per-street queue totals; the simulator does not expose direction-specific queue counts.'
        },
        currentEpisodeId: currentEpisode ? currentEpisode.id : null,
        episodes: exportedEpisodes
      };
    }

    function install() {
      if (engine && typeof engine.setController === 'function') engine.setController(issue);
      return api;
    }

    const api = {
      install,
      beginEpisode,
      endEpisode,
      observeSnapshot,
      setPolicy,
      setRunController,
      registerExternalModel,
      getPolicy: () => policy,
      hasExternalModel: () => Boolean(externalModel),
      getSummary: () => summarize(),
      exportDataset,
      baseline: queueAwareBaseline,
      rewardWeights: REWARD_WEIGHTS,
      schemaVersion: SCHEMA_VERSION
    };
    install();
    if (engine && typeof engine.getSnapshot === 'function') beginEpisode(config.seed, engine.getSnapshot());
    return api;
  }

  root.TrafficMLControl = { create, queueAwareBaseline, schemaVersion: SCHEMA_VERSION };
})(typeof window !== 'undefined' ? window : globalThis);
