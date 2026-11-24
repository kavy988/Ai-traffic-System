const assert = require('node:assert/strict');

globalThis.window = globalThis;
require('../js/map-data.js');
require('../js/signal-layout.js');
require('../js/simulation.js');

const data = globalThis.MAP_PREVIEW_DATA;
const create = (seed, enabled) => globalThis.TrafficSim.create(data, {
  seed, autoCranes: enabled, autoPedestrians: true, autoBreakdowns: true
});

function advance(engine, seconds) {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1) engine.step(1);
}

function dispatches(seed) {
  const engine = create(seed, true);
  const seen = new Map();
  const completed = new Set();
  let maxActive = 0;
  for (let second = 0; second < 900; second += 1) {
    engine.step(1);
    const snapshot = engine.getSnapshot();
    const cranes = snapshot.vehicles.filter((vehicle) => vehicle.dispatchSource === 'automatic');
    maxActive = Math.max(maxActive, cranes.length);
    for (const crane of cranes) {
      if (!seen.has(crane.id)) {
        const index = crane.route.findIndex((leg) => leg.streetId === crane.roadwork.streetId && leg.reverse === crane.roadwork.reverse);
        assert.ok(index >= 0 && index <= 1, 'Work is assigned within the first two streets');
        seen.set(crane.id, { time: snapshot.time, origin: crane.streetId, site: crane.roadwork.streetId });
      }
      if (crane.roadwork.state === 'working') assert.ok(crane.roadwork.elapsed <= 30);
    }
    for (const crane of snapshot.completed.filter((vehicle) => vehicle.dispatchSource === 'automatic')) {
      const last = crane.route.at(-1);
      const road = data.streets.find((street) => street.id === last.streetId);
      const node = data.nodes.find((item) => item.id === (last.reverse ? road.from : road.to));
      assert.ok(node.x < 0 || node.y < 0 || node.x > data.width || node.y > data.height, 'Crane reaches a network exit');
      completed.add(crane.id);
    }
  }
  const result = [...seen.values()];
  assert.ok(result.length >= 3, 'Several automatic cranes should be dispatched');
  assert.ok(result[0].time >= 45 && result[0].time <= 75, 'First dispatch falls within the startup interval');
  assert.ok(maxActive <= 2, 'Automatic crane limit');
  assert.ok(completed.size > 0, 'At least one automatic crane exits');
  return result;
}

const firstRun = dispatches(42);
assert.deepEqual(dispatches(42), firstRun, 'Seeded crane dispatches should repeat');
assert.notDeepEqual(dispatches(7), firstRun, 'Another seed should vary crane dispatches');

const paused = create(42, true);
paused.setRunning(false);
advance(paused, 80);
assert.equal(paused.getSnapshot().time, 0);
assert.ok(!paused.getSnapshot().vehicles.some((vehicle) => vehicle.type === 'crane'));
paused.setRunning(true);
advance(paused, 80);
assert.ok(paused.getSnapshot().vehicles.some((vehicle) => vehicle.dispatchSource === 'automatic'));
paused.reset(42);
assert.ok(!paused.getSnapshot().vehicles.some((vehicle) => vehicle.type === 'crane'));
advance(paused, 80);
assert.ok(paused.getSnapshot().vehicles.some((vehicle) => vehicle.dispatchSource === 'automatic'));

const manualOnly = create(42, false);
advance(manualOnly, 200);
assert.ok(!manualOnly.getSnapshot().vehicles.some((vehicle) => vehicle.type === 'crane'));
console.log(`Automatic crane dispatch passed with ${firstRun.length} seeded cranes over 15 simulated minutes.`);
