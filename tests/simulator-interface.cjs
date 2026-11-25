const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
globalThis.window = globalThis;
for (const file of ['map-data', 'signal-layout', 'simulation', 'simulator-interface']) require(`../js/${file}.js`);
const data = MAP_PREVIEW_DATA;
const settings = { realisticTraffic: true, autoPedestrians: true, autoBuses: true,
  schoolTraffic: true, autoCranes: true, autoBreakdowns: true };

// Controlled sensor fixture: the same street has unequal queues in opposite directions.
const fixture = TrafficSim.create(data, { realisticTraffic: true, seed: 42 });
const sensors = TrafficSimulatorInterface.create(fixture, data);
const frame = fixture.getSnapshot();
const groups = fixture.getSignalControlState();
const forward = groups.find(group => group.nodeId === 'k2').approaches.find(a => a.streetId === 'S18' && !a.reverse);
const reverse = groups.find(group => group.nodeId === 'l2').approaches.find(a => a.streetId === 'S18' && a.reverse);
function vehicle(id, backward, progress, waiting = true, type = 'car', reason = 'signal') {
  return { id, streetId: 'S18', reverse: backward, progress, waiting, type,
    waitingReason: waiting ? reason : null, currentStopSeconds: waiting ? 4 : 0, motionSpeed: waiting ? 0 : 5 };
}
frame.vehicles = [
  ...Array.from({ length: 5 }, (_, i) => vehicle(`f${i}`, false, forward.stopProgress - .01 - i * .015, i < 3)),
  ...Array.from({ length: 3 }, (_, i) => vehicle(`r${i}`, true, reverse.stopProgress - .01 - i * .015)),
  vehicle('outside-incoming-zone', false, 0),
  vehicle('loading-bus', false, forward.stopProgress - .05, true, 'bus', 'bus-stop')
];
function approach(observation, nodeId, backward) {
  return observation.junctions.find(j => j.nodeId === nodeId).incoming.find(a => a.streetId === 'S18' && a.reverse === backward);
}
const detected = sensors.observe(frame);
assert.equal(approach(detected, 'k2', false).detectedVehicles, 6);
assert.equal(approach(detected, 'k2', false).queuedVehicles, 3, 'Planned bus dwell is not a traffic queue.');
assert.equal(approach(detected, 'k2', false).approachingVehicles, 2);
assert.equal(approach(detected, 'k2', false).meanCurrentWaitSeconds, 4);
assert.equal(approach(detected, 'k2', false).busDwelling, true);
assert.equal(approach(detected, 'l2', true).queuedVehicles, 3);
const narrow = TrafficSimulatorInterface.create(fixture, data, { approachDistance: 10 });
assert.ok(approach(narrow.observe(frame), 'k2', false).detectedVehicles < 6);
const observedText = JSON.stringify(detected);
for (const privateField of ['boundaryDemand', 'destination', 'offeredAt', 'metrics', 'reward']) {
  assert.ok(!observedText.includes(`"${privateField}"`), `Sensor observations leaked ${privateField}.`);
}
assert.equal(sensors.observe(frame).detectedVehicleCount,
  new Set(frame.vehicles.filter(v => v.id !== 'outside-incoming-zone').map(v => v.id)).size + 1,
  'A vehicle seen by multiple detector zones must be counted once in the detected network total.');
assert.throws(() => TrafficSimulatorInterface.create(fixture, data, { approachDistance: 0 }), /approachDistance/);
assert.throws(() => sensors.advance(3601), /advance/);
fixture.setRunning(false);
assert.throws(() => sensors.advance(1), /Resume/);
fixture.setRunning(true);
assert.equal(sensors.advance(.1).observation.time, 0);
assert.equal(sensors.advance(.15).observation.time, .25); // Use the exact physics clock, not the rounded UI clock.

// Pedestrian ages track the oldest waiting request, including merged later requests.
const pedestrians = TrafficSim.create(data, { realisticTraffic: true, seed: 7, maxRedSeconds: 60 });
const crossing = pedestrians.getSnapshot().crossings[0].id;
pedestrians.requestCrossing(crossing, 1);
pedestrians.step(1);
assert.equal(pedestrians.getSnapshot().crossings.find(c => c.id === crossing).oldestWaitSeconds, 1);
pedestrians.requestCrossing(crossing, 2);
pedestrians.step(.5);
assert.equal(pedestrians.getSnapshot().crossings.find(c => c.id === crossing).oldestWaitSeconds, 1.5);
assert.ok(pedestrians.reset(7).crossings.every(c => c.oldestWaitSeconds === 0));

