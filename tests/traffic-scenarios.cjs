const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isMainThread, Worker, parentPort, workerData } = require('node:worker_threads');

const files = ['map-data.js', 'signal-layout.js', 'simulation.js', 'ml-control.js'];
const modes = ['clear', 'closed', 'breakdown', 'bike-only', 'wet', 'snow', 'bike-wet'];
const checkpoints = new Set([0, 300, 600, 900, 1200]);
const targetDemand = 3;
const streetRunDuration = 1200;
const streetRecoveryDuration = 300;
const maxTestStreets = new Set(['S5', 'S18', 'S48', 'S50']);
const selection = process.argv[2] || 'all';
const dir = process.argv[3] || path.join(__dirname, '..');

function load(directory) {
  globalThis.window = globalThis;
  for (const file of files) require(path.join(directory, file));
  return {
    roads: MAP_PREVIEW_DATA.streets,
    create: (seed = 42) => TrafficSim.create(MAP_PREVIEW_DATA, { seed }),
    ml: (engine, seed) => TrafficMLControl.create(engine, { seed })
  };
}

function stats() {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity };
}
function add(s, n) {
  if (!Number.isFinite(n)) return;
  s.count++;
  s.sum += n;
  s.min = Math.min(n, s.min);
  s.max = Math.max(n, s.max);
}
function summary(s) {
  return s.count ? [Math.round(s.sum / s.count * 10) / 10, s.min, s.max] : [null, null, null];
}
function boundaryCounters() {
  return Object.fromEntries(['S48', 'S50'].map(id => [id, { in: 0, out: 0, inCar: 0, outCar: 0 }]));
}
function compareIdentity(before, after) {
  if (before.vehicles.length !== after.vehicles.length) return false;
  const current = new Map(after.vehicles.map(v => [v.id, v]));
  return before.vehicles.every(b => {
    const a = current.get(b.id);
    return a && b.streetId === a.streetId && b.reverse === a.reverse && b.progress === a.progress;
  });
}

