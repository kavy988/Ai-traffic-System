const assert = require('node:assert/strict');
globalThis.window = globalThis;
require('../js/map-data.js'); require('../js/signal-layout.js'); require('../js/simulation.js');
const data = MAP_PREVIEW_DATA;
const settings = { realisticTraffic: true, autoBuses: true, schoolTraffic: true, autoPedestrians: true, autoCranes: true, autoBreakdowns: true };
const servedStopIds = new Set();
for (const service of data.busServices) {
  for (let i = 0; i < service.route.length; i++) {
    const leg = service.route[i], street = data.streets.find(s => s.id === leg.streetId);
    assert.ok(street && !(street.oneWay && leg.reverse));
    if (i) { const prev = service.route[i - 1], road = data.streets.find(s => s.id === prev.streetId); assert.equal(prev.reverse ? road.from : road.to, leg.reverse ? street.to : street.from); }
    for (const stop of data.busStops) if (stop.streetId === leg.streetId && Boolean(stop.reverse) === Boolean(leg.reverse)) servedStopIds.add(stop.id);
  }
}
assert.equal(servedStopIds.size, data.busStops.length, 'Every platform must have a scheduled service.');
const runs = [];
for (const seed of [42, 7, 109]) for (const demand of [1, 2, 3]) {
  const sim = TrafficSim.create(data, { ...settings, seed }); sim.setSpeed(8); sim.setDemand(demand);
  const lines = new Set(), roads = new Set(), calls = new Set(), motionKinds = new Set(), completedBuses = new Set();
  let lastArrived = 0, arrivalsAtWindowEnd, largestQueue = 0;
  for (let t = 0; t < 1200; t += 8 / 32) {
    sim.step(8 / 32);
    if (t % 2) continue;
    const s = sim.getSnapshot();
    assert.ok(s.metrics.active <= 200);
    assert.equal(s.roads.reduce((n,r) => n + r.count,0),s.metrics.active);
    assert.equal(s.roads.reduce((n,r) => n + r.queue,0),s.metrics.queued);
    const waiting = s.busStops.reduce((n,stop) => n + stop.waiting.length,0);
    const onboard = s.vehicles.reduce((n,v) => n + (v.bus?.onboard || 0),0);
    const moving = s.passengerMotions.filter(m => !m.schoolId).length;
    assert.equal(waiting + onboard + moving + s.passengers.completed,s.passengers.arrived,'Passengers must not appear or disappear during transfers.');
    for (const stop of s.busStops) assert.ok(stop.waiting.length <= 24);
    for (const v of s.vehicles) if (v.bus) {
      assert.ok(v.bus.onboard >= 0 && v.bus.onboard <= 24);
      lines.add(v.bus.serviceId); roads.add(v.streetId);
      if (v.bus.stage === 'boarding') { calls.add(v.bus.stopId); assert.ok(v.bus.remaining <= 22); }
    }
    for (const v of s.completed) if (v.bus) completedBuses.add(v.id);
    for (const m of s.passengerMotions) { motionKinds.add(m.kind); assert.ok(m.progress >= 0 && m.progress <= 1); }
    const school = s.schools[0];
    assert.ok(school.carsArrived >= lastArrived); lastArrived = school.carsArrived;
    if (s.time >= 365 && arrivalsAtWindowEnd === undefined) arrivalsAtWindowEnd = school.carsArrived;
    if (s.time > 370) assert.equal(school.carsArrived, arrivalsAtWindowEnd,'The school arrival burst must end at the configured time.');
    largestQueue = Math.max(largestQueue,s.metrics.queued);
  }
  const s=sim.getSnapshot();
  assert.equal(lines.size, data.busServices.length,'All eight directions must run.');
  assert.ok(roads.size > 20,'Bus traffic must cover multiple parts of the map.');
  if (demand === 1) assert.equal(calls.size,data.busStops.length,'Seed '+seed+' missing '+data.busStops.filter(stop=>!calls.has(stop.id)).map(stop=>stop.id).join(','));
  for (const kind of ['boarding','alighting','walking-away','school-dropoff']) assert.ok(motionKinds.has(kind),'Missing visible motion '+kind);
  assert.ok(s.schools[0].carsServed>0 && s.schools[0].studentsServed>0 && completedBuses.size>0);
  const reset=sim.reset(seed), fresh=TrafficSim.create(data,{...settings,seed}).getSnapshot();assert.deepEqual(reset,fresh);
  runs.push({seed,demand,lines:lines.size,busStreets:roads.size,platformsServed:calls.size,boarded:s.passengers.boarded,alighted:s.passengers.alighted,schoolCars:s.schools[0].carsServed,students:s.schools[0].studentsServed,peakQueue:largestQueue});
}
const pickup = TrafficSim.create(data,{...settings,seed:42});
assert.ok(pickup.setDemandProfile('daily','14:58').ok);
let sawPickup=false;
for(let t=0;t<600;t+=.25){pickup.step(.25);const s=pickup.getMotionSnapshot();if(s.passengerMotions.some(m=>m.kind==='school-pickup')){sawPickup=true;break;}}
assert.ok(sawPickup,'Afternoon pickup must load children into cars.');
console.log(JSON.stringify({minutesPerSeed:20,speed:8,buildings:'unchanged',pickup:'passed',runs},null,2));