function run(seed, maxRedSeconds, pattern) {
  const engine = TrafficSim.create(data, { ...settings, seed, maxRedSeconds });
  const api = TrafficSimulatorInterface.create(engine, data);
  const ids = api.metadata().actionNodeIds;
  assert.equal(api.applyActions(ids.map(() => 0)).ok, false);
  engine.setMode('network'); engine.setSpeed(8); engine.setDemand(3);
  let choices = ids.map((_, i) => pattern === 'short' ? 0 : pattern === 'long' ? 2 : i % 3);
  assert.ok(api.applyActions(choices).ok);
  const beforeInvalid = engine.getSignalControlState().map(g => g.pendingChoice);
  assert.equal(api.applyActions([...choices, 0]).ok, false);
  assert.equal(api.applyActions(new Array(ids.length)).ok, false);
  assert.equal(api.applyActions(choices.map((c, i) => i === 0 ? 3 : c)).ok, false);
  assert.deepEqual(engine.getSignalControlState().map(g => g.pendingChoice), beforeInvalid);
  const redSince = new Map();
  const walked = new Set();
  const appliedNodes = new Set();
  const completedTrips = new Map();
  const trace = crypto.createHash('sha256');
  let widest = 0;
  for (let tick = 0; tick < 4800; tick++) {
    if (pattern === 'fluctuations' && tick % 1200 === 0) {
      const stage = tick / 1200;
      engine.setDemand([.5, 3, 3, 1][stage]);
      assert.ok(engine.setRoad('S18', { breakdown: stage === 1 }).ok);
      assert.ok(engine.setRoad('S24', { closed: stage === 1 }).ok);
      assert.ok(engine.setRoadWeather('S18', stage === 2 ? 'wet' : 'clear').ok);
      assert.ok(engine.setRoadWeather('S19', stage === 2 ? 'snow' : 'clear').ok);
      const report = api.observe();
      const detectors = report.junctions.flatMap(j => [...j.incoming, ...j.outgoing]);
      assert.ok(detectors.filter(d => d.streetId === 'S24').every(d => d.closed === (stage === 1)));
      assert.ok(detectors.filter(d => d.streetId === 'S18').every(d => d.surface === (stage === 2 ? 'wet' : 'clear')));
    }
    if (['mixed', 'fluctuations'].includes(pattern) && tick % 80 === 0) {
      choices = ids.map((_, i) => (i + tick / 80) % 3);
      const old = engine.getSignalControlState().map(g => [g.stage, g.remainingSeconds, g.greenDurationSeconds]);
      assert.ok(api.applyActions(choices).ok);
      assert.deepEqual(engine.getSignalControlState().map(g => [g.stage, g.remainingSeconds, g.greenDurationSeconds]), old,
        'Changing a requested action must not abruptly change an active phase.');
    }
    engine.step(8 / 32);
    const snapshot = engine.getSnapshot();
    const now = (tick + 1) / 4;
    for (const signal of snapshot.signals) {
      assert.ok(signal.remaining <= maxRedSeconds + .1);
      if (signal.color !== 'red') redSince.delete(signal.id);
      else {
        if (!redSince.has(signal.id)) redSince.set(signal.id, now);
        assert.ok(now - redSince.get(signal.id) <= maxRedSeconds + .25);
      }
    }
    for (const c of snapshot.crossings.filter(c => c.state === 'walk')) {
      walked.add(c.id);
      assert.equal(c.duration, 7);
      assert.ok(snapshot.signals.filter(s => s.nodeId === c.nodeId).every(s => s.color === 'red'));
    }
    if (tick % 20) continue;
    const reading = api.read();
    reading.measurements.completedJourneys.forEach(trip => completedTrips.set(trip.id, trip));
    assert.equal(reading.observation.junctions.length, ids.length);
    assert.deepEqual(api.read(), reading, 'Reading measurements must not modify the simulation.');
    for (const j of reading.observation.junctions) {
      const control = j.signalControl;
      widest = Math.max(widest, control.nextGreenSeconds[2] - control.nextGreenSeconds[0]);
      if (control.lastAppliedAction) {
        appliedNodes.add(j.nodeId);
        assert.ok(control.lastAppliedAction.startedAt <= now);
        assert.ok(control.lastAppliedAction.scheduledSeconds >= 0);
        assert.ok(control.lastAppliedAction.scheduledSeconds <= maxRedSeconds);
        if (['short', 'long'].includes(pattern)) assert.equal(control.lastAppliedAction.choice, choices[ids.indexOf(j.nodeId)]);
      }
      for (const d of [...j.incoming, ...j.outgoing]) {
        assert.ok(d.queuedVehicles <= d.detectedVehicles);
        assert.ok(d.occupancy >= 0 && d.occupancy <= 1);
        assert.ok(d.oldestCurrentWaitSeconds + 1e-9 >= d.meanCurrentWaitSeconds);
        assert.ok(d.meanSpeed >= 0 && Number.isFinite(d.meanSpeed));
      }
    }
    assert.ok(Number.isFinite(reading.measurements.metrics.completedTravelSeconds));
    assert.ok(reading.measurements.metrics.unfinishedTravelSeconds >= 0);
    trace.update(JSON.stringify([snapshot.signals, snapshot.metrics.queued, snapshot.metrics.completed]));
  }
  assert.equal(appliedNodes.size, ids.length, 'Every controlled junction must execute supplied choices.');
  assert.ok(walked.size >= 8);
  const metrics = engine.getSnapshot().metrics;
  engine.getSnapshot().completed.forEach(trip => completedTrips.set(trip.id, trip));
  assert.ok(metrics.completed > 100);
  assert.equal(completedTrips.size, metrics.completed);
  const collectedDuration = [...completedTrips.values()].reduce((sum, trip) => sum + trip.duration, 0);
  assert.ok(Math.abs(collectedDuration - metrics.completedTravelSeconds) <= .051 * metrics.completed,
    'Cumulative journey time must include trips older than the latest-100 completion buffer.');
  assert.ok(metrics.completedTravelSeconds > 0);
  assert.ok(Math.abs(metrics.avgCompletedTravelSeconds - metrics.completedTravelSeconds / metrics.completed) < .11);
  assert.equal(engine.reset(seed).maxRedSeconds, maxRedSeconds);
  assert.ok(engine.getSignalControlState().every(g => g.pendingChoice === 1 && g.lastAppliedAction === null));
  return { seed, maxRedSeconds, pattern, widestGreenRange: widest, completed: metrics.completed,
    crossingsServed: walked.size, trace: trace.digest('hex') };
}
const results = [];
for (const seed of [7, 42, 109]) for (const cap of [30, 60]) {
  const runs = ['short', 'long', 'mixed'].map(pattern => run(seed, cap, pattern));
  assert.notEqual(runs[0].trace, runs[1].trace, 'Short and long choices must produce different trajectories.');
  results.push(...runs);
}
for (const seed of [7, 42, 109]) results.push(run(seed, 60, 'fluctuations'));