function run(sim, scenario) {
  const { name, mode, street, seed = 42, speed = 8, demand = 1, controller, injections, selectDemand, duration = streetRunDuration, recovery = street ? streetRecoveryDuration : 0 } = scenario;
  const id = street?.id;
  const idSet = new Set(scenario.closures || (mode === 'closed' ? [id] : []));
  const flag = mode === 'closed' || mode === 'breakdown' ? mode : ['bike-only', 'bike-wet'].includes(mode) ? 'bikeOnly' : null;
  const weather = mode === 'bike-wet' ? 'wet' : ['wet', 'snow'].includes(mode) ? mode : 'clear';
  const failures = {};
  const fail = (type, detail) => { (failures[type] ||= { count: 0, first: detail }).count++; };
  const check = (condition, type, detail) => { if (!condition) fail(type, detail); };
  const engine = sim.create(seed);
  engine.setSpeed(speed);
  let snap = engine.getSnapshot();
  let motion = new Map(engine.getMotionSnapshot().vehicles.map(v => [v.id, v]));
  let laterMotion = new Map();
  const watchedIds = new Set(id ? [...idSet, id] : idSet);
  const gone = new Map();
  const covered = new Set();
  const byWindow = [new Set(), new Set(), new Set(), new Set()];
  const phases = [true, false].map(() => ({ queue: stats(), trip: stats(), stop: stats(), active: stats(), occupied: stats(), local: stats(), red: stats(), capSamples: 0, samples: 0, boundary: boundaryCounters() }));
  const result = { name, id, mode, speed, seed, demand, controller, failures, checkpoints: [], recovery: [], closureStats: {}, planted: { car: 0, bike: 0 }, injectedCompleted: { car: 0, bike: 0 }, entries: { car: 0, bike: 0 }, through: { car: 0, bike: 0 }, reopened: { car: 0, bike: 0 }, incidentPeak: 0, opposingMoveTicks: 0, incidentPasses: 0, fastestStartGap: null, firstRecoveryStarts: [], recoveredAfter: null, recoveryCohort: 0, capSeconds: 0, redPeak: 0, oldestCurrentStop: 0 };
  for (const road of idSet) result.closureStats[road] = { initial: null, emptyAt: null, firstReentry: null, final: null };
  const tracked = new Map();
  const trackedDeparted = new Set();
  const recoveryCohort = new Map();
  const clearedCohort = new Set();
  const recoveryStarted = new Set();
  let firstRecoveryEntry = null;
  let recoveredAfter = null;
  let previousComplete = snap.metrics.completed;
  let previousTripWait = snap.metrics.avgWait;
  let capAt = null;
  let capRejectionChecked = false;
  let firstLiveSample = 0;
  let passedAt = null;
  let oldestGridlock = null;
  let ml;
  let externalCalls = 0;
  const warmSamples = snap.metrics.avgWaitSampleCount;
  function report(call, label) {
    check(call.ok, label, call.message);
  }
  function toggle(fn, label) {
    const before = engine.getSnapshot();
    report(fn(), label);
    const after = engine.getSnapshot();
    check(compareIdentity(before, after), `${label} changed existing vehicles`, before.time);
    check(before.metrics.totalArrived === after.metrics.totalArrived && before.metrics.completed === after.metrics.completed, `${label} changed trip counts`, before.time);
    motion = new Map(engine.getMotionSnapshot().vehicles.map(v => [v.id, v]));
    snap = after;
  }
  if (demand !== 1 || selectDemand) toggle(() => engine.setDemand(demand), 'set demand');
  if (controller === 'fixed' || controller === 'adaptive') toggle(() => engine.setMode(controller), 'set strategy');
  if (controller === 'queue-aware' || controller === 'external') {
    ml = sim.ml(engine, seed);
    if (controller === 'external') {
      report(ml.registerExternalModel(() => { externalCalls++; return { holdSeconds: 18 }; }), 'register external');
    } else report(ml.setPolicy('baseline'), 'select queue policy');
    toggle(() => engine.setMode('custom'), 'select custom strategy');
  }
  if (scenario.closures) for (const closed of idSet) toggle(() => engine.setRoad(closed, { closed: true }), `close ${closed}`);
  if (flag) toggle(() => engine.setRoad(id, { [flag]: true }), `apply ${flag}`);
  if (street && (weather !== 'clear' || mode === 'clear')) toggle(() => engine.setRoadWeather(id, weather), `apply ${weather}`);
  const startRoad = snap.roads.find(r => r.id === id);
  if (street) {
    check(!flag || startRoad[flag], 'condition missing from snapshot', { id, flag });
    check(startRoad.surfaceWeather === weather, 'wrong road surface', startRoad.surfaceWeather);
    check(weather === 'clear' || startRoad.forwardSpeedFactor > 0 && startRoad.forwardSpeedFactor < 1, 'forward weather factor', startRoad.forwardSpeedFactor);
    check(weather === 'clear' || street.oneWay || startRoad.reverseSpeedFactor === startRoad.forwardSpeedFactor, 'reverse weather factor', startRoad.reverseSpeedFactor);
    check(mode !== 'breakdown' || startRoad.forwardSpeedFactor > 0 && startRoad.forwardSpeedFactor < 1, 'breakdown speed factor', startRoad.forwardSpeedFactor);
    check(mode !== 'breakdown' || street.oneWay || startRoad.reverseSpeedFactor === 1, 'opposing breakdown speed factor', startRoad.reverseSpeedFactor);
    if (flag === 'closed' || flag === 'bikeOnly') {
      check(!engine.addTraffic(id, 1, 'car').ok, 'restricted car injection', id);
      if (flag === 'closed') check(!engine.addTraffic(id, 1, 'bike').ok, 'restricted bike injection', id);
      check(compareIdentity(snap, engine.getSnapshot()), 'rejected addition changed vehicles', id);
    }
    result.roadFactors = [startRoad.forwardSpeedFactor, startRoad.reverseSpeedFactor];
  }
  check(snap.speed === speed, 'playback speed not selected', snap.speed);
  check(snap.demand === demand, 'demand selection mismatch', snap.demand);
  check(snap.mode === (controller === 'queue-aware' || controller === 'external' ? 'custom' : controller || 'adaptive'), 'strategy mismatch', snap.mode);
  if (scenario.pedestrian) report(engine.requestPedestrians(scenario.pedestrian, 8), 'pedestrian request');

  function inject(time) {
    let additions = [];
    if (street && ['clear', 'breakdown', 'bike-only', 'wet', 'snow', 'bike-wet'].includes(mode) && [5, 75, 240, 455, 615, 880, 1040, 1170].includes(time)) {
      additions = flag === 'bikeOnly' ? [['bike', 3]] : [['bike', 3], ['car', 3]];
    }
    if (injections) additions = injections[time] || additions;
    if (!additions.length) return;
    const before = engine.getSnapshot();
    for (const [type, count] of additions) {
      const response = engine.addTraffic(id || scenario.addStreet, count, type);
      if (injections) check(response.ok, 'manual addition failed', { time, type, reason: response.message });
    }
    const after = engine.getSnapshot();
    const previousIds = new Set(before.vehicles.map(v => v.id));
    let created = 0;
    for (const vehicle of engine.getMotionSnapshot().vehicles) {
      if (previousIds.has(vehicle.id)) continue;
      created++;
      result.planted[vehicle.type]++;
      tracked.set(vehicle.id, vehicle.type);
      motion.set(vehicle.id, vehicle);
    }
    check(created === after.metrics.totalArrived - before.metrics.totalArrived, 'manual arrival accounting', { time, created });
  }

  function observe(m) {
    const elapsed = m.time;
    const activePhase = elapsed <= duration;
    const phase = phases[activePhase ? 0 : 1];
    const map = laterMotion;
    map.clear();
    for (const v of m.vehicles) {
      map.set(v.id, v);
      const p = motion.get(v.id);
      if (p && p.routeIndex === v.routeIndex && p.streetId === v.streetId && p.reverse === v.reverse) {
        if (v.progress < p.progress - 0.000001) fail('same-leg backward movement', { id: v.id, time: elapsed, street: v.streetId });
        if (mode === 'breakdown' && v.streetId === id) {
          if (v.reverse && v.progress > p.progress) result.opposingMoveTicks++;
          if (activePhase && !v.reverse && !p.breakdownPassing && v.breakdownPassing) {
            result.incidentPasses++;
            if (passedAt !== null) result.fastestStartGap = Math.min(result.fastestStartGap ?? Infinity, elapsed - passedAt);
            passedAt = elapsed;
          }
        }
      }
      if (watchedIds.has(v.streetId) && (!p || p.streetId !== v.streetId || p.routeIndex !== v.routeIndex)) {
        if (idSet.has(v.streetId)) {
          const closure = result.closureStats[v.streetId];
          if (activePhase) fail('entered closed street', { id: v.id, time: elapsed, street: v.streetId });
          else if (closure.firstReentry === null) closure.firstReentry = elapsed - duration;
        }
        if (v.streetId === id) {
          const counts = activePhase ? result.entries : result.reopened;
          counts[v.type]++;
          if (activePhase && flag === 'bikeOnly' && v.type === 'car') fail('car entered bike-only street', { id: v.id, time: elapsed });
          if (!activePhase && firstRecoveryEntry === null) firstRecoveryEntry = elapsed - duration;
        }
      }
      const boundary = phase.boundary[v.streetId];
      if (!p && boundary && v.routeIndex === 0 && v.reverse === (v.streetId === 'S50')) {
        boundary.in++;
        if (v.type === 'car') boundary.inCar++;
      }
      if (activePhase && mode === 'breakdown' && v.streetId === id && v.reverse && (v.breakdownPassing || v.waitingReason === 'breakdown')) fail('reverse lane subject to breakdown', { id: v.id, time: elapsed });
      if (!activePhase && recoveryCohort.has(v.id) && !clearedCohort.has(v.id)) {
        if (v.streetId !== id) clearedCohort.add(v.id);
        else if (v.progress > recoveryCohort.get(v.id) + 0.0001 && !recoveryStarted.has(v.id)) {
          recoveryStarted.add(v.id);
          if (result.firstRecoveryStarts.length < 12) result.firstRecoveryStarts.push(elapsed - duration);
        }
      }
    }
    for (const [uid, v] of motion) {
      const next = map.get(uid);
      if (!next) gone.set(uid, { time: elapsed, streetId: v.streetId, reverse: v.reverse, type: v.type });
      if (activePhase && v.streetId === id && next && (next.streetId !== id || next.routeIndex !== v.routeIndex)) result.through[v.type]++;
      if (!activePhase && recoveryCohort.has(uid) && !next) clearedCohort.add(uid);
    }
    if (recoveryCohort.size && clearedCohort.size === recoveryCohort.size && recoveredAfter === null) recoveredAfter = elapsed - duration;
    if (m.vehicles.length === 180) { result.capSeconds += .25; if (capAt === null) capAt = elapsed; }
    laterMotion = motion;
    motion = map;
  }

  function sample(time, slot) {
    snap = engine.getSnapshot();
    const m = snap.metrics;
    const v = snap.vehicles;
    const finished = snap.completed;
    const phase = phases[time <= duration ? 0 : 1];
    if (ml) ml.observeSnapshot(snap);
    const queued = v.filter(w => w.waiting);
    const queueMean = queued.length ? queued.reduce((sum, w) => sum + w.currentStopSeconds, 0) / queued.length : null;
    const atCap = m.active >= m.activeLimit;
    check(m.active === v.length && m.active === m.totalArrived - m.completed, 'active vehicle accounting', { time, active: m.active, live: v.length, arrived: m.totalArrived, completed: m.completed });
    check(m.queued === queued.length, 'network queue count', { time, reported: m.queued, calculated: queued.length });
    check(m.currentQueueAvgWait === null ? queueMean === null : queueMean !== null && Math.abs(queueMean - m.currentQueueAvgWait) <= .11, 'current stop mean', { time, reported: m.currentQueueAvgWait, calculated: queueMean });
    check(v.every(w => w.waiting || w.currentStopSeconds === 0), 'nonqueued vehicle retains a current stop', time);
    check(v.every(w => w.currentStopSeconds <= w.waitTime + .1), 'continuous wait exceeds full trip wait', time);
    check(m.activeLimit === 180 && m.atActiveLimit === atCap && m.active <= m.activeLimit, 'active limit metadata', { time, active: m.active, limit: m.activeLimit, reported: m.atActiveLimit });
    if (atCap && !capRejectionChecked) {
      capRejectionChecked = true;
      const added = engine.addTraffic('S16', 1, 'car');
      check(!added.ok && /vehicle limit/.test(added.message), 'addition at active cap', added.message);
    }
    check(m.avgWaitWindowTrips === 30 && m.avgWaitSampleCount === Math.min(30, warmSamples + m.completed), 'trip wait sample size', { time, reported: m.avgWaitSampleCount });
    const age = m.avgWaitLatestSampleAgeSeconds ?? m.avgWaitLastCompletionAgeSeconds;
    const currentLastCompleted = finished.at(-1);
    if (currentLastCompleted) check(Number.isFinite(age) && Math.abs(age - (snap.time - currentLastCompleted.completedAt)) <= .11, 'latest completion age', { time, age, completedAt: currentLastCompleted.completedAt });
    if (!m.active) check(m.avgWait === null, 'trip mean active gating', time);
    if (finished.length >= 30 && m.active) {
      if (!firstLiveSample) firstLiveSample = time;
      const expected = finished.slice(-30).reduce((sum, item) => sum + item.waitTime, 0) / 30;
      check(Number.isFinite(m.avgWait) && Math.abs(expected - m.avgWait) <= .11, 'latest 30 trip mean', { time, expected, reported: m.avgWait });
    }
    if (previousComplete === m.completed && m.active && previousTripWait !== null) check(m.avgWait === previousTripWait, 'trip mean changed with no completion', { time, previous: previousTripWait, reported: m.avgWait });
    if (m.completed) check(Math.abs(m.avgWaitOverall - m.completedWaitSeconds / m.completed) <= .11, 'episode completed mean', time);
    previousComplete = m.completed;
    previousTripWait = m.avgWait;
    const completedIds = new Set(finished.map(c => c.id));
    for (const [uid, departed] of gone) {
      if (!completedIds.has(uid)) { fail('vehicle disappeared without completion', { uid, ...departed }); continue; }
      if (tracked.has(uid) && !trackedDeparted.has(uid)) {
        trackedDeparted.add(uid);
        result.injectedCompleted[tracked.get(uid)]++;
      }
      const b = phases[departed.time <= duration ? 0 : 1].boundary[departed.streetId];
      if (b && departed.reverse === (departed.streetId === 'S48')) {
        b.out++;
        if (departed.type === 'car') b.outCar++;
      }
      if (departed.time <= duration && departed.streetId === id) result.through[departed.type]++;
    }
    gone.clear();
    const roadQueues = new Map();
    const roadCounts = new Map();
    for (const running of v) roadCounts.set(running.streetId, (roadCounts.get(running.streetId) || 0) + 1);
    for (const w of queued) roadQueues.set(w.streetId, (roadQueues.get(w.streetId) || 0) + 1);
    for (const local of snap.roads) {
      check(local.queue === (roadQueues.get(local.id) || 0), 'street queue count', { time, id: local.id, queue: local.queue });
      check(local.count === (roadCounts.get(local.id) || 0) && local.count === local.carCount + local.bikeCount, 'street occupancy count', { time, id: local.id, count: local.count });
      if (local.count && time <= duration) {
        covered.add(local.id);
        byWindow[Math.min(3, Math.floor(time / 300))].add(local.id);
      }
      const closure = result.closureStats[local.id];
      if (closure && time <= duration) {
        if (time === 0) closure.initial = local.count;
        if (time === duration) closure.final = local.count;
        if (!local.count && closure.emptyAt === null) closure.emptyAt = time;
      }
      const target = local.id === id;
      if (time <= duration && local.surfaceWeather !== (target ? weather : 'clear')) fail('weather changed another street', { time, id: local.id });
      if (time <= duration && (idSet.has(local.id) !== local.closed || (local.bikeOnly !== (target && flag === 'bikeOnly')) || (local.breakdown !== (target && flag === 'breakdown')))) fail('wrong affected road flags', { time, id: local.id });
    }
    const local = id ? snap.roads.find(r => r.id === id) : null;
    if (local && mode === 'breakdown') {
      const incident = queued.filter(w => w.streetId === id && w.waitingReason === 'breakdown');
      check(local.breakdownQueue === incident.length, 'breakdown queue count', { time, id });
      if (time <= duration) result.incidentPeak = Math.max(result.incidentPeak, incident.length);
    }
    if (time > duration && local) check(!local.closed && !local.bikeOnly && !local.breakdown && local.surfaceWeather === 'clear' && local.forwardSpeedFactor === 1, 'condition stayed on after recovery', { time, id });
    const redMax = snap.signals.reduce((max, s) => Math.max(max, s.remaining), 0);
    result.redPeak = Math.max(result.redPeak, redMax);
    check(redMax <= 30, 'projected signal wait exceeds 30 seconds', { time, redMax });
    const oldestStop = queued.reduce((value, w) => Math.max(value, w.currentStopSeconds), 0);
    result.oldestCurrentStop = Math.max(oldestStop, result.oldestCurrentStop);
    if (oldestStop > 300 && !oldestGridlock) oldestGridlock = { time, oldestStop };
    add(phase.queue, m.queued);
    add(phase.trip, m.avgWait);
    add(phase.stop, m.currentQueueAvgWait);
    add(phase.active, m.active);
    add(phase.occupied, roadCounts.size);
    add(phase.local, local?.queue);
    add(phase.red, redMax);
    phase.samples++;
    if (atCap) phase.capSamples++;
    if (slot) result[slot].push({ time, active: m.active, queue: m.queued, tripWait: m.avgWait, queueWait: m.currentQueueAvgWait, complete: m.completed, arrived: m.totalArrived, occupied: roadCounts.size, cap: atCap, latest: age, local: local?.queue, localCount: local?.count, breakdown: local?.breakdownQueue, redMax, oldestStop, demand: snap.demand });
  }

  inject(0);
  sample(0, 'checkpoints');
  for (let elapsed = 1; elapsed <= duration + recovery; elapsed++) {
    const delta = speed / 8;
    for (let substep = 0; substep < 1 / delta; substep++) engine.step(delta, observe);
    if (elapsed % 5 === 0) {
      const record = checkpoints.has(elapsed) ? 'checkpoints' : elapsed > duration && (elapsed % 300 === 0 || elapsed === duration + 60) ? 'recovery' : null;
      sample(elapsed, record);
    }
    if (elapsed === duration && recovery) {
      for (const v of snap.vehicles) if (v.streetId === id && v.waitingReason === 'breakdown') recoveryCohort.set(v.id, v.progress);
      for (const streetId of idSet) toggle(() => engine.setRoad(streetId, { closed: false }), `reopen ${streetId}`);
      if (flag && flag !== 'closed') toggle(() => engine.setRoad(id, { [flag]: false }), `clear ${flag}`);
      if (weather !== 'clear') toggle(() => engine.setRoadWeather(id, 'clear'), 'restore clear surface');
      if (scenario.recoveryDemand !== undefined) toggle(() => engine.setDemand(scenario.recoveryDemand), 'restore typical demand');
    }
    if (elapsed < duration) inject(elapsed);
  }
  check(engine.getSnapshot().time === duration + recovery, 'elapsed simulation time', engine.getSnapshot().time);
  if (flag === 'bikeOnly') check(result.through.bike > 0, 'no bike traversed bike-only street', { id, planted: result.planted.bike });
  if (scenario.pedestrian) check(engine.getSnapshot().roads.find(r => r.id === scenario.pedestrian).pedestrians === 0, 'pedestrians still waiting after 20 min', scenario.pedestrian);
  if (controller === 'external') check(externalCalls > 0, 'external controller not called', null);
  if (result.firstRecoveryStarts.some((t, i) => i > 0 && t - result.firstRecoveryStarts[i - 1] < .5)) fail('breakdown cohort restarted together', result.firstRecoveryStarts);
  result.recoveryCohort = recoveryCohort.size;
  result.recoveredAfter = recoveredAfter;
  result.firstRecoveryEntry = firstRecoveryEntry;
  result.capAt = capAt;
  result.firstLiveSample = firstLiveSample;
  result.stats = phases.map(phase => ({ ...Object.fromEntries(['active', 'queue', 'trip', 'stop', 'occupied', 'local', 'red'].map(m => [m, summary(phase[m])])), capSamples: phase.capSamples, samples: phase.samples, boundary: phase.boundary }));
  result.coverage = covered.size;
  result.coverageWindows = byWindow.map(w => w.size);
  result.earliestLongWait = oldestGridlock;
  if (ml) result.controllerDecisions = ml.getSummary().transitionCount;
  result.externalCalls = externalCalls;
  return result;
}

