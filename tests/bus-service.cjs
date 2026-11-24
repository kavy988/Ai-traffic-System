const assert = require('node:assert/strict');
globalThis.window = globalThis;
require('../js/map-data.js');
require('../js/signal-layout.js');
require('../js/simulation.js');

const fixture = {
  width: 1000, height: 600,
  nodes: [{ id: 'west', x: -60, y: 300 }, { id: 'east', x: 1060, y: 300 }],
  streets: [
    { id: 'A', from: 'west', to: 'east', oneWay: true, major: true },
    { id: 'B', from: 'east', to: 'west', oneWay: true, major: true }
  ],
  busStops: [{ id: 'test-stop', name: 'Test stop', streetId: 'A', reverse: false, progress: .30 }]
};
const engine = TrafficSim.create(fixture, { seed: 42, realisticTraffic: true });
engine.setDemand(0);
for (let t = 0; t < 1800; t += 5) engine.step(5);
assert.equal(engine.getSnapshot().vehicles.length, 0);
assert.ok(engine.addTraffic('A', 1, 'bus').ok);
const busId = engine.getSnapshot().vehicles.find(v => v.type === 'bus').id;
while (engine.getSnapshot().vehicles.find(v => v.id === busId).progress < .20) engine.step(.25);
assert.ok(engine.addTraffic('A', 1, 'car').ok);
assert.ok(engine.addTraffic('B', 1, 'car').ok);
let boarding = null, queuedBehind = false, oppositeMoved = false, passengerSeconds = 0;
for (let t = 0; t < 240; t += .25) {
  const before = engine.getSnapshot();
  engine.step(.25);
  const snap = engine.getSnapshot(), bus = snap.vehicles.find(v => v.id === busId);
  assert.equal(snap.roads.reduce((sum, r) => sum + r.count, 0), snap.metrics.active);
  assert.equal(snap.roads.reduce((sum, r) => sum + r.queue, 0), snap.metrics.queued);
  if (bus?.bus.stage === 'boarding') {
    if (!boarding) boarding = { progress: bus.progress, wait: bus.waitTime, at: snap.time };
    assert.equal(bus.progress, boarding.progress, 'A boarding bus must stay at its stop.');
    assert.equal(bus.waitTime, boarding.wait, 'Passenger dwell must not be counted as signal/traffic delay.');
    assert.ok(bus.bus.remaining >= 0 && bus.bus.remaining <= 22);
    const behind = snap.vehicles.find(v => v.type === 'car' && v.streetId === 'A');
    if (behind?.waiting) { queuedBehind = true; assert.ok(behind.progress < bus.progress); }
    const opposite = snap.vehicles.find(v => v.type === 'car' && v.streetId === 'B');
    const previous = before.vehicles.find(v => v.id === opposite?.id);
    if (previous && opposite.progress > previous.progress) oppositeMoved = true;
    passengerSeconds = Math.max(passengerSeconds, bus.bus.passengerSeconds);
  }
  if (snap.completed.some(v => v.id === busId)) break;
}
assert.ok(boarding, 'The bus must call at its stop.');
assert.ok(queuedBehind, 'Cars must queue behind an in-lane bus stop.');
assert.ok(oppositeMoved, 'The opposite direction must continue moving.');
assert.ok(passengerSeconds >= 13.5 && passengerSeconds <= 22);
const completedBus = engine.getSnapshot().completed.find(v => v.id === busId);
assert.ok(completedBus, 'The bus must continue to its exit.');
assert.equal(completedBus.bus.stopsCompleted, 1);
assert.ok(engine.setRoad('A', { bikeOnly: true }).ok);
assert.equal(engine.addTraffic('A', 1, 'bus').ok, false);

const runs = [];
for (const seed of [42, 7, 109]) for (const demand of [1, 2, 3]) {
  const sim = TrafficSim.create(MAP_PREVIEW_DATA, { seed, realisticTraffic: true, autoBuses: true, autoCranes: true, autoBreakdowns: true, autoPedestrians: true });
  sim.setDemand(demand); sim.setSpeed(8);
  let queueSum = 0, activeSum = 0, maxActive = 0, boardingFrames = 0, maxStops = 0, completedBuses = new Set();
  for (let t = 0; t < 1200; t += 8 / 32) {
    sim.step(8 / 32);
    if (t % 2) continue;
    const snap = sim.getSnapshot();
    assert.ok(snap.metrics.active <= 200, 'All types must respect network capacity.');
    assert.equal(snap.roads.reduce((sum, r) => sum + r.count, 0), snap.metrics.active);
    assert.equal(snap.roads.reduce((sum, r) => sum + r.queue, 0), snap.metrics.queued);
    for (const v of snap.vehicles) {
      assert.ok(Number.isFinite(v.motionSpeed) && Number.isFinite(v.waitTime));
      if (v.bus?.stage === 'boarding') { boardingFrames++; assert.ok(v.bus.remaining <= 22); }
      maxStops = Math.max(maxStops, v.bus?.stopsCompleted || 0);
    }
    for (const v of snap.completed) if (v.type === 'bus') completedBuses.add(v.id);
    queueSum += snap.metrics.queued; activeSum += snap.metrics.active; maxActive = Math.max(maxActive, snap.metrics.active);
  }
  assert.ok(boardingFrames > 0 && maxStops >= 2, 'Scheduled buses must serve both stops.');
  assert.ok(completedBuses.size > 0, 'Scheduled buses must finish their routes.');
  const snapshot = sim.getSnapshot();
  assert.deepEqual(sim.reset(seed), TrafficSim.create(MAP_PREVIEW_DATA, { seed, realisticTraffic: true, autoBuses: true, autoCranes: true, autoBreakdowns: true, autoPedestrians: true }).getSnapshot(), 'Reset must reproduce the same seeded opening.');
  runs.push({ seed, demand, meanActive: +(activeSum / 600).toFixed(1), peakActive: maxActive, meanQueue: +(queueSum / 600).toFixed(1), completed: snapshot.metrics.completed, busesCompleted: completedBuses.size });
}
console.log(JSON.stringify({ fixture: 'Bus dwell, queues, opposite traffic, exit, and bike-only restriction passed.', simulatedMinutes: 20, speed: 8, runs }, null, 2));