// The transport accepts commands and returns raw measurements without any learning/reward API.
const requests = [
  '{invalid json',
  { command: 'init', settings: { seed: 109, maxRedSeconds: 60, demand: 2 } },
  { command: 'observe' }, { command: 'actions', choices: [0] },
  { command: 'actions', choices: sensors.metadata().actionNodeIds.map((_, i) => i % 3) },
  { command: 'advance', seconds: 20 }, { command: 'reset' },
  { command: 'surface', streetId: 'S18', value: 'snow' },
  { command: 'road', streetId: 'S24', changes: { closed: true } },
  { command: 'demand', value: .5 },
  { command: 'profile', value: 'daily', startTime: '15:00' },
  { command: 'mode', value: 'fixed' }, { command: 'advance', seconds: -1 },
  { command: 'reset' }, { command: 'close' }
];
const processResult = spawnSync(process.execPath, [require.resolve('../scripts/simulator-bridge.cjs')], {
  input: requests.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n',
  encoding: 'utf8', maxBuffer: 10e6
});
assert.equal(processResult.status, 0, processResult.stderr);
const responses = processResult.stdout.trim().split('\n').map(line => JSON.parse(line));
assert.equal(responses.length, requests.length);
assert.equal(responses[0].ok, false);
assert.equal(responses[3].ok, false);
assert.ok(responses[4].ok);
assert.equal(responses[5].observation.time, 20);
assert.equal(fingerprint(responses[6].observation), fingerprint(responses[1].observation), 'Reset must restore the initial observation.');
assert.equal(fingerprint(responses[6].measurements), fingerprint(responses[1].measurements), 'Reset must restore the initial measurements.');
assert.ok(responses.slice(7, 12).every(r => r.ok));
assert.equal(responses[11].observation.mode, 'fixed');
assert.equal(responses[12].ok, false);
assert.equal(fingerprint(responses[13].observation), fingerprint(responses[1].observation),
  'Changing demand, roads and time-of-day must not alter the original reset setup.');
for (const response of responses) for (const field of ['reward', 'terminated', 'truncated', 'done']) {
  assert.equal(field in response, false, `${field} belongs to the user's Python environment.`);
}
console.log(JSON.stringify({ runs: results.length, simulatedMinutesPerRun: 20, speed: 8, results }, null, 2));
