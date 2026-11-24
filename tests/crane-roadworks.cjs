const assert = require('node:assert/strict');

globalThis.window = globalThis;
require('../js/map-data.js');
require('../js/signal-layout.js');
require('../js/simulation.js');

const speed = 8;
const simStep = speed / 32;
const duration = 600;
const dispatches = new Map([[0, 'S23'], [105, 'S18'], [210, 'S34'], [315, 'S7'], [420, 'S42']]);
const create = () => globalThis.TrafficSim.create(globalThis.MAP_PREVIEW_DATA, { seed: 42, autoPedestrians: true });

function run(withRoadwork) {
  const engine = create();
  const jobs = new Map();
  const detours = new Set();
  let totalQueue = 0;
  let peakQueue = 0;
  let previousVehicles = new Map();
  let previousClosed = new Set();
  engine.setSpeed(speed);

  for (let time = 0; time < duration; time += simStep) {
    if (withRoadwork && dispatches.has(time)) {
      const streetId = dispatches.get(time);
      const dispatched = engine.addTraffic(streetId, 1, 'crane');
      assert.ok(dispatched.ok, `Dispatch from ${streetId} at ${time}s failed: ${dispatched.message}`);
    }

    engine.step(simStep);
    const snapshot = engine.getSnapshot();
    const closed = new Set(snapshot.roads.filter((road) => road.workClosed).map((road) => road.id));
    const carsAndBikes = snapshot.vehicles.filter((vehicle) => vehicle.type !== 'crane');
    const queued = carsAndBikes.filter((vehicle) => vehicle.waiting).length;
    totalQueue += queued * simStep;
    peakQueue = Math.max(peakQueue, queued);

    for (const vehicle of carsAndBikes) {
      if (closed.has(vehicle.streetId) && previousClosed.has(vehicle.streetId)) {
        assert.equal(previousVehicles.get(vehicle.id), vehicle.streetId, `Vehicle entered active work closure on ${vehicle.streetId}`);
      }
      if (vehicle.closureDetour?.closedRoadIds.some((streetId) => closed.has(streetId))) detours.add(vehicle.id);
    }
    previousVehicles = new Map(carsAndBikes.map((vehicle) => [vehicle.id, vehicle.streetId]));
    previousClosed = closed;

    for (const job of snapshot.roadworks) {
      const crane = snapshot.vehicles.find((vehicle) => vehicle.id === job.vehicleId);
      assert.equal(crane?.type, 'crane');
      const workIndex = crane.route.findIndex((leg) => leg.streetId === job.streetId && leg.reverse === job.reverse);
      assert.ok(workIndex >= 0 && workIndex <= 1, 'The work site is within the first two streets');
      assert.ok(job.progress >= 0 && job.progress <= 1);
      if (job.state === 'enroute') continue;
      assert.ok(closed.has(job.streetId));
      if (job.state !== 'working') continue;
      assert.ok(job.duration > 0 && job.duration <= 30 && job.remaining >= 0 && job.remaining <= job.duration);
      assert.ok(!carsAndBikes.some((vehicle) => vehicle.streetId === job.streetId), `Work started before ${job.streetId} cleared`);
      const previous = jobs.get(job.id);
      assert.ok(!previous || job.progress >= previous.progress);
      jobs.set(job.id, { street: job.streetId, plannedWorkSeconds: job.duration, progress: job.progress, state: 'working', exited: false });
    }

    for (const crane of [...snapshot.vehicles, ...snapshot.completed].filter((vehicle) => vehicle.type === 'crane')) {
      if (!['finished', 'incomplete'].includes(crane.roadwork?.state)) continue;
      const job = jobs.get(crane.roadwork.id);
      assert.ok(job, 'Crane was observed working');
      job.state = crane.roadwork.state;
      job.exited ||= snapshot.completed.some((vehicle) => vehicle.id === crane.id);
      assert.ok(crane.roadwork.elapsed <= 30, 'Crane work ran past its time limit');
    }
  }

  const end = engine.getSnapshot();
  assert.equal(end.time, duration);
  assert.equal(end.speed, speed);
  assert.equal(end.roadworks.length, 0);
  assert.ok(!end.roads.some((road) => road.workClosed));
  const completedJobs = [...jobs.values()].filter((job) => job.state === 'finished' || job.state === 'incomplete');
  if (withRoadwork) {
    assert.equal(completedJobs.length, dispatches.size);
    assert.ok(detours.size > 0, 'At least one journey detoured around roadwork');
  }
  return {
    completedTrips: end.metrics.completed - completedJobs.filter((job) => job.exited).length,
    averageQueue: Number((totalQueue / duration).toFixed(2)),
    peakQueue,
    detouredVehicles: detours.size,
    completedJobs: completedJobs.map(({ street, plannedWorkSeconds, state, exited }) => ({ street, plannedWorkSeconds, state, exited }))
  };
}

const baseline = run(false);
const roadwork = run(true);
assert.notEqual(roadwork.averageQueue, baseline.averageQueue);
assert.ok(baseline.completedTrips > 0 && roadwork.completedTrips > 0);
console.log(JSON.stringify({ elapsedSimSeconds: duration, speed, baseline, roadwork }, null, 2));
