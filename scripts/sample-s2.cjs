// Adapter for the existing simulator. One JSON line per sampled instant.
globalThis.window = globalThis;
require('../js/map-data.js');
require('../js/signal-layout.js');
require('../js/simulation.js');

const { seed, demand, startTime, incidents, duration, interval } = JSON.parse(process.argv[2]);
const engine = TrafficSim.create(MAP_PREVIEW_DATA, {
  seed,
  realisticTraffic: true,
  autoPedestrians: true,
  autoBreakdowns: incidents,
  autoCranes: incidents
});
engine.setDemand(demand);
if (startTime) engine.setDemandProfile('daily', startTime);

for (let time = 0; time <= duration; time += interval) {
  if (time > 0) engine.step(interval);
  const snapshot = engine.getSnapshot();
  const approach = snapshot.vehicles.filter(vehicle => vehicle.streetId === 'S2' && !vehicle.reverse);
  const signal = snapshot.signals.find(item => item.nodeId === 'k2' && item.streetId === 'S2' && !item.reverse);
  const road = snapshot.roads.find(item => item.id === 'S2');
  if (!signal || !road) throw new Error('S2 approach to k2 is missing from the map.');
  process.stdout.write(JSON.stringify({
    time_s: snapshot.time,
    clock_s: snapshot.timeOfDaySeconds,
    vehicles_now: approach.length,
    queue_now: approach.filter(vehicle => vehicle.waiting).length,
    pedestrians_waiting: snapshot.crossings
      .filter(item => item.nodeId === 'k2')
      .reduce((count, item) => count + item.waiting, 0),
    signal_color: signal.color,
    signal_remaining_s: signal.remaining,
    effective_demand: snapshot.metrics.effectiveDemand,
    s2_closed: Number(road.closed),
    s2_breakdown: Number(road.breakdown)
  }) + '\n');
}
