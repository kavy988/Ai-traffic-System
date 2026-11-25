const assert = require('node:assert/strict');

globalThis.window = globalThis;
require('../js/map-data.js');
require('../js/signal-layout.js');
require('../js/simulation.js');

const data = MAP_PREVIEW_DATA;
const settings = {
  realisticTraffic: true, autoPedestrians: true, autoBuses: true,
  schoolTraffic: true, autoBreakdowns: true, autoCranes: true
};

for (const value of [0, 29, -1, NaN, Infinity, '60']) {
  assert.throws(() => TrafficSim.create(data, { maxRedSeconds: value }), /maxRedSeconds/);
}
assert.equal(TrafficSim.create(data).exportRun().maxRedSeconds, 30);
const configured = TrafficSim.create(data, { maxRedSeconds: 90 });
assert.equal(configured.exportRun().maxRedSeconds, 90);
assert.equal(configured.reset(7).maxRedSeconds, 90);
assert.equal(TrafficSim.create(data).getSnapshot().maxRedSeconds, 30,
  'A configured engine must not change the default for other runs.');

function run(seed, maxRedSeconds, choice) {
  const sim = TrafficSim.create(data, { ...settings, seed, maxRedSeconds });
  const decisions = [];
  sim.setController(({ decision }) => {
    const { minGreen, maxGreen } = decision;
    assert.ok(Number.isFinite(minGreen) && minGreen >= 0 && minGreen <= maxGreen);
    assert.ok(maxGreen <= maxRedSeconds);
    decisions.push({ minGreen, maxGreen });
    return { holdSeconds: choice === 'minimum' ? minGreen : maxGreen };
  });
  sim.setMode('custom');
  sim.setSpeed(8);
  sim.setDemand(3);
  const redStarts = new Map();
  const stages = new Map();
  const walks = new Set();
  const transitionChecks = { yellow: 0, allred: 0, walk: 0 };
  let peakRed = 0;

  // At 8x and 32 frames/second, each update advances 0.25 simulated seconds.
  for (let elapsed = 0; elapsed < 1200; elapsed += 8 / 32) {
    sim.step(8 / 32);
    const snap = sim.getSnapshot();
    const now = elapsed + 8 / 32;
    const junctions = new Map();
    for (const signal of snap.signals) {
      assert.ok(signal.remaining >= 0 && signal.remaining <= maxRedSeconds + .01,
        `Projected timing exceeded ${maxRedSeconds}s at ${signal.id}`);
      if (signal.color === 'red') {
        if (!redStarts.has(signal.id)) redStarts.set(signal.id, now);
        const redAge = now - redStarts.get(signal.id);
        peakRed = Math.max(peakRed, redAge);
        assert.ok(redAge <= maxRedSeconds + .25, `Red exceeded its limit at ${signal.id}`);
      } else redStarts.delete(signal.id);
      if (!junctions.has(signal.nodeId)) junctions.set(signal.nodeId, []);
      junctions.get(signal.nodeId).push(signal);
    }
    const walkingNodes = new Set();
    for (const crossing of snap.crossings.filter(item => item.state === 'walk')) {
      walks.add(crossing.id);
      walkingNodes.add(crossing.nodeId);
      assert.equal(crossing.duration, 7);
      assert.ok(junctions.get(crossing.nodeId).every(signal => signal.color === 'red'),
        'All vehicle approaches must stay red during WALK.');
    }
    for (const [nodeId, signals] of junctions) {
      const stage = signals.some(item => item.color === 'green') ? 'green'
        : signals.some(item => item.color === 'yellow') ? 'yellow'
        : walkingNodes.has(nodeId) ? 'walk' : 'allred';
      const previous = stages.get(nodeId);
      if (!previous || previous.stage !== stage) {
        if (previous) {
          const duration = now - previous.startedAt;
          if (previous.complete && previous.stage in transitionChecks) {
            // A stage can start inside an update: sampled boundaries have one tick of uncertainty.
            assert.ok(Math.abs(duration - { yellow: 3, allred: 1, walk: 7 }[previous.stage]) <= .25 + 1e-6,
              `${previous.stage} lasted ${duration}s at ${nodeId}; seed=${seed}, limit=${maxRedSeconds}, choice=${choice}, time=${snap.time}`);
            transitionChecks[previous.stage]++;
          }
          if (previous.stage === 'green') assert.equal(stage, 'yellow');
          if (previous.stage === 'yellow' || previous.stage === 'walk') assert.equal(stage, 'allred');
          if (previous.stage === 'allred') assert.ok(stage === 'green' || stage === 'walk');
        }
        stages.set(nodeId, { stage, startedAt: now, complete: Boolean(previous) });
      }
    }
  }
  assert.ok(walks.size >= 8, 'Pedestrian crossings must continue receiving service.');
  assert.ok(Object.values(transitionChecks).every(count => count > 0));
  assert.ok(sim.getSnapshot().metrics.completed > 100, 'Vehicle trips must continue completing.');
  assert.equal(sim.exportRun().maxRedSeconds, maxRedSeconds);
  return { seed, maxRedSeconds, choice, peakRed, crossingsServed: walks.size,
    widestGreenRange: Math.max(...decisions.map(item => item.maxGreen - item.minGreen)) };
}

const results = [];
for (const seed of [7, 42, 109]) {
  for (const choice of ['minimum', 'maximum']) {
    const normal = run(seed, 30, choice);
    const relaxed = run(seed, 60, choice);
    assert.ok(relaxed.widestGreenRange > normal.widestGreenRange,
      'Relaxing the red limit must expose genuinely wider legal green choices.');
    results.push(normal, relaxed);
  }
}
console.log(JSON.stringify({ simulatedMinutesPerRun: 20, speed: 8, results }, null, 2));
