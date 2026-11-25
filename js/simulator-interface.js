(function (root) {
  'use strict';

  // Measurements and commands only. No policy, reward, episodes, or training.
  function create(engine, data, configuration = {}) {
    const settings = { approachDistance: 100, exitDistance: 60, ...configuration };
    for (const key of ['approachDistance', 'exitDistance']) {
      if (!Number.isFinite(settings[key]) || settings[key] <= 0) {
        throw new RangeError(`${key} must be a positive finite simulation distance.`);
      }
    }
    const nodes = new Map(data.nodes.map(node => [node.id, node]));
    const roads = new Map(data.streets.map(road => [road.id, {
      ...road, length: Math.max(40, Math.hypot(nodes.get(road.to).x - nodes.get(road.from).x,
        nodes.get(road.to).y - nodes.get(road.from).y))
    }]));
    const nodeIds = engine.getSignalControlState().map(group => group.nodeId);
    const controlled = new Set(nodeIds);
    const outgoing = new Map(data.nodes.map(node => [node.id, []]));
    for (const road of roads.values()) {
      outgoing.get(road.from).push({ streetId: road.id, reverse: false, to: road.to });
      if (!road.oneWay) outgoing.get(road.to).push({ streetId: road.id, reverse: true, to: road.from });
    }
    outgoing.forEach(edges => edges.sort((a, b) => a.streetId.localeCompare(b.streetId)));

    // Follow actual road connections through unsignalised nodes; visual crossings
    // (including flyovers) are not junction connections.
    const neighbours = new Map(nodeIds.map(origin => {
      const visited = new Set([origin]);
      const found = new Set();
      const pending = [origin];
      while (pending.length) {
        for (const edge of outgoing.get(pending.shift())) {
          if (visited.has(edge.to)) continue;
          visited.add(edge.to);
          if (controlled.has(edge.to)) found.add(edge.to);
          else pending.push(edge.to);
        }
      }
      return [origin, [...found].sort()];
    }));
    const halfLengths = { car: 9, bike: 6, crane: 13, bus: 18 };
    const travel = vehicle => vehicle.progress; // getSnapshot() already uses travel-direction progress.
    const inQueue = vehicle => vehicle.waiting && !['bus-stop', 'school-stop'].includes(vehicle.waitingReason);
    const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

    function detect(vehicles, road, reverse, start, end) {
      const selected = vehicles.filter(vehicle => vehicle.streetId === road.id && vehicle.reverse === reverse &&
        travel(vehicle) * road.length >= start - 1e-6 && travel(vehicle) * road.length <= end + 1e-6);
      const queued = selected.filter(inQueue);
      const occupied = selected.reduce((sum, vehicle) => {
        const center = travel(vehicle) * road.length;
        const half = halfLengths[vehicle.type];
        return sum + Math.max(0, Math.min(end, center + half) - Math.max(start, center - half));
      }, 0);
      return { selected, values: {
        detectedVehicles: selected.length,
        queuedVehicles: queued.length,
        approachingVehicles: selected.filter(vehicle => !vehicle.waiting).length,
        meanSpeed: average(selected.map(vehicle => vehicle.motionSpeed)),
        meanCurrentWaitSeconds: average(queued.map(vehicle => vehicle.currentStopSeconds)),
        oldestCurrentWaitSeconds: Math.max(0, ...queued.map(vehicle => vehicle.currentStopSeconds)),
        occupancy: Math.min(1, occupied / Math.max(1e-6, end - start)),
        buses: selected.filter(vehicle => vehicle.type === 'bus').length,
        busDwelling: selected.some(vehicle => vehicle.waitingReason === 'bus-stop'),
        schoolLoading: selected.some(vehicle => vehicle.waitingReason === 'school-stop')
      } };
    }

    function observe(snapshot = engine.getSnapshot()) {
      const states = engine.getSignalControlState();
      const restrictions = new Map(snapshot.roads.map(road => [road.id, road]));
      const signals = new Map(snapshot.signals.map(signal => [signal.id, signal]));
      const detectedIds = new Set();
      const junctions = states.map(group => {
        const incoming = group.approaches.map(approach => {
          const road = roads.get(approach.streetId);
          const end = approach.stopProgress * road.length;
          const start = Math.max(0, end - settings.approachDistance);
          const detection = detect(snapshot.vehicles, road, approach.reverse, start, end);
          detection.selected.forEach(vehicle => detectedIds.add(vehicle.id));
          const phaseIndex = group.phases.findIndex(phase => phase.some(item =>
            item.streetId === approach.streetId && item.reverse === approach.reverse));
          const signal = signals.get(`${group.nodeId}:${road.id}:${Number(approach.reverse)}`);
          const status = restrictions.get(road.id);
          return {
            streetId: road.id, reverse: approach.reverse, phaseIndex,
            detectionStart: start / road.length, detectionEnd: end / road.length,
            ...detection.values,
            signal: signal.color, signalRemainingSeconds: signal.remaining,
            redElapsedSeconds: group.redElapsedSeconds[phaseIndex],
            closed: status.closed, bikeOnly: status.bikeOnly, surface: status.surfaceWeather,
            breakdown: status.breakdown && status.breakdownReverse === approach.reverse,
            roadwork: status.workClosed
          };
        });
        const exits = outgoing.get(group.nodeId).map(edge => {
          const road = roads.get(edge.streetId);
          const end = Math.min(settings.exitDistance, road.length);
          const detection = detect(snapshot.vehicles, road, edge.reverse, 0, end);
          detection.selected.forEach(vehicle => detectedIds.add(vehicle.id));
          const status = restrictions.get(road.id);
          const entrySpace = Math.min(end, ...detection.selected.map(vehicle =>
            Math.max(0, travel(vehicle) * road.length - halfLengths[vehicle.type])));
          return {
            streetId: road.id, reverse: edge.reverse, toNodeId: edge.to,
            detectionStart: 0, detectionEnd: end / road.length,
            ...detection.values, entrySpace,
            closed: status.closed, bikeOnly: status.bikeOnly, surface: status.surfaceWeather,
            breakdown: status.breakdown && status.breakdownReverse === edge.reverse
          };
        });
        return {
          nodeId: group.nodeId, neighbourNodeIds: neighbours.get(group.nodeId).slice(),
          signalControl: group, incoming, outgoing: exits,
          pedestrians: snapshot.crossings.filter(crossing => crossing.nodeId === group.nodeId).map(crossing => ({
            id: crossing.id, streetId: crossing.streetId, reverse: crossing.reverse,
            waiting: crossing.waiting, crossing: crossing.crossing, oldestWaitSeconds: crossing.oldestWaitSeconds,
            state: crossing.state, remainingSeconds: crossing.remaining
          }))
        };
      });
      return { schemaVersion: 'traffic-detectors/v1', time: engine.getMotionSnapshot().time,
        timeOfDaySeconds: snapshot.timeOfDaySeconds, mode: snapshot.mode,
        detectedVehicleCount: detectedIds.size, junctions };
    }

    function measurements(snapshot = engine.getSnapshot()) {
      return {
        // Evaluation ground truth is intentionally separate from the sensor observation.
        metrics: { ...snapshot.metrics },
        entryQueues: snapshot.boundaryDemand.map(item => ({ ...item })),
        completedJourneys: snapshot.completed.map(item => ({
          id: item.id, type: item.type, completedAt: item.completedAt,
          duration: item.duration, waitTime: item.waitTime, runWaitTime: item.runWaitTime
        })),
        pedestrianTotals: snapshot.crossings.map(item => ({
          id: item.id, waiting: item.waiting, completed: item.completedPedestrians,
          crossing: item.crossing, oldestWaitSeconds: item.oldestWaitSeconds
        }))
      };
    }

    function read() {
      const snapshot = engine.getSnapshot();
      return { observation: observe(snapshot), measurements: measurements(snapshot) };
    }

    function advance(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
        throw new RangeError('advance seconds must be between 0 and 3600.');
      }
      if (!engine.getSnapshot().running && seconds > 0) throw new Error('Resume the simulator before advancing time.');
      let left = seconds;
      while (left > 1e-9) {
        const amount = Math.min(left, 5); // The engine accepts at most five seconds per call.
        engine.step(amount);
        left -= amount;
      }
      return read();
    }

    return {
      observe, measurements, read, advance,
      applyActions: choices => engine.setNetworkActions(choices),
      metadata: () => ({
        schemaVersion: 'traffic-detectors/v1', actionNodeIds: nodeIds.slice(),
        choiceLabels: ['short', 'medium', 'long'], actionApplication: 'next_green',
        approachDistance: settings.approachDistance, exitDistance: settings.exitDistance,
        distanceUnits: 'simulation_units', maxRedSeconds: engine.getSnapshot().maxRedSeconds,
        simulationStepSeconds: .25
      })
    };
  }
  root.TrafficSimulatorInterface = { create };
})(typeof window !== 'undefined' ? window : globalThis);
