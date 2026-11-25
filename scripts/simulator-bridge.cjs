// A line-delimited JSON transport for the JavaScript simulator.
// It does not implement Gymnasium, a reward, a policy, or a training loop.
const readline = require('node:readline');
globalThis.window = globalThis;
for (const file of ['map-data', 'signal-layout', 'simulation', 'simulator-interface']) {
  require(`../js/${file}.js`);
}

let engine;
let simulator;
let configuration;
let seed;
let baselineProfile;

function check(result) {
  if (result?.ok === false) throw new Error(result.message);
  return result;
}

function applyConfiguration(target, settings) {
  check(target.setDemand(settings.demand ?? 1));
  if (settings.demandProfile || settings.startTime) {
    check(target.setDemandProfile(settings.demandProfile || 'steady', settings.startTime));
  }
  for (const road of settings.roads || []) {
    if (road.changes) check(target.setRoad(road.streetId, road.changes));
    if (road.surface) check(target.setRoadWeather(road.streetId, road.surface));
  }
  if (!['adaptive', 'fixed', 'network'].includes(settings.mode || 'network')) {
    throw new Error('mode must be adaptive, fixed, or network.');
  }
  check(target.setMode(settings.mode || 'network'));
}

function handle(request) {
  if (request.command === 'init') {
    const settings = request.settings || {};
    const nextSeed = settings.seed ?? 42;
    if (!Number.isInteger(nextSeed) || nextSeed < 0 || nextSeed > 0xffffffff) {
      throw new Error('seed must be an unsigned 32-bit integer.');
    }
    const candidate = TrafficSim.create(MAP_PREVIEW_DATA, {
      seed: nextSeed, maxRedSeconds: settings.maxRedSeconds,
      realisticTraffic: true, autoPedestrians: settings.autoPedestrians ?? true,
      autoBuses: settings.autoBuses ?? true, schoolTraffic: settings.schoolTraffic ?? true,
      autoBreakdowns: settings.autoBreakdowns ?? true, autoCranes: settings.autoCranes ?? true
    });
    const baseline = candidate.getSnapshot();
    applyConfiguration(candidate, settings);
    const candidateInterface = TrafficSimulatorInterface.create(candidate, MAP_PREVIEW_DATA, settings.detectors);
    engine = candidate;
    simulator = candidateInterface;
    configuration = settings;
    seed = nextSeed;
    baselineProfile = { mode: baseline.demandProfileMode, startTime: baseline.demandProfileStartTime };
    return { metadata: simulator.metadata(), ...simulator.read() };
  }
  if (!simulator) throw new Error('Send an init command first.');
  switch (request.command) {
    case 'observe': return simulator.read();
    case 'actions': return check(simulator.applyActions(request.choices));
    case 'advance': return simulator.advance(request.seconds);
    case 'reset': {
      const nextSeed = request.seed ?? seed;
      if (!Number.isInteger(nextSeed) || nextSeed < 0 || nextSeed > 0xffffffff) {
        throw new Error('seed must be an unsigned 32-bit integer.');
      }
      // Core reset preserves the live clock profile for the website. This command
      // restores init's baseline warm-up first, then reapplies the run settings.
      check(engine.setDemandProfile(baselineProfile.mode, baselineProfile.startTime));
      engine.reset(nextSeed);
      seed = nextSeed;
      applyConfiguration(engine, configuration);
      return { metadata: simulator.metadata(), ...simulator.read() };
    }
    case 'mode': check(engine.setMode(request.value)); break;
    case 'demand': check(engine.setDemand(request.value)); break;
    case 'profile': check(engine.setDemandProfile(request.value, request.startTime)); break;
    case 'road': check(engine.setRoad(request.streetId, request.changes)); break;
    case 'surface': check(engine.setRoadWeather(request.streetId, request.value)); break;
    default: throw new Error(`Unknown command: ${request.command}`);
  }
  return simulator.read();
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  let request;
  try {
    request = JSON.parse(line);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Expected a JSON object.');
    if (request.command === 'close') {
      process.stdout.write(JSON.stringify({ id: request.id ?? null, ok: true }) + '\n');
      input.close();
      process.stdin.pause();
      return;
    }
    const result = handle(request);
    process.stdout.write(JSON.stringify({ id: request.id ?? null, ok: true, ...result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: request?.id ?? null, ok: false, error: error.message }) + '\n');
  }
});
