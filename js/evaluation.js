(function (root) {
  'use strict';

  const DEFAULT_SEEDS = Object.freeze([42, 137, 271]);
  const DEFAULT_DURATION_SECONDS = 300;
  const SAMPLE_INTERVAL_SECONDS = 5;
  const BATCH_MILLISECONDS = 12;
  const CONTROLLERS = Object.freeze([
    Object.freeze({ id: 'fixed', label: 'Fixed timing' }),
    Object.freeze({ id: 'adaptive', label: 'Adaptive rules' }),
    Object.freeze({ id: 'queue-baseline', label: 'Queue-aware rules' }),
    Object.freeze({ id: 'external', label: 'External ML' })
  ]);

  function scenarioFromSnapshot(snapshot, { id = 'current', label = 'Current settings' } = {}) {
    return {
      id,
      label,
      demand: snapshot.demand,
      demandProfileMode: snapshot.demandProfileMode,
      demandProfileStartTime: snapshot.demandProfileStartTime,
      roads: snapshot.roads.filter((road) => road.manualClosed || road.manualBreakdown || road.bikeOnly || road.surfaceWeather !== 'clear')
        .map((road) => ({
          id: road.id,
          closed: road.manualClosed === true,
          breakdown: road.manualBreakdown === true,
          bikeOnly: road.bikeOnly === true,
          surfaceWeather: road.surfaceWeather || 'clear'
        }))
    };
  }

  function prepareScenarios(data, scenarios) {
    if (!Array.isArray(scenarios) || !scenarios.length || scenarios.length > 8) {
      throw new Error('Choose between 1 and 8 scenarios.');
    }
    const streetIds = new Set(data.streets.map((road) => road.id));
    const scenarioIds = new Set();
    return scenarios.map((scenario) => {
      const { id, label = id, demand = 1, demandProfileMode = 'steady', demandProfileStartTime = '07:00', roads = [] } = scenario || {};
      if (typeof id !== 'string' || !id || scenarioIds.has(id)) throw new Error('Every scenario needs a unique ID.');
      if (!Number.isFinite(demand) || demand < 0 || demand > 3) throw new Error(`Invalid demand in ${label}.`);
      if (!['steady', 'daily'].includes(demandProfileMode)) throw new Error(`Invalid demand profile in ${label}.`);
      if (!Array.isArray(roads)) throw new Error(`Invalid road settings in ${label}.`);
      scenarioIds.add(id);
      const configuredStreets = new Set();
      const roadSettings = roads.map((road) => {
        if (!streetIds.has(road?.id) || configuredStreets.has(road.id)) throw new Error(`Invalid or duplicate road in ${label}.`);
        const { id: streetId, surfaceWeather = 'clear' } = road;
        if (!['clear', 'wet', 'snow'].includes(surfaceWeather)) throw new Error(`Invalid surface on ${streetId} in ${label}.`);
        configuredStreets.add(streetId);
        return { id: streetId, closed: road.closed === true, breakdown: road.breakdown === true, bikeOnly: road.bikeOnly === true, surfaceWeather };
      });
      return { id, label, demand, demandProfileMode, demandProfileStartTime, roads: roadSettings };
    });
  }

  function checked(result) {
    if (!result.ok) throw new Error(result.message);
  }

  function applyScenario(engine, scenario) {
    checked(engine.setDemand(scenario.demand));
    checked(engine.setDemandProfile(scenario.demandProfileMode, scenario.demandProfileStartTime));
    for (const { id, surfaceWeather, ...settings } of scenario.roads) {
      checked(engine.setRoad(id, settings));
      checked(engine.setRoadWeather(id, surfaceWeather));
    }
  }

  function checkCancellation(signal) {
    if (signal?.aborted) throw new DOMException('Comparison canceled.', 'AbortError');
  }

  function yieldToBrowser() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function errorMessage(error) {
    return String(error?.message || error || 'Unknown error.').slice(0, 240);
  }

  function selectController(engine, id, externalModel) {
    if (id === 'fixed' || id === 'adaptive') {
      checked(engine.setMode(id));
      return () => null;
    }
    let modelError = null;
    let modelDecisions = 0;
    const predict = (observation) => {
      const { maxGreen } = observation.decision;
      if (modelError) return { holdSeconds: maxGreen };
      try {
        const answer = externalModel(observation);
        if (answer && typeof answer.then === 'function') {
          Promise.resolve(answer).catch(() => {});
          throw new Error('The model must return a synchronous prediction.');
        }
        if (!Number.isFinite(answer?.holdSeconds)) throw new Error('The model must return a finite numeric holdSeconds.');
        modelDecisions += 1;
        return { holdSeconds: answer.holdSeconds };
      } catch (error) {
        modelError = errorMessage(error);
        return { holdSeconds: maxGreen };
      }
    };
    checked(engine.setController(id === 'queue-baseline' ? root.TrafficMLControl.queueAwareBaseline : predict));
    checked(engine.setMode('custom'));
    return (finished) => modelError || (finished && id === 'external' && modelDecisions === 0 ? 'The model received no signal decisions.' : null);
  }

  function pedestrianTotals(crossings) {
    return crossings.reduce((totals, crossing) => {
      totals.waiting += crossing.waiting;
      totals.crossing += crossing.crossing;
      totals.completed += crossing.completedPedestrians;
      return totals;
    }, { waiting: 0, crossing: 0, completed: 0 });
  }

  async function episode(data, scenario, seed, controllerId, options, progress) {
    const { durationSeconds, externalModel, signal } = options;
    await yieldToBrowser();
    checkCancellation(signal);
    const engine = root.TrafficSim.create(data, {
      seed,
      realisticTraffic: true,
      autoPedestrians: true,
      autoBreakdowns: true,
      autoCranes: true,
      autoBuses: true,
      schoolTraffic: true
    });
    applyScenario(engine, scenario);
    const modelFailure = selectController(engine, controllerId, externalModel);
    let snapshot = engine.getSnapshot();
    const initialVehicles = snapshot.metrics.active;
    let pedestrian = pedestrianTotals(snapshot.crossings);
    let queuedVehicleSeconds = 0;
    let queuedPedestrianSeconds = 0;
    let spillbackVehicleSeconds = 0;
    let activeLimitSeconds = 0;
    let elapsed = 0;
    let batchStartedAt = performance.now();

    while (elapsed < durationSeconds) {
      checkCancellation(signal);
      const error = modelFailure(false);
      if (error) return { status: 'failed', error, simulatedSeconds: elapsed };
      const step = Math.min(SAMPLE_INTERVAL_SECONDS, durationSeconds - elapsed);
      engine.step(step);
      const current = engine.getSnapshot();
      const currentPedestrian = pedestrianTotals(current.crossings);
      queuedVehicleSeconds += (snapshot.metrics.queued + current.metrics.queued) * step / 2;
      queuedPedestrianSeconds += (pedestrian.waiting + currentPedestrian.waiting) * step / 2;
      spillbackVehicleSeconds += ((snapshot.metrics.spillbackQueued ?? 0) + (current.metrics.spillbackQueued ?? 0)) * step / 2;
      activeLimitSeconds += (Number(Boolean(snapshot.metrics.atActiveLimit)) + Number(Boolean(current.metrics.atActiveLimit))) * step / 2;
      snapshot = current;
      pedestrian = currentPedestrian;
      elapsed += step;

      if (performance.now() - batchStartedAt >= BATCH_MILLISECONDS) {
        progress(elapsed);
        await yieldToBrowser();
        batchStartedAt = performance.now();
      }
    }

    checkCancellation(signal);
    const error = modelFailure(true);
    if (error) return { status: 'failed', error, simulatedSeconds: elapsed };
    const { metrics } = snapshot;
    const hasCrossings = snapshot.crossings.length > 0;
    return {
      status: 'complete',
      simulatedSeconds: elapsed,
      boundaryDemand: snapshot.boundaryDemand ?? null,
      metrics: {
        initialVehicles,
        arrivals: metrics.totalArrived - initialVehicles,
        completedTrips: metrics.completed,
        throughputPerMinute: metrics.completed * 60 / durationSeconds,
        activeVehicles: metrics.active,
        averageQueue: queuedVehicleSeconds / durationSeconds,
        endQueue: metrics.queued,
        completedTripWaitSeconds: metrics.completed ? metrics.completedWaitSeconds / metrics.completed : null,
        unfinishedWaitSeconds: metrics.unfinishedWaitSeconds,
        totalVehicleWaitSeconds: metrics.totalAccruedWaitSeconds,
        activeLimitSeconds,
        boundaryOffered: metrics.boundaryOffered ?? null,
        boundaryAdmitted: metrics.boundaryAdmitted ?? null,
        boundaryQueued: metrics.boundaryQueued ?? null,
        boundaryDropped: metrics.boundaryDropped ?? null,
        boundaryWaitSeconds: metrics.boundaryWaitSeconds ?? null,
        endSpillbackQueue: metrics.spillbackQueued ?? null,
        averageSpillbackQueue: Number.isFinite(metrics.spillbackQueued) ? spillbackVehicleSeconds / durationSeconds : null,
        pedestriansCompleted: hasCrossings ? pedestrian.completed : null,
        pedestriansWaiting: hasCrossings ? pedestrian.waiting : null,
        pedestriansCrossing: hasCrossings ? pedestrian.crossing : null,
        averagePedestrianQueue: hasCrossings ? queuedPedestrianSeconds / durationSeconds : null
      }
    };
  }

  function verifyMatchedDemand(scenarios, seeds, results) {
    return scenarios.flatMap(({ id: scenarioId }) => seeds.map((seed) => {
      const successful = results.filter((row) => row.scenarioId === scenarioId && row.seed === seed && row.status === 'complete');
      const streams = successful.map(({ boundaryDemand }) => {
        if (!Array.isArray(boundaryDemand) || !boundaryDemand.length || boundaryDemand.some(({ offered, signature }) =>
          !Number.isInteger(offered) || signature === null || signature === undefined)) return null;
        return JSON.stringify(boundaryDemand.map(({ nodeId, offered, signature }) => [nodeId, offered, signature]));
      });
      const status = streams.length < 2 || streams.includes(null) ? 'unavailable' :
        streams.every((stream) => stream === streams[0]) ? 'matched' : 'mismatch';
      return { scenarioId, seed, status, comparedControllers: successful.length };
    }));
  }

  function summarize(scenarios, controllers, seeds, results) {
    return scenarios.flatMap(({ id: scenarioId }) => controllers.map(({ id: controllerId }) => {
      const successful = results.filter((row) => row.scenarioId === scenarioId && row.controllerId === controllerId && row.status === 'complete');
      const metrics = {};
      if (successful.length === seeds.length) {
        for (const name of Object.keys(successful[0].metrics)) {
          const values = successful.map((row) => row.metrics[name]).filter(Number.isFinite);
          metrics[name] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        }
      }
      return { scenarioId, controllerId, successfulSeeds: successful.length, totalSeeds: seeds.length, metrics };
    }));
  }

  async function run(data, {
    scenarios = [{ id: 'default', label: 'Default settings' }],
    seeds = DEFAULT_SEEDS,
    durationSeconds = DEFAULT_DURATION_SECONDS,
    externalModel = null,
    onProgress,
    signal
  } = {}) {
    if (!Array.isArray(seeds) || !seeds.length || seeds.length > 12 || new Set(seeds).size !== seeds.length ||
        seeds.some((seed) => !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
      throw new Error('Choose between 1 and 12 distinct unsigned 32-bit seeds.');
    }
    if (!Number.isInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 1200) {
      throw new Error('Choose an episode duration from 30 to 1200 simulated seconds.');
    }
    if (externalModel !== null && typeof externalModel !== 'function') throw new Error('The model must be a synchronous function.');
    const chosenScenarios = prepareScenarios(data, scenarios);
    const chosenSeeds = [...seeds];
    const controllers = CONTROLLERS.filter(({ id }) => id !== 'external' || externalModel);
    const totalRuns = chosenScenarios.length * chosenSeeds.length * controllers.length;
    if (totalRuns > 96) throw new Error('Choose settings that require at most 96 runs.');
    const results = [];

    for (const scenario of chosenScenarios) {
      for (const seed of chosenSeeds) {
        for (const { id: controllerId } of controllers) {
          checkCancellation(signal);
          const identity = { scenarioId: scenario.id, seed, controllerId };
          const progress = (simulatedSeconds) => onProgress?.({
            ...identity, completedRuns: results.length, totalRuns, simulatedSeconds, durationSeconds
          });
          progress(0);
          const result = await episode(data, scenario, seed, controllerId, { durationSeconds, externalModel, signal }, progress);
          results.push({ ...identity, ...result });
          progress(result.simulatedSeconds);
        }
      }
    }

    checkCancellation(signal);
    const demandPairing = verifyMatchedDemand(chosenScenarios, chosenSeeds, results);
    if (demandPairing.some((pair) => pair.status === 'mismatch')) {
      throw new Error('Offered boundary demand differed across controllers for the same scenario and seed.');
    }
    return {
      schemaVersion: 'signal-studio-evaluation/v1',
      scenarios: chosenScenarios,
      seeds: chosenSeeds,
      durationSeconds,
      sampleIntervalSeconds: SAMPLE_INTERVAL_SECONDS,
      controllers,
      externalModelIncluded: Boolean(externalModel),
      demandPairing,
      methodology: {
        openingState: 'Each controller starts from a fresh, identically seeded warm-up under adaptive rules.',
        demand: demandPairing.every((pair) => pair.status === 'matched') ?
          'The offered vehicle requests match across completed runs by scenario and seed. Admission, congestion, and incident outcomes can vary by controller.' :
          'Some offered vehicle streams could not be verified. Admission, congestion, and incident outcomes can vary by controller.',
        scenario: 'Each run reapplies the configured demand and manual road settings. Automatic pedestrians, breakdowns, and crane dispatches are enabled. Live vehicles, queued manual requests, and temporary incidents are excluded.',
        waiting: 'Vehicle stop delay counts only time accrued during the episode. Completed-trip and unfinished wait split the same total.',
        boundaryWaiting: 'Boundary wait includes time before entry for admitted vehicles and time already spent waiting by vehicles still outside.',
        queues: 'Vehicle and pedestrian queue means are trapezoidal time averages of 5-second samples.',
        aggregation: 'Controller summaries require a successful episode for every seed. Each seed with a defined metric has equal weight.'
      },
      results,
      summaries: summarize(chosenScenarios, controllers, chosenSeeds, results)
    };
  }

  root.TrafficEvaluation = { run, scenarioFromSnapshot, defaultSeeds: DEFAULT_SEEDS, defaultDurationSeconds: DEFAULT_DURATION_SECONDS };
})(typeof window !== 'undefined' ? window : globalThis);