function globals() {
  return [
    { name: 'Steady baseline', seed: 42 },
    { name: 'Steady baseline at 1x', seed: 42, speed: 1 },
    { name: 'Steady seed 7', seed: 7 },
    { name: 'Steady seed 109', seed: 109 },
    { name: 'Quiet preset', demand: 0 },
    { name: 'Typical preset', demand: 1, selectDemand: true },
    { name: 'Intermediate demand slider', demand: 1.5 },
    { name: 'Heavy preset', demand: targetDemand },
    { name: 'MAX endpoint', demand: targetDemand },
    { name: 'MAX seed 7', demand: targetDemand, seed: 7 },
    { name: 'MAX seed 109', demand: targetDemand, seed: 109 },
    { name: 'MAX with S26 and S36 closed', demand: targetDemand, closures: ['S26', 'S36'], recovery: 300 },
    { name: 'MAX then Typical', demand: targetDemand, recovery: 1200, recoveryDemand: 1 },
    { name: 'Add cars', addStreet: 'S36', injections: { 0: [['car', 5]] } },
    { name: 'Add bikes', addStreet: 'S36', injections: { 0: [['bike', 5]] } },
    { name: 'Adaptive rules', controller: 'adaptive' },
    { name: 'Fixed timing', controller: 'fixed' },
    { name: 'Queue-aware rules', controller: 'queue-aware' },
    { name: 'External integration test', controller: 'external' }
  ];
}

