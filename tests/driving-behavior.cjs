const assert = require('node:assert/strict');

globalThis.window = globalThis;
require('../js/map-data.js');
require('../js/signal-layout.js');
require('../js/simulation.js');

function roadFixture({ turn = false, signals = false } = {}) {
  return {
    width: 1000,
    height: 600,
    nodes: [
      { id: 'west', x: -60, y: 300 },
      { id: 'junction', x: 500, y: 300 },
      { id: 'exit', x: turn ? 500 : 1060, y: turn ? 660 : 300 },
      ...(signals ? [{ id: 'north', x: 500, y: -60 }] : [])
    ],
    streets: [
      { id: 'A', from: 'west', to: 'junction', oneWay: true, major: true },
      { id: 'B', from: 'junction', to: 'exit', oneWay: true, major: true },
      ...(signals ? [{ id: 'C', from: 'north', to: 'junction', oneWay: true, major: true }] : [])
    ],
    signals: signals ? [
      { streetId: 'A', color: 'red', seconds: 16 },
      { streetId: 'C', color: 'green', seconds: 16 }
    ] : []
  };
}

function emptyEngine(data) {
  const engine = TrafficSim.create(data, { seed: 42, realisticTraffic: true });
  engine.setDemand(0);
  for (let seconds = 0; seconds < 1800; seconds += 5) engine.step(5);
  assert.equal(engine.getSnapshot().vehicles.length, 0, 'Traffic must drain after arrivals stop.');
  return engine;
}

function junctionExitSpeed(turn) {
  const engine = emptyEngine(roadFixture({ turn }));
  assert.ok(engine.addTraffic('A', 1, 'car').ok);
  for (let tick = 0; tick < 1500; tick++) {
    const before = engine.getMotionSnapshot().vehicles[0];
    engine.step(0.25);
    const after = engine.getMotionSnapshot().vehicles[0];
    if (before?.streetId === 'A' && after?.streetId === 'B') return after.motionSpeed;
  }
  assert.fail('The driver never crossed the junction.');
}

const straightSpeed = junctionExitSpeed(false);
const turnSpeed = junctionExitSpeed(true);
assert.ok(straightSpeed > 10, 'An open street boundary must preserve through speed.');
assert.ok(turnSpeed > 0 && turnSpeed <= 5.01, 'A right-angle turn must be taken at a lower speed.');

const surfaceSpeeds = ['clear', 'wet', 'snow'].map(surface => {
  const engine = emptyEngine(roadFixture());
  assert.ok(engine.setRoadWeather('A', surface).ok);
  assert.ok(engine.addTraffic('A', 1, 'car').ok);
  engine.step(0.25);
  return engine.getMotionSnapshot().vehicles[0].motionSpeed;
});
assert.ok(surfaceSpeeds[0] > surfaceSpeeds[1] && surfaceSpeeds[1] > surfaceSpeeds[2],
  'Poor surfaces must reduce acceleration as well as cruising speed.');

const queue = emptyEngine(roadFixture({ signals: true }));
queue.setMode('fixed');
assert.ok(queue.addTraffic('A', 6, 'car').ok);
let cohort;
for (let tick = 0; tick < 2400; tick++) {
  queue.step(0.25);
  const cars = queue.getSnapshot().vehicles.filter(vehicle => vehicle.streetId === 'A');
  if (cars.length >= 3 && cars.every(vehicle => vehicle.waiting && vehicle.currentStopSeconds >= 1)) {
    cohort = cars.sort((a, b) => b.progress - a.progress).slice(0, 3);
    break;
  }
}
assert.ok(cohort, 'The fixture must form a stopped queue.');
const restartTimes = new Map();
for (let tick = 0; tick < 240; tick++) {
  queue.step(0.25);
  const motion = queue.getMotionSnapshot();
  for (const car of motion.vehicles) {
    if (cohort.some(vehicle => vehicle.id === car.id) && car.motionSpeed > 0.05 && !restartTimes.has(car.id)) {
      restartTimes.set(car.id, motion.time);
    }
  }
  if (restartTimes.size === cohort.length) break;
}
const departures = cohort.map(car => restartTimes.get(car.id));
assert.ok(departures.every(Number.isFinite), 'Every queued driver must move again.');
assert.ok(departures[1] - departures[0] >= 0.5 && departures[2] - departures[1] >= 0.5,
  'A queue must pull away progressively after the signal changes.');

const nodes = new Map(MAP_PREVIEW_DATA.nodes.map(node => [node.id, node]));
const lengths = new Map(MAP_PREVIEW_DATA.streets.map(road => {
  const from = nodes.get(road.from), to = nodes.get(road.to);
  return [road.id, Math.max(40, Math.hypot(to.x - from.x, to.y - from.y))];
}));
const definitions = new Map(MAP_PREVIEW_DATA.pedestrianCrossings.map(crossing => [crossing.id, crossing]));
const halfLengths = { car: 9, bike: 6, crane: 13 };
for (const demand of [1, 3]) {
  const engine = TrafficSim.create(MAP_PREVIEW_DATA, {
    seed: 42, realisticTraffic: true, autoPedestrians: true, autoBreakdowns: true, autoCranes: true
  });
  engine.setDemand(demand);
  engine.setSpeed(8);
  let walkChecks = 0;
  for (let tick = 0; tick < 4800; tick++) {
    engine.step(0.25);
    const motion = engine.getMotionSnapshot();
    for (const crossing of motion.crossings.filter(item => item.state === 'walk')) {
      walkChecks++;
      const definition = definitions.get(crossing.id);
      for (const vehicle of motion.vehicles.filter(item => item.streetId === crossing.streetId)) {
        const center = vehicle.reverse === definition.reverse ? definition.progress : 1 - definition.progress;
        const halfSpan = definition.halfSpan + halfLengths[vehicle.type] / lengths.get(vehicle.streetId);
        assert.ok(Math.abs(vehicle.progress - center) >= halfSpan - 1e-6,
          'A vehicle must not occupy an active pedestrian crossing.');
      }
    }
    if (tick % 20 !== 19) continue;
    const snapshot = engine.getSnapshot();
    const { metrics } = snapshot;
    assert.ok(snapshot.signals.every(signal => signal.remaining <= 30));
    assert.equal(metrics.active, metrics.totalArrived - metrics.completed);
    assert.equal(metrics.queued, snapshot.vehicles.filter(vehicle => vehicle.waiting).length);
    for (const crossing of motion.crossings.filter(item => item.state === 'walk')) {
      assert.ok(snapshot.signals.filter(signal => signal.nodeId === crossing.nodeId)
        .every(signal => signal.color === 'red'));
    }
  }
  assert.ok(walkChecks > 0);
  assert.ok(engine.getSnapshot().metrics.completed > 100);
}

console.log('Through speed, slower turns, road grip, queue departure waves, and 20-minute crossing/accounting checks passed.');
