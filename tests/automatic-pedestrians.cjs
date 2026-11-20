const assert = require('node:assert/strict');

globalThis.window = globalThis;
require('../map-data.js');
require('../signal-layout.js');
require('../simulation.js');

const data = globalThis.MAP_PREVIEW_DATA;
const create = (seed, autoPedestrians) => globalThis.TrafficSim.create(data, { seed, autoPedestrians });
const hasPeople = ({ waiting, crossing }) => waiting > 0 || crossing > 0;

function firstArrival(engine) {
  for (let tick = 0; tick < 28; tick += 1) {
    engine.step(0.25);
    const { time, crossings } = engine.getMotionSnapshot();
    const waiting = crossings.find(hasPeople);
    if (waiting) return { time, waiting };
  }
  assert.fail('No automatic pedestrians in the first seven simulated seconds');
}

const engine = create(42, true);
engine.setRunning(false);
engine.step(5);
assert.equal(engine.getMotionSnapshot().time, 0);
assert.ok(!engine.getMotionSnapshot().crossings.some(hasPeople));
engine.setRunning(true);
const first = firstArrival(engine);
assert.ok(first.time >= 3 && first.time <= 7);
assert.ok(first.waiting.waiting >= 1 && first.waiting.waiting <= 3);
engine.reset(42);
assert.deepEqual(firstArrival(engine), first);

const manual = create(42, false);
for (let step = 0; step < 12; step += 1) manual.step(5);
assert.ok(!manual.getMotionSnapshot().crossings.some(hasPeople));
assert.ok(manual.requestCrossing(first.waiting.id, 2).ok);
const markedCrossing = () => manual.getSnapshot().crossings.find(({ id }) => id === first.waiting.id);
assert.equal(markedCrossing().waiting, 2);
for (let tick = 0; tick < 320 && markedCrossing().state !== 'walk'; tick += 1) manual.step(0.25);
assert.equal(markedCrossing().crossing, 2);
assert.equal(markedCrossing().completedPedestrians, 0);
assert.ok(manual.requestCrossing(first.waiting.id, 1).ok);
for (let tick = 0; tick < 32 && markedCrossing().state === 'walk'; tick += 1) manual.step(0.25);
assert.equal(markedCrossing().completedPedestrians, 2);
assert.equal(markedCrossing().waiting, 1);
assert.equal(manual.reset(42).crossings.find(({ id }) => id === first.waiting.id).completedPedestrians, 0);

for (const seed of [7, 42]) {
  const traffic = create(seed, true);
  const walked = new Set();
  traffic.setDemand(3);
  for (let tick = 0; tick < 2400; tick += 1) {
    traffic.step(0.25);
    const snapshot = traffic.getSnapshot();
    const walking = snapshot.crossings.filter(({ state }) => state === 'walk');
    for (const crossing of walking) {
      walked.add(crossing.id);
      assert.ok(crossing.remaining > 0 && crossing.remaining <= crossing.duration);
      const approaches = snapshot.signals.filter(({ nodeId }) => nodeId === crossing.nodeId);
      assert.ok(approaches.length > 0 && approaches.every(({ color }) => color === 'red'));
    }
    assert.ok(snapshot.signals.every(({ remaining }) => remaining <= 30));
  }
  assert.ok(walked.size >= 8, `Only ${walked.size} crossings served pedestrians with seed ${seed}`);
  assert.ok(traffic.getSnapshot().metrics.completed > 100);
}

console.log('Automatic pedestrian arrivals, pause, reset, manual requests, and WALK phases passed.');