if (!isMainThread) {
  const sim = load(workerData.dir);
  const { suite, parts, part } = workerData;
  const scenarios = suite === 'global' ? globals() : sim.roads
    .filter(road => suite === 'matrix' || maxTestStreets.has(road.id))
    .flatMap(street => modes.map(mode => ({
      name: `${street.id} ${mode}${suite === 'max' ? ' at MAX' : ''}`,
      street,
      mode,
      demand: suite === 'max' ? targetDemand : 1
    })));
  for (const scenario of scenarios.filter((_, index) => index % parts === part)) {
    parentPort.postMessage(run(sim, scenario));
  }
} else {
  const rootDir = path.resolve(dir);
  if (!['all', 'matrix', 'global', 'max'].includes(selection)) {
    throw new Error('Usage: node tests/traffic-scenarios.cjs [all|matrix|global|max] [project-dir] [workers]');
  }
  const jobs = selection === 'all' ? ['global', 'matrix', 'max'] : [selection];
  const parts = process.argv[4] ? Number(process.argv[4]) : 8;
  if (!Number.isInteger(parts) || parts < 1) throw new Error('Worker count must be a positive integer.');
  const results = [];
  const hash = Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(rootDir, file))).digest('hex')]));
  const start = Date.now();
  async function runWorkers(suite) {
    const workers = Array.from({ length: parts }, (_, part) => new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: { dir: rootDir, suite, parts, part } });
      worker.on('message', result => {
        results.push(result);
        if (suite === 'global' || results.length % 7 === 0 || Object.keys(result.failures).length) {
          console.error(result.name, results.length, Object.keys(result.failures).join(', '), `${Math.round((Date.now() - start) / 1000)}s`);
        }
      });
      worker.on('error', reject);
      worker.on('exit', status => status === 0 ? resolve() : reject(new Error(`worker exited ${status}`)));
    }));
    await Promise.all(workers);
  }
  async function main() {
    for (const suite of jobs) await runWorkers(suite);
    const globalOrder = globals().map(s => s.name);
    results.sort((a, b) => {
      if (!a.id && !b.id) return globalOrder.indexOf(a.name) - globalOrder.indexOf(b.name);
      if (!a.id) return -1;
      if (!b.id) return 1;
      return a.demand - b.demand || Number(a.id.slice(1)) - Number(b.id.slice(1)) || modes.indexOf(a.mode) - modes.indexOf(b.mode);
    });
    function identical(first, second) {
      const left = results.find(r => r.name === first);
      const right = results.find(r => r.name === second);
      if (!left || !right) return;
      const trace = r => JSON.stringify([r.checkpoints, r.stats, r.coverageWindows, r.capSeconds]);
      if (trace(left) !== trace(right)) right.failures['trace differs'] = { count: 1, first };
    }
    identical('Steady baseline', 'Steady baseline at 1x');
    identical('Steady baseline', 'Typical preset');
    identical('Heavy preset', 'MAX endpoint');
    for (const file of files) {
      const after = crypto.createHash('sha256').update(fs.readFileSync(path.join(rootDir, file))).digest('hex');
      if (hash[file] !== after) throw new Error(`${file} changed during suite`);
    }
    process.stdout.write(JSON.stringify({ hash, selection, results }));
    const failed = results.filter(r => Object.keys(r.failures).length).length;
    console.error(`Complete. ${results.length} runs and ${failed} failed runs in ${Math.round((Date.now() - start) / 1000)}s`);
    if (failed) process.exitCode = 1;
  }
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
