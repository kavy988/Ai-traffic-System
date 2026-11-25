(function (root) {
  'use strict';

  const SURFACE_WEATHER = new Set(['clear', 'wet', 'snow']);
  const VEHICLE_PROFILES = {
    car: { majorSpeed: 13.2, localSpeed: 9.5, acceleration: 3.4, braking: 5, gap: 22, halfLength: 9 },
    bike: { majorSpeed: 6.7, localSpeed: 5.8, acceleration: 1.7, braking: 2.8, gap: 14, halfLength: 6 },
    crane: { majorSpeed: 4.8, localSpeed: 4.2, acceleration: 1.05, braking: 3.1, gap: 34, halfLength: 13 },
    bus: { majorSpeed: 11, localSpeed: 8, acceleration: 1.8, braking: 4, gap: 40, halfLength: 18 }
  };
  const TYPES = new Set(Object.keys(VEHICLE_PROFILES));
  const MAX_VEHICLES = 200;
  const MAX_COMPLETED = 100;
  const MAX_EVENTS = 80;
  const MAX_HISTORY = 120;
  const MAX_STEP = 5;
  const SIMULATION_STEP_SECONDS = 0.25;
  const EPSILON = 1e-6;
  const AVG_WAIT_TRIP_COUNT = 30;
  const STARTUP_WARMUP_SECONDS = 600;
  const BOUNDARY_WARMUP_SECONDS = 480;
  const START_TIME_OF_DAY_SECONDS = 8 * 60 * 60 + 30 * 60;
  const SECONDS_PER_DAY = 24 * 60 * 60;
  const DEMAND_PROFILE = [
    [0, 0.4], [4, 0.35], [5, 0.42], [6, 0.65], [7, 0.95], [8, 1.25],
    [9, 1.35], [10, 0.98], [12, 0.88], [14, 0.9], [16, 1.0],
    [17, 1.22], [18, 1.35], [19, 1.2], [20, 0.95], [22, 0.6], [24, 0.4]
  ];
  const WAYPOINT_ROUTE_SHARE = 0.55;
  const COVERAGE_ROUTE_SHARE = 0.24;
  const COVERAGE_IDLE_SECONDS = 95;
  const HEAVY_DEMAND_THRESHOLD = 2.5;
  const MAX_BOUNDARY_QUEUE = 60;
  const BOUNDARY_RETRY_SECONDS = 0.5;
  const TYPICAL_BOUNDARY_RATE = 0.40;
  const BUSY_BOUNDARY_RATE = 0.56;
  const HEAVY_BOUNDARY_RATE = 0.87;
  const JUNCTION_CLEARANCE_METERS = 8;
  const SIGNAL_YELLOW_SECONDS = 6.5;
  const SIGNAL_ALL_RED_SECONDS = 1;
  const PEDESTRIAN_WALK_SECONDS = 7;
  const DEFAULT_MAX_SIGNAL_RED_SECONDS = 30;
  const RED_CAP_MARGIN_SECONDS = 0.1;
  const BREAKDOWN_STARTUP_HOLD = 3;
  const BREAKDOWN_PASS_HEADWAY = 1.25;
  const BREAKDOWN_RECOVERY_HEADWAY = 1.7;
  const AUTO_BREAKDOWN_MIN_GAP = 45;
  const AUTO_BREAKDOWN_GAP_RANGE = 30;
  const AUTO_BREAKDOWN_MIN_DURATION = 18;
  const AUTO_BREAKDOWN_DURATION_RANGE = 14;
  const AUTO_CRANE_START_MIN = 45;
  const AUTO_CRANE_START_RANGE = 30;
  const AUTO_CRANE_MIN_GAP = 75;
  const AUTO_CRANE_GAP_RANGE = 45;
  const AUTO_CRANE_RETRY_SECONDS = 15;
  const MAX_AUTOMATIC_CRANES = 2;
  const ENTRY_PROGRESS = 0.025;
  const ROADWORK_SPEED = 5.8;
  const MIN_ROADWORK_SECONDS = 12;
  const MAX_ROADWORK_SECONDS = 30;
  const MAX_STALLED_CLEARANCE_SECONDS = 90;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function mulberry32(seed) {
    let state = seed >>> 0;
    return function () {
      state += 0x6D2B79F5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function demandProfileFactor(timeOfDaySeconds) {
    const hour = (timeOfDaySeconds % SECONDS_PER_DAY) / 3600;
    for (let index = 0; index < DEMAND_PROFILE.length - 1; index += 1) {
      const [startHour, startFactor] = DEMAND_PROFILE[index];
      const [endHour, endFactor] = DEMAND_PROFILE[index + 1];
      if (hour > endHour) continue;
      const fraction = clamp((hour - startHour) / (endHour - startHour), 0, 1);
      const smoothFraction = fraction * fraction * (3 - 2 * fraction);
      return startFactor + (endFactor - startFactor) * smoothFraction;
    }
    return DEMAND_PROFILE[0][1];
  }

  function formatTimeOfDay(timeOfDaySeconds) {
    const wholeSeconds = Math.floor(timeOfDaySeconds % SECONDS_PER_DAY);
    const hour = Math.floor(wholeSeconds / 3600);
    const minute = Math.floor((wholeSeconds % 3600) / 60);
    return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
  }

  function create(data, options) {
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.streets)) {
      throw new Error('TrafficSim.create requires map data with nodes and streets.');
    }

    const nodes = new Map(data.nodes.map((node) => [node.id, node]));
    const realisticTraffic = options?.realisticTraffic === true;
    // A run-level service limit, not an action the signal controller can override.
    // Keep existing runs at 30 seconds; experiments may explicitly relax it.
    const maxRedSeconds = options?.maxRedSeconds ?? DEFAULT_MAX_SIGNAL_RED_SECONDS;
    if (!Number.isFinite(maxRedSeconds) || maxRedSeconds < DEFAULT_MAX_SIGNAL_RED_SECONDS) {
      throw new RangeError('maxRedSeconds must be a finite number of at least 30 seconds.');
    }
    const yellowSeconds = realisticTraffic ? 3 : SIGNAL_YELLOW_SECONDS;
    const warmupSeconds = realisticTraffic ? BOUNDARY_WARMUP_SECONDS : STARTUP_WARMUP_SECONDS;
    const bikeProfile = realisticTraffic
      ? { ...VEHICLE_PROFILES.bike, majorSpeed: 10, localSpeed: 8, acceleration: 2.5 }
      : VEHICLE_PROFILES.bike;
    const streets = new Map();
    const adjacency = new Map();
    const nodeIncident = new Map();
    data.nodes.forEach((node) => {
      adjacency.set(node.id, []);
      nodeIncident.set(node.id, []);
    });

    data.streets.forEach((source) => {
      const fromNode = nodes.get(source.from);
      const toNode = nodes.get(source.to);
      if (!fromNode || !toNode) return;
      const dx = toNode.x - fromNode.x;
      const dy = toNode.y - fromNode.y;
      const road = {
        id: source.id,
        from: source.from,
        to: source.to,
        major: Boolean(source.major),
        oneWay: Boolean(source.oneWay),
        flyover: Boolean(source.flyover),
        lanes: Math.max(1, finiteNumber(source.lanes, 2)),
        length: Math.max(40, Math.hypot(dx, dy)),
        manualClosed: false,
        workVehicleId: null,
        breakdown: false,
        manualBreakdown: false,
        breakdownPassage: null,
        lastEnteredAt: [-Infinity, -Infinity],
        bikeOnly: false,
        surfaceWeather: 'clear'
      };
      streets.set(road.id, road);
      adjacency.get(road.from).push({ streetId: road.id, reverse: false, nodeId: road.to });
      if (!road.oneWay) adjacency.get(road.to).push({ streetId: road.id, reverse: true, nodeId: road.from });
      nodeIncident.get(road.from).push(road.id);
      nodeIncident.get(road.to).push(road.id);
    });

    adjacency.forEach((edges) => edges.sort((a, b) => a.streetId.localeCompare(b.streetId)));

    const rawSignalDefs = Array.isArray(data.signals) ? data.signals : [];
    const controlledNodes = new Map();
    rawSignalDefs.forEach((signal) => {
      const road = streets.get(signal.streetId);
      if (!road) return;
      const reverse = Boolean(signal.reverse);
      if (road.oneWay && reverse) return;
      const nodeId = reverse ? road.from : road.to;
      if (!controlledNodes.has(nodeId)) controlledNodes.set(nodeId, []);
      controlledNodes.get(nodeId).push({
        streetId: road.id,
        reverse,
        color: signal.color === 'green' ? 'green' : signal.color === 'yellow' ? 'yellow' : 'red',
        seconds: clamp(finiteNumber(signal.seconds, 18), 10, 30)
      });
    });

    const crossings = new Map();
    const crossingsByNode = new Map();
    const crossingsByStreet = new Map();
    for (const crossing of Array.isArray(data.pedestrianCrossings) ? data.pedestrianCrossings : []) {
      const road = streets.get(crossing?.streetId);
      if (!road || !crossing.id || crossings.has(crossing.id)) continue;
      const reverse = Boolean(crossing.reverse);
      const nodeId = reverse ? road.from : road.to;
      if (crossing.nodeId !== nodeId || !controlledNodes.has(nodeId) || (reverse && road.oneWay)) continue;
      const definition = { id: crossing.id, nodeId, streetId: road.id, reverse, progress: crossing.progress, halfSpan: crossing.halfSpan };
      crossings.set(definition.id, definition);
      if (!crossingsByNode.has(nodeId)) crossingsByNode.set(nodeId, []);
      crossingsByNode.get(nodeId).push(definition);
      if (!crossingsByStreet.has(road.id)) crossingsByStreet.set(road.id, []);
      crossingsByStreet.get(road.id).push(definition);
    }
    const automaticCrossings = options?.autoPedestrians ? [...crossings.values()] : [];
    const completedPedestrians = new Map();

    const boundaryNodes = data.nodes.filter((node) => isBoundary(node, data)).map((node) => node.id);
    const exitNodes = new Set();
    adjacency.forEach((edges) => edges.forEach((step) => {
      if (boundaryNodes.includes(step.nodeId)) exitNodes.add(step.nodeId);
    }));
    const boundaryGates = realisticTraffic ? makeBoundaryGates() : [];
    const busStops = (data.busStops || []).filter(stop => streets.has(stop.streetId));
    const schools = (data.schools || []).filter(school => streets.has(school.streetId));
    const busServices = (data.busServices || []).filter(service => service.route?.length && service.route.every((leg, index) => {
      const road = streets.get(leg.streetId);
      const previous = index && streets.get(service.route[index - 1].streetId);
      const previousLeg = index && service.route[index - 1];
      return road && !(road.oneWay && leg.reverse) && (!index ||
        (previousLeg.reverse ? previous.from : previous.to) === (leg.reverse ? road.to : road.from));
    })).map(service => ({ ...service, nextAt: 0 }));

    let random = mulberry32(finiteNumber(options && options.seed, 42) >>> 0);
    let craneRandom;
    let cranePlateRandom;
    let busRandom;
    let busPlateCounter = 0;
    let peopleRandom;
    let schoolRandom;
    let nextPersonNumber = 1;
    let schoolCarNumber = 0;
    let stopStates = new Map();
    let schoolStates = new Map();
    let passengerMotions = [];
    let passengerStats = { arrived: 0, boarded: 0, alighted: 0, completed: 0 };
    let automaticCraneRandom;
    let nextAutomaticCrane = Infinity;
    let breakdownRandom;
    let automaticBreakdown = null;
    let nextBreakdownNumber = 1;
    let nextAutomaticBreakdown = Infinity;
    let pedestrianRandom;
    let nextPedestrianArrival = Infinity;
    let nextVehicleNumber = 1;
    let plateCounter = 0;
    let cranePlateCounter = 0;
    let vehicleList = [];
    let completed = [];
    let recentWaitSamples = [];
    let departureTimes = [];
    let events = [];
    let history = [];
    let signalGroups = new Map();
    let clearanceUntil = new Map();
    let totalArrived = 0;
    let totalCompleted = 0;
    let totalCompletedWaitSeconds = 0;
    let nextSpawnIn = 5;
    let nextBoundaryGate = 0;
    let boundaryTripPrefix = '';
    let historyElapsed = 0;
    let time = 0;
    let demandProfileMode = 'steady';
    let demandProfileStartSeconds = START_TIME_OF_DAY_SECONDS;
    let timeOfDaySeconds = START_TIME_OF_DAY_SECONDS;
    let stepRemainder = 0;
    let running = true;
    let speed = 1;
    let weather = 'clear';
    let mode = 'adaptive';
    let demand = 1;
    let customController = null;
    let currentSeed = finiteNumber(options && options.seed, 42) >>> 0;
    let generation = 0;

    function isBoundary(node, mapData) {
      return Boolean(node) && (node.x < 0 || node.y < 0 || node.x > mapData.width || node.y > mapData.height);
    }

    function addEvent(text, type) {
      events.push({ time: rounded(time), text: String(text), type: type || 'info' });
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    }

    function newId() {
      const id = 'V' + String(nextVehicleNumber).padStart(5, '0');
      nextVehicleNumber += 1;
      return id;
    }

    function newPlate(preferred, type) {
      if (preferred && !vehicleList.some((vehicle) => vehicle.plate === preferred) &&
          !completed.some((vehicle) => vehicle.plate === preferred)) return preferred;
      const regions = ['RJ 14', 'RJ 27', 'DL 8C', 'HR 26'];
      const plateRandom = type === 'crane' ? cranePlateRandom : type === 'bus' ? busRandom : random;
      let plate;
      do {
        const plateNumber = type === 'crane' ? ++cranePlateCounter : type === 'bus' ? ++busPlateCounter : ++plateCounter;
        const letters = String.fromCharCode(65 + Math.floor(plateRandom() * 26), 65 + Math.floor(plateRandom() * 26));
        const digits = String(1000 + Math.floor(plateRandom() * 9000));
        plate = regions[plateNumber % regions.length] + ' ' + letters + ' ' + digits;
      } while (vehicleList.some((vehicle) => vehicle.plate === plate) || completed.some((vehicle) => vehicle.plate === plate));
      return plate;
    }

    function roadIsClosed(road) {
      return road.manualClosed || road.workVehicleId !== null;
    }

    function routeAllowed(road, type, vehicleId) {
      if (vehicleId && road.workVehicleId === vehicleId) return true;
      return !roadIsClosed(road) && (!road.bikeOnly || type === 'bike');
    }

    function edgeCost(road, type, reverse) {
      const speed = cruiseSpeed(type, road);
      if (!laneHasBreakdown(road, reverse)) return road.length / speed;
      const gate = road.breakdownPassage.gate;
      const bypassDistance = (gate.end - gate.start) * road.length;
      return (road.length - bypassDistance) / speed + bypassDistance / (speed * breakdownSpeedFactor(type)) + 8;
    }

    function findRoute(startNode, destinationNode, type, avoidStreetId, routePenalty, vehicleId) {
      if (!nodes.has(startNode) || !nodes.has(destinationNode)) return null;
      if (startNode === destinationNode) return [];
      const distances = new Map([[startNode, 0]]);
      const previous = new Map();
      const open = new Set(nodes.keys());
      while (open.size) {
        let current = null;
        let best = Infinity;
        open.forEach((nodeId) => {
          const distance = distances.has(nodeId) ? distances.get(nodeId) : Infinity;
          if (distance < best) {
            best = distance;
            current = nodeId;
          }
        });
        if (current === null || !Number.isFinite(best)) break;
        open.delete(current);
        if (current === destinationNode) break;
        if (current !== startNode && isBoundaryId(current)) continue;
        adjacency.get(current).forEach((step) => {
          if (!open.has(step.nodeId)) return;
          const road = streets.get(step.streetId);
          if (!road || road.id === avoidStreetId || !routeAllowed(road, type, vehicleId)) return;
          const penalty = routePenalty ? routePenalty(road, step.reverse) : 0;
          const candidate = best + edgeCost(road, type, step.reverse) + penalty;
          if (candidate < (distances.has(step.nodeId) ? distances.get(step.nodeId) : Infinity)) {
            distances.set(step.nodeId, candidate);
            previous.set(step.nodeId, { from: current, step: { streetId: step.streetId, reverse: step.reverse } });
          }
        });
      }
      if (!previous.has(destinationNode)) return null;
      const route = [];
      let current = destinationNode;
      while (current !== startNode) {
        const record = previous.get(current);
        if (!record) return null;
        route.push(record.step);
        current = record.from;
      }
      route.reverse();
      return route;
    }

    function findRouteViaStreet(startNode, destinationNode, type, waypoint, routePenalty) {
      const { road, reverse } = waypoint;
      const entryNode = reverse ? road.to : road.from;
      const exitNode = reverse ? road.from : road.to;
      if (isBoundaryId(entryNode) && entryNode !== startNode) return null;
      if (isBoundaryId(exitNode) && exitNode !== destinationNode) return null;
      const prefix = findRoute(startNode, entryNode, type, road.id, routePenalty);
      const suffix = findRoute(exitNode, destinationNode, type, road.id, routePenalty);
      if (!prefix || !suffix) return null;
      return joinWaypointRoute(startNode, exitNode, prefix, waypoint, suffix);
    }

    function joinWaypointRoute(startNode, exitNode, prefix, waypoint, suffix) {
      const visited = new Set([startNode, ...prefix.map(routeEndNode)]);
      if (visited.has(exitNode) || suffix.some((leg) => visited.has(routeEndNode(leg)))) return null;
      return prefix.concat({ streetId: waypoint.road.id, reverse: waypoint.reverse }, suffix);
    }

    function chooseDestination(startNode, type, avoidNode, avoidStreetId, routing) {
      const candidates = [...exitNodes].filter((id) => id !== startNode && id !== avoidNode);
      const first = Math.floor(random() * candidates.length);
      for (let offset = 0; offset < candidates.length; offset += 1) {
        const destination = candidates[(first + offset) % candidates.length];
        const penalty = routing?.penalty;
        const route = findRoute(startNode, destination, type, avoidStreetId, penalty);
        if (!route?.length) continue;
        if (routing && random() < WAYPOINT_ROUTE_SHARE) {
          const { routeCost } = routing;
          const budget = routeCost(route) * 1.25 + 10;
          for (const waypoint of routing.waypoints) {
            if (route.some((leg) => leg.streetId === waypoint.road.id && leg.reverse === waypoint.reverse)) continue;
            const via = findRouteViaStreet(startNode, destination, type, waypoint, penalty);
            if (via && routeCost(via) <= budget) {
              return { destination, route: via };
            }
          }
        }
        return { destination, route };
      }
      return null;
    }

    function travelPosition(vehicle) {
      return vehicle.reverse ? 1 - vehicle.progress : vehicle.progress;
    }

    function geometricProgress(reverse, travel) {
      return reverse ? 1 - travel : travel;
    }

    function routeEndNode(leg) {
      const road = streets.get(leg.streetId);
      if (!road) return null;
      return leg.reverse ? road.from : road.to;
    }

    function makeVehicle(config) {
      const now = time;
      const leg = config.route[0];
      return {
        id: newId(),
        plate: newPlate(config.plate, config.type),
        type: config.type,
        ...(config.type === 'bus' && { bus: { serviceId: config.serviceId || null, serviceName: config.serviceName || 'City service',
          stage: 'travelling', stopId: null, endsAt: null, passengerSeconds: 0, servedStops: [], passengers: [],
          boardedHere: 0, alightedHere: 0 } }),
        streetId: leg.streetId,
        progress: clamp(finiteNumber(config.progress, leg.reverse ? 1 : 0), 0, 1),
        reverse: Boolean(leg.reverse),
        waiting: false,
        waitingReason: null,
        motionSpeed: 0,
        departureReadyAt: null,
        route: config.route.map((item) => ({ streetId: item.streetId, reverse: Boolean(item.reverse) })),
        routeIndex: 0,
        closureDetour: null,
        waitTime: 0,
        runWaitTime: 0,
        currentStopSeconds: 0,
        destination: config.destination,
        startedAt: now,
        distanceTravelled: 0,
        lastEvent: 0
      };
    }

    function routeForOnStreet(streetId, reverse, type, destination) {
      const road = streets.get(streetId);
      if (!road || (road.oneWay && reverse)) return null;
      const endNode = reverse ? road.from : road.to;
      if (isBoundaryId(endNode)) return { destination: endNode, route: [{ streetId, reverse }] };
      let finalDestination = destination;
      let route = finalDestination ? findRoute(endNode, finalDestination, type) : null;
      if (!route || !route.length && finalDestination !== endNode) {
        const choice = chooseDestination(endNode, type, reverse ? road.to : road.from, streetId);
        if (!choice) return null;
        finalDestination = choice.destination;
        route = choice.route;
      }
      return { destination: finalDestination, route: [{ streetId, reverse }, ...(route || [])] };
    }

    function nearestCraneExit(nodeId, vehicleId) {
      if (isBoundaryId(nodeId)) return { destination: nodeId, route: [] };
      let nearest = null;
      let leastTravelTime = Infinity;
      for (const destination of exitNodes) {
        const route = findRoute(nodeId, destination, 'crane', null, null, vehicleId);
        if (!route) continue;
        const travelTime = route.reduce((sum, leg) => sum + edgeCost(streets.get(leg.streetId), 'crane', leg.reverse), 0);
        if (travelTime < leastTravelTime) {
          nearest = { destination, route };
          leastTravelTime = travelTime;
        }
      }
      return nearest;
    }

    function adjacentCraneWork(road, reverse) {
      const endNode = reverse ? road.from : road.to;
      if (isBoundaryId(endNode)) return null;
      let best = null;
      let bestCost = Infinity;
      for (const next of adjacency.get(endNode)) {
        const candidate = streets.get(next.streetId);
        if (candidate === road || !routeAllowed(candidate, 'crane')) continue;
        const cost = edgeCost(candidate, 'crane', next.reverse);
        if (cost >= bestCost) continue;
        const exit = nearestCraneExit(next.nodeId);
        if (!exit) continue;
        best = { destination: exit.destination, route: [{ streetId: next.streetId, reverse: next.reverse }, ...exit.route] };
        bestCost = cost;
      }
      return best;
    }

    function craneDispatch(road, reverse, atEntrance, dispatchRandom) {
      const firstLeg = { streetId: road.id, reverse };
      const first = atEntrance ? nearestCraneExit(routeEndNode(firstLeg)) : null;
      const second = adjacentCraneWork(road, reverse);
      if (!first && !second) return null;
      const immediate = Boolean(first && (!second || dispatchRandom() < 0.5));
      const chosen = immediate ? first : second;
      return { destination: chosen.destination, route: [firstLeg, ...chosen.route], workIndex: Number(!immediate) };
    }

    function roadworkDuration(road) {
      const speed = ROADWORK_SPEED * getWeatherFactor('crane', road.surfaceWeather);
      const seconds = road.length * (1 - ENTRY_PROGRESS) / speed;
      return Math.round(clamp(seconds, MIN_ROADWORK_SECONDS, MAX_ROADWORK_SECONDS) / SIMULATION_STEP_SECONDS) * SIMULATION_STEP_SECONDS;
    }

    function assignRoadwork(vehicle, routeIndex) {
      const { streetId, reverse } = vehicle.route[routeIndex];
      vehicle.roadwork = {
        streetId, reverse, routeIndex, state: 'enroute', duration: roadworkDuration(streets.get(streetId)), progress: 0
      };
    }

    function roadworkApproachProgress(vehicle) {
      const road = streets.get(vehicle.streetId);
      const nodeId = routeEndNode(routeCurrentLeg(vehicle));
      if (signalGroups.has(nodeId)) return vehicleStopProgress(nodeId, road.id, vehicle.reverse);
      return Math.max(0.72, 1 - gapMeters(vehicle) * 0.66 / road.length);
    }

    function reserveRoadwork(vehicle) {
      const work = vehicle.roadwork;
      const road = streets.get(work.streetId);
      if (!routeAllowed(road, 'crane')) return;
      road.workVehicleId = vehicle.id;
      work.state = 'clearing';
      work.lastClearanceMovementAt = time;
      addEvent(road.id + ' closed for crane roadwork. Vehicles already on the street can leave.', 'warning');
      rerouteAfterRoadChange(road.id);
    }

    function roadworkOccupants(vehicle) {
      const streetId = vehicle.roadwork.streetId;
      return vehicleList.filter((other) => other !== vehicle && other.streetId === streetId);
    }

    function startRoadwork(vehicle, startedAt = time) {
      const work = vehicle.roadwork;
      work.state = 'working';
      work.duration = roadworkDuration(streets.get(work.streetId));
      work.startedAt = startedAt;
      vehicle.motionSpeed = 0;
      addEvent('Mobile crane ' + vehicle.plate + ' started work on ' + work.streetId + '.', 'info');
    }

    function endRoadwork(vehicle, state, endedAt = time) {
      const work = vehicle.roadwork;
      const road = streets.get(work.streetId);
      const ownedClosure = road.workVehicleId === vehicle.id;
      if (ownedClosure) road.workVehicleId = null;
      work.state = state;
      work.endedAt = endedAt;
      const result = state === 'finished' ? 'Crane work completed on '
        : state === 'incomplete' ? 'Crane work reached its 30-second limit on ' : 'Crane work cancelled on ';
      const roadStatus = ownedClosure ? (road.manualClosed ? ' It remains manually closed.' : ' The work closure has lifted.') : '';
      addEvent(result + road.id + '.' + roadStatus, state === 'finished' ? 'success' : 'warning');
      if (ownedClosure && !road.manualClosed) rerouteAfterRoadChange();
    }

    function prepareRoadworks() {
      for (const vehicle of vehicleList) {
        const work = vehicle.roadwork;
        if (!work) continue;
        if (work.state === 'enroute' && travelPosition(vehicle) >= roadworkApproachProgress(vehicle) - EPSILON) {
          reserveRoadwork(vehicle);
        }
        if (work.state !== 'clearing') continue;
        const occupants = roadworkOccupants(vehicle);
        if (!occupants.length && vehicle.streetId === work.streetId) {
          startRoadwork(vehicle);
        } else if (occupants.some((other) => other.motionSpeed > EPSILON)) {
          work.lastClearanceMovementAt = time;
        } else if (occupants.length && time - work.lastClearanceMovementAt >= MAX_STALLED_CLEARANCE_SECONDS) {
          endRoadwork(vehicle, 'cancelled');
        }
      }
    }

    function seededVehicle(streetId, progress, reverse, type, preferredPlate, destination) {
      const built = routeForOnStreet(streetId, reverse, type, destination);
      if (!built) return null;
      return makeVehicle({
        type,
        route: built.route,
        destination: built.destination,
        progress,
        plate: preferredPlate
      });
    }

    function createSignalGroups() {
      signalGroups = new Map();
      controlledNodes.forEach((definitions, nodeId) => {
        const approaches = [];
        nodeIncident.get(nodeId).forEach((streetId) => {
          const road = streets.get(streetId);
          if (road.to === nodeId) approaches.push({ streetId, reverse: false });
          if (road.from === nodeId && !road.oneWay) approaches.push({ streetId, reverse: true });
        });
        const unique = new Map();
        approaches.forEach((approach) => unique.set(approachKey(approach), approach));
        const ordered = Array.from(unique.values()).sort((a, b) => a.streetId.localeCompare(b.streetId) || Number(a.reverse) - Number(b.reverse));
        const phases = compatibleSignalPhases(nodeId, ordered);
        const greenDef = definitions.find((definition) => definition.color === 'green');
        const greenKey = greenDef ? approachKey(greenDef) : null;
        let phaseIndex = phases.findIndex((phase) => phase.some((approach) => approachKey(approach) === greenKey));
        if (phaseIndex < 0) phaseIndex = 0;
        const dataGreenSeconds = greenDef ? greenDef.seconds : 16;
        const group = {
          nodeId,
          approaches: ordered,
          phases,
          stage: 'green',
          active: phases[phaseIndex] && phases[phaseIndex].length ? approachKey(phases[phaseIndex][0]) : null,
          remaining: clamp(dataGreenSeconds, 10, 30),
          phaseIndex,
          greenSeconds: clamp(dataGreenSeconds, 10, 30),
          plannedDurations: new Map(ordered.map((approach) => [approachKey(approach), 18])),
          waitingPedestrians: [],
          walkingPedestrians: [],
          greensUntilWalk: 0,
          phaseRedAt: phases.map(() => time)
        };
        if (greenKey) group.plannedDurations.set(greenKey, group.greenSeconds);
        group.greenSeconds = phaseGreenDuration(group, phaseIndex);
        group.remaining = group.greenSeconds;
        signalGroups.set(nodeId, group);
      });
    }

    function compatibleSignalPhases(nodeId, approaches) {
      const plans = {
        k2: [['S2:0', 'S3:1', 'S35:1'], ['S18:0', 'S19:1']],
        k3: [['S3:0', 'S4:1'], ['S24:1']],
        h2: [['S6:0', 'S7:1'], ['S22:0', 'S23:1'], ['S30:1', 'S34:1']],
        h3: [['S7:0', 'S8:1'], ['S27:0', 'S28:1']],
        q2: [['S12:1'], ['S20:0', 'S21:1']],
        l2: [['S9:0', 'S32:0', 'S36:1'], ['S17:0', 'S18:1']],
        l3: [['S36:0'], ['S37:1', 'S40:0']],
        m4: [['S42:0', 'S43:1'], ['S44:0', 'S46:0']]
      };
      const byKey = new Map(approaches.map((approach) => [approachKey(approach), approach]));
      const assigned = new Set();
      const phases = (plans[nodeId] || []).map((plan) => plan
        .map((key) => byKey.get(key))
        .filter((approach) => {
          if (!approach || assigned.has(approachKey(approach))) return false;
          assigned.add(approachKey(approach));
          return true;
        })).filter((phase) => phase.length);
      approaches.forEach((approach) => {
        const key = approachKey(approach);
        if (!assigned.has(key)) phases.push([approach]);
      });
      if (phases.length > 3) {
        throw new Error('Signal node ' + nodeId + ' has too many non-compatible phases; at most three are supported.');
      }
      return phases;
    }

    function approachKey(approach) {
      return approach.streetId + ':' + (approach.reverse ? '1' : '0');
    }

    function isInActivePhase(group, key) {
      const phase = group.phases[group.phaseIndex] || [];
      return phase.some((approach) => approachKey(approach) === key);
    }

    function maximumGreenDuration(group, pedestrianDelay) {
      const transitions = Math.max(0, group.phases.length - 1);
      if (!transitions) return 30;
      const pedestrianClearance = pedestrianDelay ? PEDESTRIAN_WALK_SECONDS + SIGNAL_ALL_RED_SECONDS : 0;
      const fixedWait = SIGNAL_ALL_RED_SECONDS + transitions * (yellowSeconds + SIGNAL_ALL_RED_SECONDS) + pedestrianClearance;
      return Math.max(0, (maxRedSeconds - fixedWait - RED_CAP_MARGIN_SECONDS) / transitions);
    }

    function phaseGreenDuration(group, phaseIndex, pedestrianDelay) {
      const phase = group.phases[phaseIndex] || [];
      const desired = phase.reduce((longest, approach) => Math.max(longest, group.plannedDurations.get(approachKey(approach)) || 18), 0);
      return Math.min(desired || 18, maximumGreenDuration(group, pedestrianDelay ?? needsWalkBudget(group)));
    }

    function needsWalkBudget(group) {
      return group.greensUntilWalk > 0 || group.waitingPedestrians.length > 0;
    }

    function signalLayout(nodeId, streetId, reverse) {
      const layouts = data.signalLayouts;
      if (!layouts) return null;
      const id = nodeId + ':' + streetId + ':' + (reverse ? '1' : '0');
      if (typeof layouts.get === 'function') return layouts.get(id) || null;
      if (Array.isArray(layouts)) return layouts.find((layout) => layout && layout.id === id) || null;
      return layouts[id] || null;
    }

    function vehicleStopProgress(nodeId, streetId, reverse) {
      const layout = signalLayout(nodeId, streetId, reverse);
      const value = layout && finiteNumber(layout.vehicleStopProgress, NaN);
      return Number.isFinite(value) ? clamp(value, 0, 1) : 0.8;
    }

    function setNextGreen(group) {
      if (!group.phases.length) return;
      const served = group.phases[group.phaseIndex] || [];
      group.greensUntilWalk = Math.max(0, group.greensUntilWalk - 1);
      group.phaseIndex = (group.phaseIndex + 1) % group.phases.length;
      const nextPhase = group.phases[group.phaseIndex] || [];
      group.active = nextPhase.length ? approachKey(nextPhase[0]) : null;
      group.stage = 'green';
      group.greenSeconds = phaseGreenDuration(group, group.phaseIndex);
      group.remaining = group.greenSeconds;
      served.forEach((approach) => group.plannedDurations.set(approachKey(approach), chooseGreenDuration(group, approach)));
    }

    function chooseGreenDuration(group, approach) {
      const approachQueue = approach ? vehicleList.filter((vehicle) => vehicle.streetId === approach.streetId &&
        vehicle.reverse === approach.reverse && vehicle.waiting && vehicle.waitingReason !== 'breakdown' &&
        vehicle.waitingReason !== 'bus-stop' && vehicle.waitingReason !== 'school-stop') : [];
      const queued = approachQueue.length;
      if (mode === 'custom' && customController) {
        try {
          const maxGreen = maximumGreenDuration(group, needsWalkBudget(group));
          const minGreen = Math.min(10, maxGreen);
          const result = customController(getObservation({
            nodeId: group.nodeId,
            streetId: approach && approach.streetId,
            reverse: Boolean(approach && approach.reverse),
            minGreen,
            maxGreen
          }));
          const hold = finiteNumber(result && result.holdSeconds, maxGreen);
          return clamp(hold, minGreen, maxGreen);
        } catch (error) {
          addEvent('Custom controller error; using basic timing.', 'warning');
          return clamp(10 + queued * 2 + demand * 2, 10, 30);
        }
      }
      if (mode === 'fixed') return 18;
      const bikeQueue = approachQueue.filter((vehicle) => vehicle.type === 'bike').length;
      const approachRoad = approach && streets.get(approach.streetId);
      const wetBikeBoost = approachRoad && approachRoad.surfaceWeather === 'wet' ? Math.min(3, bikeQueue * 1.2) : 0;
      const balance = Math.min(8, queued * 1.7) + demand * 2 + wetBikeBoost;
      return clamp((realisticTraffic ? 10 : 12) + balance, 10, 30);
    }

    function planInitialSignalDurations() {
      signalGroups.forEach((group) => {
        group.approaches.forEach((approach) => {
          const key = approachKey(approach);
          if (!isInActivePhase(group, key)) group.plannedDurations.set(key, chooseGreenDuration(group, approach));
        });
      });
    }

    function replanUnservedGreens() {
      signalGroups.forEach((group) => {
        group.approaches.forEach((approach) => {
          const key = approachKey(approach);
          if (group.stage === 'green' && isInActivePhase(group, key)) return;
          group.plannedDurations.set(key, chooseGreenDuration(group, approach));
        });
      });
    }

    function advanceSignals(dt) {
      signalGroups.forEach((group) => {
        let remainingDt = dt;
        let guard = 0;
        while (remainingDt > EPSILON && guard++ < 8) {
          if (group.remaining > remainingDt + EPSILON) {
            group.remaining -= remainingDt;
            remainingDt = 0;
            break;
          }
          remainingDt = Math.max(0, remainingDt - Math.max(0, group.remaining));
          if (group.stage === 'green') {
            group.stage = 'yellow';
            group.remaining = yellowSeconds;
          } else if (group.stage === 'yellow') {
            group.stage = 'allred';
            group.remaining = SIGNAL_ALL_RED_SECONDS;
            group.phaseRedAt[group.phaseIndex] = time + dt - remainingDt;
          } else if (group.stage === 'allred') {
            const transitionAt = time + dt - remainingDt;
            const ready = !group.greensUntilWalk && group.waitingPedestrians.length &&
              pedestrianWalkFitsRedLimit(group, group.phaseIndex, group.phaseRedAt, transitionAt)
              ? group.waitingPedestrians.filter(pedestriansCanCross) : [];
            if (ready.length) {
              group.stage = 'walk';
              group.remaining = PEDESTRIAN_WALK_SECONDS;
              group.walkingPedestrians = ready;
              group.waitingPedestrians = group.waitingPedestrians.filter((item) => !ready.includes(item));
              // Let every vehicle phase run before inserting another WALK.
              group.greensUntilWalk = group.phases.length;
            } else {
              setNextGreen(group);
            }
          } else if (group.stage === 'walk') {
            const served = countPedestrians(group.walkingPedestrians);
            for (const { crossingId, count } of group.walkingPedestrians) {
              if (crossingId) completedPedestrians.set(crossingId, (completedPedestrians.get(crossingId) || 0) + count);
            }
            group.walkingPedestrians = [];
            if (served) addEvent(served + ' pedestrian' + (served === 1 ? '' : 's') + ' crossed safely.', 'success');
            group.stage = 'allred';
            group.remaining = SIGNAL_ALL_RED_SECONDS;
          } else {
            setNextGreen(group);
          }
        }
      });
    }

    function countPedestrians(cohort) {
      return cohort.reduce((sum, item) => sum + item.count, 0);
    }

    function crossingBounds(crossing, road, reverse, type) {
      if (!crossing || !Number.isFinite(crossing.progress) || !Number.isFinite(crossing.halfSpan)) return null;
      const center = crossing.reverse === reverse ? crossing.progress : 1 - crossing.progress;
      const halfWidth = crossing.halfSpan + VEHICLE_PROFILES[type].halfLength / road.length;
      return { start: center - halfWidth, end: center + halfWidth };
    }

    function insideCrossing(position, bounds) {
      return bounds && position > bounds.start + EPSILON && position < bounds.end - EPSILON;
    }

    function pedestriansCanCross(item) {
      const crossing = crossings.get(item.crossingId);
      if (!crossing) return true;
      const road = streets.get(crossing.streetId);
      return !vehicleList.some((vehicle) => vehicle.streetId === road.id && insideCrossing(travelPosition(vehicle),
        crossingBounds(crossing, road, vehicle.reverse, vehicle.type)));
    }

    function reservedCrossings(road, reverse, type) {
      const definitions = crossingsByStreet.get(road.id);
      if (!definitions) return [];
      const reserved = [];
      for (const crossing of definitions) {
        const group = signalGroups.get(crossing.nodeId);
        const duringWalk = group.stage === 'walk';
        const preparingWalk = !group.greensUntilWalk && (group.stage === 'yellow' || group.stage === 'allred');
        if (!duringWalk && !preparingWalk) continue;
        const cohort = duringWalk ? group.walkingPedestrians : group.waitingPedestrians;
        if (!cohort.some((item) => item.crossingId === crossing.id)) continue;
        const bounds = crossingBounds(crossing, road, reverse, type);
        if (bounds) reserved.push({ ...bounds, allowClear: !duringWalk && crossing.reverse === reverse });
      }
      return reserved;
    }

    function getWeatherFactor(type, surfaceWeather) {
      if (surfaceWeather === 'wet') return type === 'bike' ? 0.62 : 0.78;
      if (surfaceWeather === 'snow') return type === 'bike' ? 0.4 : 0.56;
      return 1;
    }

    function isApproachGreen(nodeId, vehicle) {
      const group = signalGroups.get(nodeId);
      return !group || (group.stage === 'green' && isInActivePhase(group, approachKey(vehicle)));
    }

    function canProceedAtSignal(nodeId, vehicle) {
      const group = signalGroups.get(nodeId);
      if (!group) return true;
      if (!isInActivePhase(group, approachKey(vehicle))) return false;
      if (group.stage === 'green') return true;
      return group.stage === 'yellow' && travelPosition(vehicle) > vehicleStopProgress(nodeId, vehicle.streetId, vehicle.reverse) + EPSILON;
    }

    function isBoundaryId(nodeId) {
      return boundaryNodes.includes(nodeId);
    }

    function routeCurrentLeg(vehicle) {
      return vehicle.route[vehicle.routeIndex] || { streetId: vehicle.streetId, reverse: vehicle.reverse };
    }

    function replanVehicle(vehicle) {
      const current = routeCurrentLeg(vehicle);
      const endNode = routeEndNode(current);
      if (!endNode) return false;
      const prefix = vehicle.route.slice(0, vehicle.routeIndex).map((leg) => ({ streetId: leg.streetId, reverse: leg.reverse }));
      const currentLeg = { streetId: current.streetId, reverse: current.reverse };
      // Keep passenger services and school visits on their itinerary through
      // short roadwork closures. Entry checks hold them until the site reopens.
      if ((vehicle.bus?.serviceId || vehicle.school?.state === 'approaching') &&
          vehicle.route.slice(vehicle.routeIndex + 1).every(leg => {
            const road = streets.get(leg.streetId);
            return routeAllowed(road, vehicle.type, vehicle.id) ||
              road.workVehicleId !== null && !road.manualClosed && !road.bikeOnly;
          })) return true;
      if (vehicle.type === 'crane') {
        const work = vehicle.roadwork;
        const leadsToWork = (work?.state === 'enroute' || work?.state === 'clearing') && work.routeIndex > vehicle.routeIndex;
        if (leadsToWork) {
          const workLeg = vehicle.route[work.routeIndex];
          const originalSite = streets.get(work.streetId);
          const exit = routeAllowed(originalSite, 'crane', vehicle.id) ? nearestCraneExit(routeEndNode(workLeg), vehicle.id) : null;
          if (exit) {
            vehicle.destination = exit.destination;
            vehicle.route = prefix.concat(currentLeg, workLeg, exit.route);
            return true;
          }
          const currentRoad = streets.get(current.streetId);
          const alternate = adjacentCraneWork(currentRoad, current.reverse);
          if (alternate) {
            if (work.state === 'clearing') endRoadwork(vehicle, 'cancelled');
            vehicle.destination = alternate.destination;
            vehicle.route = prefix.concat(currentLeg, alternate.route);
            assignRoadwork(vehicle, vehicle.routeIndex + 1);
            addEvent('Mobile crane ' + vehicle.plate + ' reassigned to ' + vehicle.roadwork.streetId + '.', 'info');
            return true;
          }
          // The first crane's closure can lift before the next crane enters the work street.
          if (work.state === 'enroute' && currentRoad.workVehicleId === null &&
              originalSite.workVehicleId !== null && !originalSite.manualClosed && !originalSite.bikeOnly) return true;
          endRoadwork(vehicle, 'cancelled');
        }
        const exit = nearestCraneExit(endNode, vehicle.id);
        if (exit) vehicle.destination = exit.destination;
        vehicle.route = prefix.concat(currentLeg, exit?.route || []);
        return Boolean(exit);
      }
      if (vehicle.destination === endNode && isBoundaryId(endNode)) {
        vehicle.route = prefix.concat([currentLeg]);
        vehicle.routeIndex = prefix.length;
        return true;
      }
      const plan = findRoute(endNode, vehicle.destination, vehicle.type, current.streetId) ||
        findRoute(endNode, vehicle.destination, vehicle.type);
      if (plan) {
        vehicle.route = prefix.concat([currentLeg], plan);
        vehicle.routeIndex = prefix.length;
        return true;
      }
      const sourceNode = current.reverse ? streets.get(current.streetId).to : streets.get(current.streetId).from;
      const alternate = vehicle.boundaryTrip ? null : (chooseDestination(endNode, vehicle.type, sourceNode, current.streetId) ||
        chooseDestination(endNode, vehicle.type));
      if (alternate) {
        vehicle.destination = alternate.destination;
        vehicle.route = prefix.concat([currentLeg], alternate.route);
        vehicle.routeIndex = prefix.length;
        return true;
      }
      vehicle.route = prefix.concat([currentLeg]);
      vehicle.routeIndex = prefix.length;
      return false;
    }

    function validNextLeg(vehicle) {
      const next = vehicle.route[vehicle.routeIndex + 1];
      if (!next) return true;
      const road = streets.get(next.streetId);
      return Boolean(road && routeAllowed(road, vehicle.type, vehicle.id));
    }

    function cruiseSpeed(type, road) {
      const profile = type === 'bike' ? bikeProfile : VEHICLE_PROFILES[type];
      const base = profile[road.major ? 'majorSpeed' : 'localSpeed'];
      return base * getWeatherFactor(type, road.surfaceWeather);
    }

    function breakdownSpeedFactor(type) {
      return type === 'bike' ? 0.53 : 0.42;
    }

    function breakdownGate(road) {
      const signalStop = signalGroups.has(road.to) ? vehicleStopProgress(road.to, road.id, false) : 1;
      const progress = Math.min(0.52, Math.max(0.32, signalStop - Math.min(0.2, 22 / road.length)));
      return breakdownGateAt(road, progress);
    }

    function breakdownGateAt(road, progress) {
      return {
        progress,
        start: Math.max(0.08, progress - Math.min(0.28, 28 / road.length)),
        end: Math.min(0.94, progress + Math.min(0.23, 26 / road.length))
      };
    }

    function laneHasBreakdown(road, reverse) {
      return road.breakdown && road.breakdownPassage.reverse === reverse;
    }

    function gapMeters(vehicle) {
      return VEHICLE_PROFILES[vehicle.type].gap;
    }

    function nextBusStop(vehicle, currentRoadOnly = false) {
      if (!vehicle.bus) return null;
      for (let index = vehicle.routeIndex; index < vehicle.route.length; index++) {
        if (currentRoadOnly && index !== vehicle.routeIndex) break;
        const leg = vehicle.route[index];
        const stop = busStops.find(item => item.streetId === leg.streetId && Boolean(item.reverse) === Boolean(leg.reverse) &&
          !vehicle.bus.servedStops.includes(index + ':' + item.id) &&
          (index !== vehicle.routeIndex || item.progress >= travelPosition(vehicle) - EPSILON));
        if (stop) return { ...stop, routeIndex: index };
      }
      return null;
    }

    function newPassenger() {
      passengerStats.arrived++;
      return { id: 'P' + nextPersonNumber++, child: peopleRandom() < .22, destination: null, reservedBy: null };
    }

    function futureStops(vehicle) {
      return vehicle.route.slice(vehicle.routeIndex).flatMap((leg, offset) => busStops.filter(stop =>
        stop.streetId === leg.streetId && Boolean(stop.reverse) === Boolean(leg.reverse) &&
        (offset || stop.progress > travelPosition(vehicle) + EPSILON)));
    }

    function seedBusPassengers(vehicle) {
      const stops = futureStops(vehicle);
      for (let index = 0, count = 3 + Math.floor(peopleRandom() * 4); index < count; index++) {
        const person = newPassenger();
        person.destination = stops.length ? stops[Math.floor(peopleRandom() * stops.length)].id : 'exit';
        vehicle.bus.passengers.push(person);
      }
    }

    function beginBusExchange(vehicle, stop, at) {
      const bus = vehicle.bus;
      const platform = stopStates.get(stop.id);
      const alighting = bus.passengers.filter(person => person.destination === stop.id);
      const available = Math.max(0, 24 - bus.passengers.length + alighting.length);
      const boarding = (platform?.waiting || []).filter(person => !person.reservedBy).slice(0, Math.min(8, available));
      const destinations = futureStops(vehicle).filter(item => item.id !== stop.id);
      bus.boardedHere = 0;
      bus.alightedHere = 0;
      let lastEnd = at + 2;
      alighting.forEach((person, index) => {
        const startsAt = at + .5 + index * .35;
        const motion = { id: person.id, person, kind: 'alighting', stopId: stop.id, vehicleId: vehicle.id,
          slot: index % 12, startsAt, endsAt: startsAt + 2.5, started: false };
        passengerMotions.push(motion);
        lastEnd = Math.max(lastEnd, motion.endsAt);
      });
      const boardingAt = lastEnd + .25;
      boarding.forEach((person, index) => {
        person.reservedBy = vehicle.id;
        person.destination = destinations.length && peopleRandom() < .88
          ? destinations[Math.floor(peopleRandom() * destinations.length)].id : 'exit';
        const startsAt = boardingAt + index * .5;
        const motion = { id: person.id, person, kind: 'boarding', stopId: stop.id, vehicleId: vehicle.id,
          slot: person.slot, startsAt, endsAt: startsAt + 2.5, started: false };
        passengerMotions.push(motion);
        lastEnd = Math.max(lastEnd, motion.endsAt);
      });
      bus.stage = 'boarding';
      bus.stopId = stop.id;
      bus.endsAt = Math.max(at + 14 + Math.floor(busRandom() * 9), lastEnd + .5);
      bus.servedStops.push(vehicle.routeIndex + ':' + stop.id);
    }

    function updatePassengers(now) {
      if (options?.autoBuses) for (const [id, state] of stopStates) {
        if (now < state.nextAt) continue;
        if (state.waiting.length < 24) {
          const person = newPassenger();
          person.slot = state.nextSlot++ % 12;
          state.waiting.push(person);
        }
        state.nextAt = now + 22 + peopleRandom() * 28;
      }
      passengerMotions = passengerMotions.filter(motion => {
        if (now + EPSILON < motion.startsAt) return true;
        const vehicle = vehicleList.find(item => item.id === motion.vehicleId);
        if (!motion.started) {
          if (motion.kind === 'boarding') {
            const state = stopStates.get(motion.stopId);
            if (state) state.waiting = state.waiting.filter(person => person.id !== motion.person.id);
          } else if (motion.kind === 'alighting' && vehicle?.bus) {
            vehicle.bus.passengers = vehicle.bus.passengers.filter(person => person.id !== motion.person.id);
          }
          motion.started = true;
        }
        if (now + EPSILON < motion.endsAt) return true;
        if (motion.kind === 'boarding') {
          if (vehicle?.bus) {
            motion.person.reservedBy = null;
            vehicle.bus.passengers.push(motion.person);
            vehicle.bus.boardedHere++;
            passengerStats.boarded++;
          } else passengerStats.completed++;
        } else if (motion.kind === 'alighting') {
          if (vehicle?.bus) vehicle.bus.alightedHere++;
          passengerStats.alighted++;
          motion.kind = 'walking-away';
          motion.startsAt = motion.endsAt;
          motion.endsAt += 4;
          return true;
        } else if (motion.kind === 'walking-away') passengerStats.completed++;
        else if (motion.schoolId) {
          const state = schoolStates.get(motion.schoolId);
          if (state) state.studentsServed++;
        }
        return false;
      });
    }

    function schoolPhase(school) {
      const active = window => {
        const start = parseTimeOfDay(window?.start), end = parseTimeOfDay(window?.end);
        return start !== null && end !== null && timeOfDaySeconds >= start && timeOfDaySeconds < end;
      };
      return active(school.dropoff) ? 'dropoff' : active(school.pickup) ? 'pickup' : 'closed';
    }

    function dispatchSchoolTraffic() {
      if (!options?.schoolTraffic) return;
      for (const school of schools) {
        const state = schoolStates.get(school.id), phase = schoolPhase(school);
        if (phase === 'closed') { state.nextAt = time; continue; }
        if (time < state.nextAt || vehicleList.length >= MAX_VEHICLES ||
            vehicleList.filter(vehicle => vehicle.school?.id === school.id).length >= 5) continue;
        const road = streets.get(school.streetId);
        if (!routeAllowed(road, 'car')) continue;
        const origin = school.origins[Math.floor(schoolRandom() * school.origins.length)];
        const startNode = school.reverse ? road.to : road.from;
        const prefix = findRoute(origin, startNode, 'car', road.id);
        if (!prefix) continue;
        const target = { streetId: road.id, reverse: Boolean(school.reverse) };
        const outlets = [...exitNodes].filter(id => id !== origin).sort((a, b) => a.localeCompare(b));
        const destination = outlets[Math.floor(schoolRandom() * outlets.length)];
        const suffix = findRoute(routeEndNode(target), destination, 'car', road.id);
        if (!suffix) continue;
        const route = prefix.concat(target, suffix), first = route[0];
        if (entrySpace(streets.get(first.streetId), first.reverse, { type: 'car' }, false) !== 'clear') continue;
        const vehicle = makeVehicle({ type: 'car', route, destination, plate: 'RJ 14 SC ' + String(++schoolCarNumber).padStart(4, '0'),
          progress: geometricProgress(first.reverse, ENTRY_PROGRESS) });
        vehicle.school = { id: school.id, name: school.name, phase, state: 'approaching', endsAt: null,
          children: 1 + Math.floor(schoolRandom() * 2) };
        vehicleList.push(vehicle);
        streets.get(first.streetId).lastEnteredAt[Number(first.reverse)] = time;
        totalArrived++;
        state.carsArrived++;
        state.nextAt = time + 22 + schoolRandom() * 13;
        if (school.crossingId && crossings.has(school.crossingId)) requestCrossing(school.crossingId, 1);
      }
    }

    function beginSchoolStop(vehicle, school, at) {
      const visit = vehicle.school;
      visit.state = 'stopped';
      visit.endsAt = at + 5 + Math.floor(schoolRandom() * 5);
      schoolStates.get(school.id).carsServed++;
      for (let index = 0; index < visit.children; index++) passengerMotions.push({ id: 'S' + nextPersonNumber++,
        person: { child: true }, kind: visit.phase === 'pickup' ? 'school-pickup' : 'school-dropoff',
        schoolId: school.id, vehicleId: vehicle.id, slot: index, startsAt: at + .5 + index * .6,
        endsAt: at + 4 + index * .6, started: false });
    }

    function makePassengerSnapshots() {
      return passengerMotions.filter(motion => motion.started).map(motion => ({ id: motion.id, kind: motion.kind,
        stopId: motion.stopId, schoolId: motion.schoolId, vehicleId: motion.vehicleId, slot: motion.slot,
        child: motion.person.child, progress: clamp((time - motion.startsAt) / (motion.endsAt - motion.startsAt), 0, 1) }));
    }

    function makeBusStopSnapshots() {
      return busStops.map(stop => ({ id: stop.id, name: stop.name, streetId: stop.streetId, reverse: stop.reverse,
        waiting: (stopStates.get(stop.id)?.waiting || []).map(person => ({ id: person.id, slot: person.slot, child: person.child })) }));
    }

    function makeSchoolSnapshots() {
      return schools.map(school => ({ id: school.id, name: school.name, streetId: school.streetId,
        phase: options?.schoolTraffic ? schoolPhase(school) : 'closed',
        carsInNetwork: vehicleList.filter(vehicle => vehicle.school?.id === school.id).length,
        carsArrived: schoolStates.get(school.id)?.carsArrived || 0, carsServed: schoolStates.get(school.id)?.carsServed || 0,
        studentsServed: schoolStates.get(school.id)?.studentsServed || 0 }));
    }

    function busSnapshot(vehicle) {
      const bus = vehicle.bus;
      if (!bus) return undefined;
      const stop = busStops.find(item => item.id === bus.stopId);
      const next = nextBusStop(vehicle);
      return { serviceId: bus.serviceId, serviceName: bus.serviceName, stage: bus.stage,
        stopId: bus.stopId, stopName: stop?.name || null,
        remaining: bus.stage === 'boarding' ? rounded(Math.max(0, bus.endsAt - time)) : 0,
        passengerSeconds: rounded(bus.passengerSeconds), stopsCompleted: bus.servedStops.length,
        onboard: bus.passengers.length, capacity: 24, boardedHere: bus.boardedHere, alightedHere: bus.alightedHere,
        nextStopId: next?.id || null, nextStopName: next?.name || null, nextStopStreetId: next?.streetId || null,
        nextStopWaiting: next ? stopStates.get(next.id)?.waiting.length || 0 : 0 };
    }

    function dispatchScheduledBuses() {
      if (!options?.autoBuses) return;
      for (const service of busServices.slice().sort((a, b) => a.nextAt - b.nextAt)) {
        if (time + EPSILON < service.nextAt) continue;
        if (vehicleList.length >= MAX_VEHICLES || vehicleList.filter(v => v.type === 'bus').length >= Math.min(10, busServices.length + 2) ||
            vehicleList.filter(v => v.bus?.serviceId === service.id).length >= 2) continue;
        const first = service.route[0];
        const road = streets.get(first.streetId);
        if (!service.route.every(leg => routeAllowed(streets.get(leg.streetId), 'bus')) ||
            entrySpace(road, first.reverse, { type: 'bus' }, false) !== 'clear') continue;
        const vehicle = makeVehicle({ type: 'bus', route: service.route, destination: routeEndNode(service.route.at(-1)),
          progress: geometricProgress(first.reverse, ENTRY_PROGRESS), serviceId: service.id, serviceName: service.name });
        seedBusPassengers(vehicle);
        vehicleList.push(vehicle);
        road.lastEnteredAt[Number(first.reverse)] = time;
        totalArrived++;
        service.nextAt = Math.max(service.nextAt + Math.max(60, service.headway || 180), time + 30);
        addEvent(service.name + ' bus entered the network.', 'info');
      }
    }

    function followingGap(vehicleType, leaderType) {
      return leaderType ? Math.max(gapMeters({ type: vehicleType }), gapMeters({ type: leaderType })) : gapMeters({ type: vehicleType });
    }

    function junctionTurnSpeed(vehicle, incoming, outgoing, reverse) {
      const junction = nodes.get(vehicle.reverse ? incoming.from : incoming.to);
      const origin = nodes.get(vehicle.reverse ? incoming.to : incoming.from);
      const destination = nodes.get(reverse ? outgoing.from : outgoing.to);
      const ax = junction.x - origin.x, ay = junction.y - origin.y;
      const bx = destination.x - junction.x, by = destination.y - junction.y;
      const cosine = (ax * bx + ay * by) / Math.max(1, Math.hypot(ax, ay) * Math.hypot(bx, by));
      // Straight movements keep their road speed. Tight bends require slower turns.
      if (cosine > 0.9) return Infinity;
      const factor = vehicle.type === 'crane' ? 0.6 : 1;
      return (cosine < -0.5 ? 3 : cosine < 0.5 ? 5 : 7) * factor *
        Math.min(getWeatherFactor(vehicle.type, incoming.surfaceWeather), getWeatherFactor(vehicle.type, outgoing.surfaceWeather));
    }

    function turningSpeedLimit(vehicle, road, braking) {
      let speed = Infinity;
      const next = vehicle.route[vehicle.routeIndex + 1];
      if (next) {
        const outgoing = streets.get(next.streetId);
        const turnSpeed = junctionTurnSpeed(vehicle, road, outgoing, next.reverse);
        const distance = Math.max(0, (1 - travelPosition(vehicle)) * road.length - 8);
        speed = Math.sqrt(turnSpeed ** 2 + 2 * braking * distance);
      }
      const previous = vehicle.route[vehicle.routeIndex - 1];
      if (previous && travelPosition(vehicle) * road.length < 12) {
        const incoming = streets.get(previous.streetId);
        const incomingVehicle = { type: vehicle.type, reverse: previous.reverse };
        speed = Math.min(speed, junctionTurnSpeed(incomingVehicle, incoming, road, vehicle.reverse));
      }
      return speed;
    }

    function breakdownBypass(vehicle) {
      const passage = streets.get(vehicle.streetId)?.breakdownPassage;
      if (!passage || passage.reverse !== vehicle.reverse || !passage.passing.has(vehicle.id)) return 0;
      const { start, progress, end } = passage.gate;
      const position = travelPosition(vehicle);
      const amount = Math.min((position - start) / (progress - start), (end - position) / (end - progress));
      const fraction = clamp(amount, 0, 1);
      return fraction * fraction * (3 - 2 * fraction);
    }

    function entrySpace(road, reverse, vehicle, clearJunction) {
      if (vehicle.roadwork?.state === 'clearing' && road.workVehicleId === vehicle.id && roadworkOccupants(vehicle).length) return 'blocked';
      const extraSpace = clearJunction ? Math.min(JUNCTION_CLEARANCE_METERS + VEHICLE_PROFILES[vehicle.type].halfLength, road.length * 0.25) : 0;
      const clearAt = ENTRY_PROGRESS + extraSpace / road.length;
      if (reservedCrossings(road, reverse, vehicle.type).some((bounds) =>
        clearAt > bounds.start + EPSILON && ENTRY_PROGRESS < bounds.end - EPSILON)) return 'blocked';
      if (clearJunction) {
        const downstream = reverse ? road.from : road.to;
        if (!isApproachGreen(downstream, { streetId: road.id, reverse }) &&
            vehicleStopProgress(downstream, road.id, reverse) < clearAt - EPSILON) return 'spillback';
        if (laneHasBreakdown(road, reverse) && road.breakdownPassage.gate.start < clearAt - EPSILON) return 'spillback';
      }
      const occupied = vehicleList.some((other) => {
        if (other === vehicle || other.streetId !== road.id || other.reverse !== reverse) return false;
        const position = travelPosition(other);
        const need = followingGap(vehicle.type, other.type) / road.length;
        return position <= clearAt + need - EPSILON;
      });
      return occupied ? 'spillback' : 'clear';
    }

    function hasSpaceAtStart(road, reverse, vehicle) {
      return entrySpace(road, reverse, vehicle, false) === 'clear';
    }

    function roadEntryState(road, reverse, vehicle) {
      const work = vehicle.roadwork;
      if ((work?.state === 'enroute' && work.streetId === road.id) || !routeAllowed(road, vehicle.type, vehicle.id)) return 'blocked';
      return entrySpace(road, reverse, vehicle, realisticTraffic);
    }

    function nextRoadEntryState(vehicle) {
      const next = vehicle.route[vehicle.routeIndex + 1];
      const road = next && streets.get(next.streetId);
      return road ? roadEntryState(road, next.reverse, vehicle) : 'blocked';
    }

    function findInsertionPosition(road, reverse, type) {
      const nodeId = reverse ? road.from : road.to;
      const isControlledRed = signalGroups.has(nodeId) && !isApproachGreen(nodeId, { streetId: road.id, reverse });
      let maximumTravel = isControlledRed ? vehicleStopProgress(nodeId, road.id, reverse) : 0.975;
      if (laneHasBreakdown(road, reverse)) maximumTravel = Math.min(maximumTravel, road.breakdownPassage.gate.start);
      const ordered = vehicleList
        .filter((vehicle) => vehicle.streetId === road.id && vehicle.reverse === reverse)
        .sort((a, b) => travelPosition(a) - travelPosition(b));
      const reserved = reservedCrossings(road, reverse, type).sort((a, b) => a.start - b.start);
      const skipCrossings = (position) => reserved.reduce((next, bounds) => insideCrossing(next, bounds) ? bounds.end : next, position);
      let candidate = ENTRY_PROGRESS;
      for (const other of ordered) {
        candidate = skipCrossings(candidate);
        const position = travelPosition(other);
        const gap = followingGap(type, other.type) / road.length;
        if (candidate <= maximumTravel && position - candidate >= gap) return candidate;
        candidate = Math.max(candidate, position + gap);
      }
      candidate = skipCrossings(candidate);
      return candidate <= maximumTravel ? candidate : null;
    }

    function finishVehicle(vehicle) {
      if (vehicle.bus) passengerStats.completed += vehicle.bus.passengers.length;
      if (['enroute', 'clearing', 'working'].includes(vehicle.roadwork?.state)) endRoadwork(vehicle, 'cancelled');
      const entry = {
        id: vehicle.id,
        plate: vehicle.plate,
        type: vehicle.type,
        dispatchSource: vehicle.dispatchSource,
        boundaryTrip: vehicle.boundaryTrip,
        route: vehicle.route.slice(0, vehicle.routeIndex + 1)
          .map((item) => ({ streetId: item.streetId, reverse: item.reverse })),
        closureDetour: vehicle.closureDetour,
        roadwork: vehicle.roadwork ? makeRoadworkSnapshot(vehicle) : undefined,
        ...(vehicle.bus && { bus: busSnapshot(vehicle) }),
        ...(vehicle.school && { school: { id: vehicle.school.id, name: vehicle.school.name, phase: vehicle.school.phase,
          state: vehicle.school.state === 'approaching' ? 'unserved' : 'completed', children: vehicle.school.children } }),
        duration: Math.max(0, time - vehicle.startedAt),
        completedAt: time,
        waitTime: vehicle.waitTime,
        runWaitTime: vehicle.runWaitTime
      };
      completed.push(entry);
      if (completed.length > MAX_COMPLETED) completed.splice(0, completed.length - MAX_COMPLETED);
      recentWaitSamples.push({ waitTime: vehicle.waitTime, completedAt: time });
      if (recentWaitSamples.length > AVG_WAIT_TRIP_COUNT) recentWaitSamples.shift();
      totalCompleted += 1;
      totalCompletedWaitSeconds += vehicle.runWaitTime;
      departureTimes.push(time);
      if (departureTimes.length > 500) departureTimes.shift();
      while (departureTimes.length && departureTimes[0] < time - 60) departureTimes.shift();
      vehicleList = vehicleList.filter((candidate) => candidate !== vehicle);
      if (totalCompleted % 5 === 0) {
        const message = totalCompleted + ' journeys completed.';
        addEvent(vehicle.type === 'crane' ? message : 'Traffic departed the network. ' + message, 'success');
      }
    }

    function transitionVehicle(vehicle) {
      const current = routeCurrentLeg(vehicle);
      const nodeId = routeEndNode(current);
      if (!nodeId) return false;
      if (isBoundaryId(nodeId)) {
        finishVehicle(vehicle);
        return true;
      }

      const group = signalGroups.get(nodeId);
      if (group && !canProceedAtSignal(nodeId, vehicle)) return false;
      if (!group) {
        const until = clearanceUntil.get(nodeId) || -Infinity;
        if (time < until) return false;
      }

      if (!validNextLeg(vehicle)) replanVehicle(vehicle);
      let next = vehicle.route[vehicle.routeIndex + 1];
      if (!next && nodeId !== vehicle.destination) {
        const replanned = findRoute(nodeId, vehicle.destination, vehicle.type);
        if (replanned && replanned.length) {
          vehicle.route = vehicle.route.slice(0, vehicle.routeIndex + 1).concat(replanned);
          next = vehicle.route[vehicle.routeIndex + 1];
        }
      }
      if (!next) {
        if (isBoundaryId(nodeId)) {
          finishVehicle(vehicle);
          return true;
        }
        if (!replanVehicle(vehicle)) return false;
        next = vehicle.route[vehicle.routeIndex + 1];
      }
      if (!next) return false;
      const nextRoad = streets.get(next.streetId);
      if (!nextRoad || roadEntryState(nextRoad, next.reverse, vehicle) !== 'clear') return false;

      if (!group) clearanceUntil.set(nodeId, time + 0.35);
      vehicle.routeIndex += 1;
      vehicle.streetId = next.streetId;
      vehicle.reverse = next.reverse;
      vehicle.progress = geometricProgress(next.reverse, ENTRY_PROGRESS);
      vehicle.waiting = false;
      nextRoad.lastEnteredAt[Number(next.reverse)] = time;
      if (nextRoad.workVehicleId === vehicle.id) startRoadwork(vehicle, time + SIMULATION_STEP_SECONDS);
      return true;
    }

    function updateRoads(dt) {
      const laneGroups = new Map();
      vehicleList.forEach((vehicle) => {
        const key = vehicle.streetId + ':' + Number(vehicle.reverse);
        if (!laneGroups.has(key)) laneGroups.set(key, []);
        laneGroups.get(key).push(vehicle);
      });

      laneGroups.forEach((vehiclesInLane) => {
        vehiclesInLane.sort((a, b) => travelPosition(b) - travelPosition(a));
        const road = streets.get(vehiclesInLane[0].streetId);
        if (!road) return;
        const reverse = vehiclesInLane[0].reverse;
        const passage = road.breakdownPassage?.reverse === reverse ? road.breakdownPassage : null;
        const laneBreakdown = laneHasBreakdown(road, reverse);
        let leaderPosition = Infinity;
        let leaderSpeed = 0;
        let leaderType = null;
        let leaderReason = null;
        let leaderSpillback = false;

        for (const vehicle of vehiclesInLane) {
          if (vehicle.brokenDown) {
            // The bypass meters traffic around the stalled car's lane position.
            vehicle.spillback = false;
            vehicle.waitTime += dt;
            vehicle.runWaitTime += dt;
            vehicle.currentStopSeconds += dt;
            continue;
          }
          if (!validNextLeg(vehicle)) replanVehicle(vehicle);
          const start = travelPosition(vehicle);
          const nodeId = vehicle.reverse ? road.from : road.to;
          const work = vehicle.roadwork;
          const working = work?.state === 'working' && work.streetId === road.id;
          const clearing = work?.state === 'clearing' && work.streetId === road.id;
          const signalControlled = signalGroups.has(nodeId);
          const mayProceed = canProceedAtSignal(nodeId, vehicle);
          const entryState = working || isBoundaryId(nodeId) ? 'clear' : nextRoadEntryState(vehicle);
          const canClear = entryState === 'clear';
          const busStop = vehicle.bus?.stage === 'travelling' ? nextBusStop(vehicle, true) : null;
          const school = vehicle.school && schools.find(item => item.id === vehicle.school.id);
          const schoolStop = school && vehicle.school.state === 'approaching' && road.id === school.streetId &&
            vehicle.reverse === Boolean(school.reverse) && school.progress >= start - EPSILON ? school : null;
          let limit = 1;
          let limitSpeed = 0;
          let limitReason = null;
          let limitSpillback = false;

          if (signalControlled && (!mayProceed || !canClear)) {
            limit = vehicleStopProgress(nodeId, road.id, vehicle.reverse);
            limitReason = mayProceed ? 'traffic' : 'signal';
            limitSpillback = mayProceed && entryState === 'spillback';
          } else if (!signalControlled && !working && (!canClear || time < (clearanceUntil.get(nodeId) ?? -Infinity))) {
            limit = Math.max(0.72, 1 - gapMeters(vehicle) * 0.66 / road.length);
            limitReason = 'traffic';
            limitSpillback = entryState === 'spillback';
          }
          for (const bounds of reservedCrossings(road, vehicle.reverse, vehicle.type)) {
            if (bounds.allowClear && insideCrossing(start, bounds) && !mayProceed && limitReason === 'signal') {
              // Clear the stripes during all-red without entering the intersection.
              limit = Math.min(bounds.end, 1 - 2 * EPSILON);
            } else if (start <= bounds.start + EPSILON && bounds.start < limit) {
              limit = bounds.start;
              limitReason = 'signal';
              limitSpillback = false;
            }
          }
          if (clearing) {
            limit = start;
            limitReason = 'traffic';
            limitSpillback = false;
          }
          if (leaderType) {
            const baseGap = followingGap(vehicle.type, leaderType);
            const movingGap = realisticTraffic ? vehicle.motionSpeed * 0.6 / getWeatherFactor(vehicle.type, road.surfaceWeather) : 0;
            const followingLimit = leaderPosition - (baseGap + movingGap) / road.length;
            if (followingLimit < limit - EPSILON) {
              limit = followingLimit;
              limitSpeed = leaderSpeed;
              limitReason = leaderReason || 'traffic';
              limitSpillback = leaderSpillback;
            }
          }

          if (vehicle.bus) {
            const bus = vehicle.bus;
            if (bus.stage === 'boarding' && time + EPSILON >= bus.endsAt) bus.stage = 'rejoining';
            if (bus.stage === 'boarding') {
              bus.passengerSeconds += dt;
              limit = start;
              limitSpeed = 0;
              limitReason = 'bus-stop';
              limitSpillback = false;
            } else if (bus.stage === 'rejoining') {
              if ((limit - start) * road.length >= 2) {
                bus.stage = 'travelling';
                bus.stopId = null;
                bus.endsAt = null;
              } else {
                limit = start;
                limitSpeed = 0;
                limitReason = 'traffic';
              }
            } else if (busStop && busStop.progress < limit) {
              limit = busStop.progress;
              limitSpeed = 0;
              limitReason = 'bus-stop';
              limitSpillback = false;
            }
          }
          if (vehicle.school?.state === 'stopped') {
            if (time + EPSILON >= vehicle.school.endsAt) vehicle.school.state = 'departing';
            else {
              limit = start;
              limitSpeed = 0;
              limitReason = 'school-stop';
              limitSpillback = false;
            }
          } else if (schoolStop && schoolStop.progress < limit) {
            limit = schoolStop.progress;
            limitSpeed = 0;
            limitReason = 'school-stop';
            limitSpillback = false;
          }

          let passing = passage?.passing.has(vehicle.id);
          let speedLimit = working ? Math.min(road.length * (1 - ENTRY_PROGRESS) / work.duration, cruiseSpeed('car', road) * 0.8)
            : cruiseSpeed(vehicle.type, road);
          if (laneBreakdown && !passing && start < passage.gate.end - EPSILON) {
            const atGate = start >= passage.gate.start - EPSILON;
            const canPass = !passage.passing.size && time >= passage.nextPassAt &&
              limit >= passage.gate.end;
            if (atGate && canPass) {
              passage.passing.add(vehicle.id);
              passing = true;
            } else if (Math.max(start, passage.gate.start) < limit - EPSILON) {
              limit = Math.max(start, passage.gate.start);
              limitSpeed = 0;
              limitReason = 'breakdown';
              limitSpillback = false;
            }
          } else if (passage?.recovering && passage.pending.has(vehicle.id)) {
            if (time >= passage.nextReleaseAt && limit > start + EPSILON) {
              passage.pending.delete(vehicle.id);
              passage.nextReleaseAt = time + BREAKDOWN_RECOVERY_HEADWAY / getWeatherFactor(vehicle.type, road.surfaceWeather);
            } else if (limit > start + EPSILON || limitReason === 'breakdown') {
              limit = start;
              limitSpeed = 0;
              limitReason = 'breakdown';
              limitSpillback = false;
            }
          }
          if (passing && laneBreakdown) speedLimit *= breakdownSpeedFactor(vehicle.type);

          const profile = vehicle.type === 'bike' ? bikeProfile : VEHICLE_PROFILES[vehicle.type];
          const surfaceGrip = realisticTraffic ? getWeatherFactor(vehicle.type, road.surfaceWeather) : 1;
          const acceleration = profile.acceleration * surfaceGrip;
          const braking = profile.braking * surfaceGrip;
          if (realisticTraffic && !working) speedLimit = Math.min(speedLimit, turningSpeedLimit(vehicle, road, braking));
          const metersAvailable = Math.max(0, limit - start) * road.length;
          let desiredSpeed = limitReason
            ? Math.min(speedLimit, Math.sqrt(limitSpeed ** 2 + 2 * braking * metersAvailable))
            : speedLimit;
          let reacting = false;
          if (realisticTraffic && !working && vehicle.waiting && vehicle.currentStopSeconds >= 1 &&
              metersAvailable > EPSILON && desiredSpeed > EPSILON) {
            const closeLeader = leaderType && (leaderPosition - start) * road.length <= 2 * followingGap(vehicle.type, leaderType);
            const leaderStillStopped = closeLeader && leaderSpeed <= EPSILON;
            if (leaderStillStopped) vehicle.departureReadyAt = null;
            else if (vehicle.departureReadyAt === null) {
              const delay = vehicle.type === 'crane' ? 0.9 : vehicle.type === 'bike' ? 0.35 : 0.6;
              vehicle.departureReadyAt = time + delay / surfaceGrip;
            }
            reacting = leaderStillStopped || time + EPSILON < vehicle.departureReadyAt;
            if (reacting) {
              desiredSpeed = 0;
              limitReason = vehicle.waitingReason || 'traffic';
            }
          } else vehicle.departureReadyAt = null;
          const startSpeed = vehicle.motionSpeed;
          const endSpeed = working ? desiredSpeed : clamp(desiredSpeed, Math.max(0, startSpeed - braking * dt), startSpeed + acceleration * dt);
          const intendedDistance = working ? endSpeed * dt : (startSpeed + endSpeed) * dt / 2;
          const distance = Math.min(metersAvailable, intendedDistance);
          let target = Math.min(1, start + distance / road.length);
          let stopped = reacting || Boolean(limitReason && distance >= metersAvailable - EPSILON && limitSpeed <= EPSILON);
          let crossed = false;
          // Reaching a road's endpoint is a transition, not a stationary obstacle.
          const limitedByObstacle = limitReason && distance < intendedDistance - EPSILON;
          vehicle.motionSpeed = stopped ? 0 : limitedByObstacle ? limitSpeed : endSpeed;
          if (busStop && target >= busStop.progress - EPSILON && vehicle.bus.stage === 'travelling') {
            beginBusExchange(vehicle, busStop, time + dt);
            vehicle.motionSpeed = 0;
            limitReason = 'bus-stop';
            stopped = true;
          }
          if (schoolStop && target >= schoolStop.progress - EPSILON && vehicle.school.state === 'approaching') {
            beginSchoolStop(vehicle, schoolStop, time + dt);
            vehicle.motionSpeed = 0;
            limitReason = 'school-stop';
            stopped = true;
          }
          if (working) work.progress = clamp((target - ENTRY_PROGRESS) / (1 - ENTRY_PROGRESS), 0, 1);

          if (target >= 1 - EPSILON) {
            if (working) {
              work.progress = 1;
              endRoadwork(vehicle, 'finished', time + dt);
            }
            crossed = transitionVehicle(vehicle);
            if (!crossed) {
              target = working ? 1 : Math.max(start, Math.min(target, 1 - gapMeters(vehicle) * 0.66 / road.length));
              limitReason = mayProceed ? 'traffic' : 'signal';
              limitSpillback = mayProceed && nextRoadEntryState(vehicle) === 'spillback';
              stopped = true;
              vehicle.motionSpeed = 0;
            }
          }
          if (working && work.state === 'working' && time + dt >= work.startedAt + MAX_ROADWORK_SECONDS - EPSILON) {
            endRoadwork(vehicle, 'incomplete', time + dt);
          }
          if (!crossed) vehicle.progress = geometricProgress(vehicle.reverse, target);
          const metersMoved = (target - start) * road.length;
          vehicle.distanceTravelled += metersMoved;
          vehicle.waiting = !crossed && stopped;
          vehicle.waitingReason = vehicle.waiting ? limitReason : null;
          vehicle.spillback = realisticTraffic && vehicle.waiting && limitSpillback;
          if (vehicle.waiting && limitReason !== 'bus-stop' && limitReason !== 'school-stop') {
            const movingTime = intendedDistance > EPSILON ? dt * Math.min(1, metersMoved / intendedDistance) : 0;
            const stoppedTime = dt - movingTime;
            vehicle.waitTime += stoppedTime;
            vehicle.runWaitTime += stoppedTime;
            vehicle.currentStopSeconds = (metersMoved > EPSILON ? 0 : vehicle.currentStopSeconds) + stoppedTime;
          } else vehicle.currentStopSeconds = 0;
          if (vehicle.waitTime > 30 && time - vehicle.lastEvent > 60) {
            vehicle.lastEvent = time;
            addEvent(vehicle.plate + ' has been waiting for over 30 seconds.', 'warning');
          }
          if (passing && (crossed || target >= passage.gate.end - EPSILON)) {
            passage.passing.delete(vehicle.id);
            passage.nextPassAt = time + BREAKDOWN_PASS_HEADWAY / getWeatherFactor(vehicle.type, road.surfaceWeather);
          }
          leaderPosition = target;
          leaderSpeed = vehicle.motionSpeed;
          leaderType = vehicle.type;
          leaderReason = limitReason || (passing && laneBreakdown ? 'breakdown' : null);
          leaderSpillback = limitSpillback;
        }
        if (passage?.recovering && !passage.pending.size) passage.recovering = false;
        if (passage && !laneBreakdown && !passage.passing.size && (!passage.recovering || road.manualBreakdown)) {
          finishBreakdownRecovery(road);
        }
      });
    }

    function networkRouteLoad() {
      const laneLoads = new Map([...streets.keys()].map((id) => [id, [0, 0]]));
      const laneQueues = new Map([...streets.keys()].map((id) => [id, [0, 0]]));
      const reservedRoads = new Set();
      for (const vehicle of vehicleList) {
        if (vehicle.waiting) laneQueues.get(vehicle.streetId)[Number(vehicle.reverse)] += 1;
        for (let index = vehicle.routeIndex; index < vehicle.route.length; index += 1) {
          const leg = vehicle.route[index];
          reservedRoads.add(leg.streetId);
          const ahead = index - vehicle.routeIndex;
          if (ahead < 3) laneLoads.get(leg.streetId)[Number(leg.reverse)] += ahead ? 0.45 / ahead : 1;
        }
      }
      return { laneLoads, laneQueues, reservedRoads };
    }

    function laneTravelPenalty(road, reverse, { laneLoads, laneQueues }) {
      const load = laneLoads.get(road.id)[Number(reverse)] / Math.max(3, road.length / 22);
      const queue = laneQueues.get(road.id)[Number(reverse)];
      const signalDelay = signalGroups.has(reverse ? road.from : road.to) ? (realisticTraffic ? 35 : 7) : 0;
      // Penalize extra signals and backed-up lanes when finding a route.
      const occupancyPenalty = realisticTraffic ? 65 : 16;
      const queuePenalty = realisticTraffic ? 8 : 4;
      return signalDelay + occupancyPenalty * load * load + queue * queuePenalty;
    }

    function balancedRouting(type) {
      const loadState = networkRouteLoad();
      const { laneLoads, reservedRoads } = loadState;
      const usage = (road, reverse) => {
        const index = Number(reverse);
        const volume = laneLoads.get(road.id)[index] / Math.max(3, road.length / 22);
        const recency = Math.max(0, 1 - (time - road.lastEnteredAt[index]) / 85);
        return Math.min(1, volume * 1.4 + recency * 0.42);
      };
      const penalty = (road, reverse) => laneTravelPenalty(road, reverse, loadState);
      const routeCost = (legs) => legs.reduce((sum, leg) => {
        const road = streets.get(leg.streetId);
        return sum + edgeCost(road, type, leg.reverse) + penalty(road, leg.reverse);
      }, 0);
      const waypoints = [];
      for (const road of streets.values()) {
        if (!routeAllowed(road, type)) continue;
        for (const reverse of road.oneWay ? [false] : [false, true]) {
          if (laneHasBreakdown(road, reverse)) continue;
          waypoints.push({ road, reverse, priority: usage(road, reverse) + random() * 0.40 });
        }
      }
      waypoints.sort((a, b) => a.priority - b.priority);
      const coverage = waypoints.filter(({ road }) => !road.breakdown && !reservedRoads.has(road.id) &&
        time - Math.max(...road.lastEnteredAt) >= COVERAGE_IDLE_SECONDS).slice(0, 3);
      return { penalty, routeCost, coverage, waypoints: waypoints.slice(0, 12) };
    }

    function canSpawnOn(leg, type) {
      return hasSpaceAtStart(streets.get(leg.streetId), leg.reverse, { type });
    }

    function boundaryPolarity(nodeId) {
      const { x, y } = nodes.get(nodeId);
      const west = 1 - 2 * x / Math.max(1, finiteNumber(data.width, 1));
      const south = 2 * y / Math.max(1, finiteNumber(data.height, 1)) - 1;
      return clamp(west * 0.65 + south * 0.35, -1, 1);
    }

    function makeBoundaryGates() {
      const scale = Math.max(1, Math.hypot(finiteNumber(data.width, 1), finiteNumber(data.height, 1)));
      return boundaryNodes.flatMap((nodeId) => {
        const reached = new Set([nodeId]);
        const search = [nodeId];
        for (const current of search) {
          for (const edge of adjacency.get(current)) {
            if (reached.has(edge.nodeId)) continue;
            reached.add(edge.nodeId);
            if (!isBoundaryId(edge.nodeId)) search.push(edge.nodeId);
          }
        }
        const origin = nodes.get(nodeId);
        const outlets = [...exitNodes].filter((id) => id !== nodeId && reached.has(id)).map((id) => {
          const outlet = nodes.get(id);
          const span = clamp(Math.hypot(outlet.x - origin.x, outlet.y - origin.y) / scale, 0, 1);
          return { id, polarity: boundaryPolarity(id), weight: 0.85 + 0.5 * span };
        });
        if (!outlets.length) return [];
        const arterial = adjacency.get(nodeId).some((edge) => streets.get(edge.streetId).major);
        return [{ nodeId, outlets, polarity: boundaryPolarity(nodeId), weight: arterial ? 1.4 : 0.8 }];
      });
    }

    function commutePulse() {
      if (demandProfileMode !== 'daily') return 0;
      const hour = timeOfDaySeconds / 3600;
      const morning = Math.max(0, 1 - Math.abs(hour - 8.5) / 2.75);
      const evening = Math.max(0, 1 - Math.abs(hour - 17.5) / 2.75);
      return morning - evening;
    }

    // Rates are calibrated against vehicle counts at the three demand presets.
    function steadyBoundaryRate() {
      if (demand <= 1) return TYPICAL_BOUNDARY_RATE * demand;
      if (demand <= 2) return TYPICAL_BOUNDARY_RATE + (demand - 1) * (BUSY_BOUNDARY_RATE - TYPICAL_BOUNDARY_RATE);
      return BUSY_BOUNDARY_RATE + (demand - 2) * (HEAVY_BOUNDARY_RATE - BUSY_BOUNDARY_RATE);
    }

    function effectiveDemandFactor(profileFactor) {
      const level = realisticTraffic ? steadyBoundaryRate() / TYPICAL_BOUNDARY_RATE : demand;
      return level * profileFactor;
    }

    function boundaryRates(pulse) {
      const rate = steadyBoundaryRate() * currentDemandProfileFactor();
      const weights = boundaryGates.map((gate) => gate.weight * (1 + 0.65 * pulse * gate.polarity));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      return weights.map((weight) => rate * weight / total);
    }

    function demandInterval(randomSample) {
      return -Math.log(Math.max(1e-9, 1 - randomSample));
    }

    function resetBoundaryDemand(warmup) {
      nextBoundaryGate = 0;
      boundaryTripPrefix = warmup ? 'warmup:' : '';
      boundaryGates.forEach((gate, index) => {
        gate.random = mulberry32(currentSeed ^ Math.imul(index + 1, 0x85ebca6b) ^ (warmup ? 0xa511e9b3 : 0xc2b2ae35));
        gate.hazard = demandInterval(gate.random());
        gate.queue = [];
        gate.offered = 0;
        gate.admitted = 0;
        gate.dropped = 0;
        gate.admittedWaitSeconds = 0;
        gate.retryAt = 0;
        gate.signature = 2166136261;
        gate.lastOffered = null;
      });
    }

    function offerBoundaryTrip(gate, pulse) {
      const weights = gate.outlets.map((outlet) => outlet.weight * (1 - 0.65 * pulse * outlet.polarity));
      let draw = gate.random() * weights.reduce((sum, weight) => sum + weight, 0);
      let outletIndex = weights.length - 1;
      for (let i = 0; i < weights.length - 1; i += 1) {
        draw -= weights[i];
        if (draw < 0) { outletIndex = i; break; }
      }
      const type = gate.random() < 0.16 ? 'bike' : 'car';
      gate.offered += 1;
      const trip = { id: boundaryTripPrefix + gate.nodeId + ':' + gate.offered, originNodeId: gate.nodeId,
        destinationNodeId: gate.outlets[outletIndex].id, type, offeredAt: time };
      gate.lastOffered = trip;
      for (const value of [Math.round(time / SIMULATION_STEP_SECONDS), outletIndex, Number(type === 'bike')]) {
        gate.signature = Math.imul(gate.signature ^ value, 16777619) >>> 0;
      }
      if (gate.queue.length < MAX_BOUNDARY_QUEUE) gate.queue.push(trip);
      else gate.dropped += 1;
    }

    function admitBoundaryTrip(gate, loadState) {
      const trip = gate.queue[0];
      gate.retryAt = time + BOUNDARY_RETRY_SECONDS;
      if (options?.autoBuses && vehicleList.filter(vehicle => vehicle.bus).length < Math.min(10, busServices.length + 2) &&
          busServices.some(service => {
            const first = service.route[0], road = streets.get(first.streetId);
            return time + EPSILON >= service.nextAt && (first.reverse ? road.to : road.from) === gate.nodeId &&
              vehicleList.filter(vehicle => vehicle.bus?.serviceId === service.id).length < 2 &&
              service.route.every(leg => routeAllowed(streets.get(leg.streetId), 'bus'));
          })) return;
      const entrancePenalty = (road, reverse) => {
        const entry = reverse ? road.to : road.from;
        if (entry === gate.nodeId && !canSpawnOn({ streetId: road.id, reverse }, trip.type)) return Infinity;
        return laneTravelPenalty(road, reverse, loadState);
      };
      const route = findRoute(gate.nodeId, trip.destinationNodeId, trip.type, null, entrancePenalty);
      if (!route?.length) return;
      const first = route[0];
      const vehicle = makeVehicle({ type: trip.type, route, destination: trip.destinationNodeId,
        progress: geometricProgress(first.reverse, ENTRY_PROGRESS) });
      const waitSeconds = Math.max(0, time - trip.offeredAt);
      vehicle.boundaryTrip = { ...trip, admittedAt: time, waitSeconds };
      vehicleList.push(vehicle);
      streets.get(first.streetId).lastEnteredAt[Number(first.reverse)] = time;
      totalArrived += 1;
      gate.queue.shift();
      gate.admitted += 1;
      gate.admittedWaitSeconds += waitSeconds;
    }

    function updateBoundaryDemand(dt) {
      if (!boundaryGates.length) return;
      const pulse = commutePulse();
      const rates = boundaryRates(pulse);
      boundaryGates.forEach((gate, index) => {
        gate.hazard -= rates[index] * dt;
        while (gate.hazard <= 0) {
          offerBoundaryTrip(gate, pulse);
          gate.hazard += demandInterval(gate.random());
        }
      });
      let loadState;
      for (let offset = 0; offset < boundaryGates.length && vehicleList.length < MAX_VEHICLES; offset += 1) {
        const gate = boundaryGates[(nextBoundaryGate + offset) % boundaryGates.length];
        if (!gate.queue.length || time < gate.retryAt) continue;
        if (!loadState) loadState = networkRouteLoad();
        admitBoundaryTrip(gate, loadState);
      }
      nextBoundaryGate = (nextBoundaryGate + 1) % boundaryGates.length;
    }

    function chooseCoverageTrip(origins, type, routing) {
      // Reserve part of the existing inflow for streets that have been empty a
      // while. Choose an origin and exit that fit the street's direction.
      if (!routing.coverage.length || random() >= COVERAGE_ROUTE_SHARE) return null;
      const exits = [...exitNodes];
      const costLimit = type === 'bike' ? 350 : 220;
      for (const waypoint of routing.coverage) {
        const { road, reverse } = waypoint;
        const entryNode = reverse ? road.to : road.from;
        const exitNode = reverse ? road.from : road.to;
        const suffixes = (isBoundaryId(exitNode) ? [exitNode] : exits).map((destination) => ({
          destination,
          suffix: findRoute(exitNode, destination, type, road.id, routing.penalty)
        })).filter(({ suffix }) => suffix);
        let best = null;
        let bestCost = costLimit;
        for (const origin of isBoundaryId(entryNode) ? origins.filter((id) => id === entryNode) : origins) {
          const prefix = findRoute(origin, entryNode, type, road.id, routing.penalty);
          if (!prefix) continue;
          if (!canSpawnOn(prefix[0] || { streetId: road.id, reverse }, type)) continue;
          for (const { destination, suffix } of suffixes) {
            if (origin === destination) continue;
            const route = joinWaypointRoute(origin, exitNode, prefix, waypoint, suffix);
            if (!route) continue;
            const cost = routing.routeCost(route);
            if (cost >= bestCost) continue;
            best = { destination, route };
            bestCost = cost;
          }
        }
        if (best) return best;
      }
      return null;
    }

    function spawnIncoming() {
      if (vehicleList.length >= MAX_VEHICLES) return;
      const type = random() < 0.16 ? 'bike' : 'car';
      const usableOrigins = boundaryNodes.filter((nodeId) => adjacency.get(nodeId).some((step) => {
        const road = streets.get(step.streetId);
        return road && routeAllowed(road, type) && !isBoundary(nodes.get(step.nodeId), data);
      }));
      if (!usableOrigins.length) return;
      const routing = balancedRouting(type);
      const firstOrigin = Math.floor(random() * usableOrigins.length);
      let destinationInfo = chooseCoverageTrip(usableOrigins, type, routing);
      for (let offset = 0; !destinationInfo && offset < usableOrigins.length; offset += 1) {
        const origin = usableOrigins[(firstOrigin + offset) % usableOrigins.length];
        const candidate = chooseDestination(origin, type, null, null, routing);
        if (candidate && canSpawnOn(candidate.route[0], type)) destinationInfo = candidate;
      }
      if (!destinationInfo) return;
      const first = destinationInfo.route[0];
      vehicleList.push(makeVehicle({
        type,
        route: destinationInfo.route,
        destination: destinationInfo.destination,
        progress: geometricProgress(first.reverse, ENTRY_PROGRESS)
      }));
      streets.get(first.streetId).lastEnteredAt[Number(first.reverse)] = time;
      totalArrived += 1;
    }

    function updateDemand(dt) {
      if (realisticTraffic) {
        updateBoundaryDemand(dt);
        return;
      }
      if (demand <= 0 || vehicleList.length >= MAX_VEHICLES) return;
      // Calibrate typical arrivals to the map's steady-state discharge rate.
      // Heavy demand adds a stronger inflow and uses a shorter minimum gap.
      const heavy = demand >= HEAVY_DEMAND_THRESHOLD;
      const profileFactor = currentDemandProfileFactor();
      const rate = (0.342 * demand + (heavy ? 0.65 + (demand - HEAVY_DEMAND_THRESHOLD) * 0.3 : 0)) * profileFactor;
      const minimumGap = heavy ? 0.45 : 0.7;
      nextSpawnIn -= dt;
      let guard = 0;
      while (nextSpawnIn <= 0 && guard++ < 5 && vehicleList.length < MAX_VEHICLES) {
        spawnIncoming();
        nextSpawnIn += Math.max(minimumGap, -Math.log(Math.max(0.0001, random())) / rate);
      }
    }

    function roadQueueCounts() {
      const counts = new Map();
      vehicleList.forEach((vehicle) => {
        if (!vehicle.waiting || vehicle.waitingReason === 'bus-stop' || vehicle.waitingReason === 'school-stop') return;
        let queues = counts.get(vehicle.streetId);
        if (!queues) {
          queues = { signal: 0, traffic: 0, breakdown: 0, spillback: 0 };
          counts.set(vehicle.streetId, queues);
        }
        queues[vehicle.waitingReason === 'signal' || vehicle.waitingReason === 'breakdown' ? vehicle.waitingReason : 'traffic'] += 1;
        if (vehicle.spillback) queues.spillback += 1;
      });
      return counts;
    }

    function totalQueued() {
      let count = 0;
      vehicleList.forEach((vehicle) => { if (vehicle.waiting && vehicle.waitingReason !== 'bus-stop' && vehicle.waitingReason !== 'school-stop') count += 1; });
      return count;
    }

    function currentQueueAverageWait(queued) {
      if (!queued) return null;
      let seconds = 0;
      for (const vehicle of vehicleList) {
        if (vehicle.waiting && vehicle.waitingReason !== 'bus-stop' && vehicle.waitingReason !== 'school-stop') seconds += vehicle.currentStopSeconds;
      }
      return rounded(seconds / queued);
    }

    function unfinishedWaitSeconds() {
      return vehicleList.reduce((sum, vehicle) => sum + vehicle.runWaitTime, 0);
    }

    function unfinishedTripWaitSeconds() {
      return vehicleList.reduce((sum, vehicle) => sum + vehicle.waitTime, 0);
    }

    function currentDemandProfileFactor() {
      return demandProfileMode === 'daily' ? demandProfileFactor(timeOfDaySeconds) : 1;
    }

    function parseTimeOfDay(value) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < SECONDS_PER_DAY) {
        return Math.floor(value);
      }
      const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(String(value));
      if (!match) return null;
      const [hour, minute] = String(value).split(':').map(Number);
      return hour * 3600 + minute * 60;
    }

    function avgWait() {
      if (!vehicleList.length || !recentWaitSamples.length) return null;
      return recentWaitSamples.reduce((sum, sample) => sum + sample.waitTime, 0) / recentWaitSamples.length;
    }

    function avgWaitLatestSampleAge() {
      if (!recentWaitSamples.length) return null;
      return Math.max(0, time - recentWaitSamples[recentWaitSamples.length - 1].completedAt);
    }

    function avgWaitOverall() {
      return totalCompleted ? totalCompletedWaitSeconds / totalCompleted : null;
    }

    function throughput() {
      while (departureTimes.length && departureTimes[0] < time - 60) departureTimes.shift();
      return departureTimes.length;
    }

    function makeRoadSnapshots() {
      const queueCounts = roadQueueCounts();
      const roadCounts = new Map();
      vehicleList.forEach((vehicle) => {
        if (!roadCounts.has(vehicle.streetId)) roadCounts.set(vehicle.streetId, { car: 0, bike: 0, crane: 0, bus: 0 });
        roadCounts.get(vehicle.streetId)[vehicle.type] += 1;
      });
      const pedCounts = new Map();
      signalGroups.forEach((group) => {
        for (const item of group.waitingPedestrians.concat(group.walkingPedestrians)) {
          pedCounts.set(item.streetId, (pedCounts.get(item.streetId) || 0) + item.count);
        }
      });
      return Array.from(streets.values()).map((road) => {
        const weatherFactor = getWeatherFactor('car', road.surfaceWeather);
        const forwardSpeedFactor = weatherFactor * (laneHasBreakdown(road, false) ? breakdownSpeedFactor('car') : 1);
        const reverseSpeedFactor = road.oneWay ? null : weatherFactor * (laneHasBreakdown(road, true) ? breakdownSpeedFactor('car') : 1);
        const queues = queueCounts.get(road.id) || { signal: 0, traffic: 0, breakdown: 0, spillback: 0 };
        const counts = roadCounts.get(road.id) || { car: 0, bike: 0, crane: 0, bus: 0 };
        return {
          id: road.id,
          from: road.from,
          to: road.to,
          oneWay: road.oneWay,
          flyover: road.flyover,
          closed: roadIsClosed(road),
          manualClosed: road.manualClosed,
          workClosed: road.workVehicleId !== null,
          breakdown: road.breakdown,
          manualBreakdown: road.manualBreakdown,
          manualBreakdownActive: road.breakdown && road.breakdownPassage.source === 'manual',
          autoBreakdown: road.breakdown && road.breakdownPassage.source === 'automatic',
          breakdownProgress: road.breakdownPassage?.gate.progress ?? null,
          breakdownReverse: road.breakdownPassage?.reverse ?? false,
          breakdownRecovering: Boolean(road.breakdownPassage?.recovering),
          breakdownQueue: queues.breakdown,
          signalQueue: queues.signal,
          trafficQueue: queues.traffic,
          spillbackQueue: queues.spillback,
          bikeOnly: road.bikeOnly,
          surfaceWeather: road.surfaceWeather,
          count: counts.car + counts.bike + counts.crane + counts.bus,
          carCount: counts.car,
          bikeCount: counts.bike,
          craneCount: counts.crane,
          busCount: counts.bus,
          queue: queues.signal + queues.traffic + queues.breakdown,
          pedestrians: pedCounts.get(road.id) || 0,
          speedFactor: road.oneWay ? forwardSpeedFactor : (forwardSpeedFactor + reverseSpeedFactor) / 2,
          forwardSpeedFactor,
          reverseSpeedFactor
        };
      });
    }

    function makeSignalSnapshots() {
      const result = [];
      signalGroups.forEach((group) => {
        group.approaches.forEach((approach) => {
          const active = isInActivePhase(group, approachKey(approach));
          let color = 'red';
          if (group.stage === 'green' && active) color = 'green';
          else if (group.stage === 'yellow' && active) color = 'yellow';
          const layout = signalLayout(group.nodeId, approach.streetId, approach.reverse);
          result.push({
            id: group.nodeId + ':' + approachKey(approach),
            nodeId: group.nodeId,
            streetId: approach.streetId,
            reverse: approach.reverse,
            progress: layout && Number.isFinite(Number(layout.progress)) ? clamp(Number(layout.progress), 0, 1) : 0.84,
            color,
            remaining: rounded(projectedGreenTime(group, approachKey(approach)))
          });
        });
      });
      return result;
    }

    function makeCrossingSnapshots() {
      return Array.from(crossings.values(), ({ id, nodeId, streetId, reverse }) => {
        const group = signalGroups.get(nodeId);
        const waiting = countPedestrians(group.waitingPedestrians.filter((item) => item.crossingId === id));
        const crossing = countPedestrians(group.walkingPedestrians.filter((item) => item.crossingId === id));
        return { id, nodeId, streetId, reverse, waiting, crossing, completedPedestrians: completedPedestrians.get(id) || 0,
          state: crossing ? 'walk' : 'wait', remaining: crossing ? group.remaining : 0,
          duration: crossing ? PEDESTRIAN_WALK_SECONDS : 0 };
      });
    }

    function projectedGreenTime(group, targetKey) {
      const phaseCount = group.phases.length;
      if (!phaseCount) return group.remaining;
      const targetIndex = group.phases.findIndex((phase) => phase.some((approach) => approachKey(approach) === targetKey));
      if (targetIndex < 0) return 0;
      if ((group.stage === 'green' || group.stage === 'yellow') && targetIndex === group.phaseIndex) return group.remaining;

      let seconds = group.remaining;
      let greensUntilWalk = group.greensUntilWalk;
      let pedestriansPending = group.waitingPedestrians.length > 0;
      const phaseRedAt = pedestriansPending ? group.phaseRedAt.slice() : null;
      let index = group.phaseIndex;
      if (group.stage === 'green') seconds += yellowSeconds;
      if (group.stage === 'green' || group.stage === 'yellow') {
        if (phaseRedAt) phaseRedAt[index] = time + seconds;
        seconds += SIGNAL_ALL_RED_SECONDS;
      } else if (group.stage === 'walk') {
        seconds += SIGNAL_ALL_RED_SECONDS;
      }

      for (let visited = 0; visited < phaseCount; visited += 1) {
        if (pedestriansPending && !greensUntilWalk && pedestrianWalkFitsRedLimit(group, index, phaseRedAt, time + seconds)) {
          seconds += PEDESTRIAN_WALK_SECONDS + SIGNAL_ALL_RED_SECONDS;
          greensUntilWalk = phaseCount;
          pedestriansPending = false;
        }
        greensUntilWalk = Math.max(0, greensUntilWalk - 1);
        index = (index + 1) % phaseCount;
        if (index === targetIndex) return Math.max(0, seconds);
        seconds += phaseGreenDuration(group, index, pedestriansPending || greensUntilWalk > 0) + yellowSeconds;
        if (phaseRedAt) phaseRedAt[index] = time + seconds;
        seconds += SIGNAL_ALL_RED_SECONDS;
      }
      return Math.max(0, seconds);
    }

    function makeBoundaryDemandSnapshots() {
      const rates = boundaryRates(commutePulse());
      return boundaryGates.map((gate, index) => {
        const pendingWait = gate.queue.reduce((sum, trip) => sum + Math.max(0, time - trip.offeredAt), 0);
        const oldest = gate.queue[0];
        return { nodeId: gate.nodeId, ratePerMinute: rounded(rates[index] * 60, 2), offered: gate.offered,
          admitted: gate.admitted, queued: gate.queue.length, dropped: gate.dropped,
          waitSeconds: rounded(gate.admittedWaitSeconds + pendingWait, 2), oldestWaitSeconds: oldest ? rounded(time - oldest.offeredAt, 2) : 0,
          signature: gate.signature, lastOffered: gate.lastOffered ? { ...gate.lastOffered } : null };
      });
    }

    function snapshotMetrics(boundaryDemand) {
      const recentAverageWait = avgWait();
      const unfinishedWait = unfinishedWaitSeconds();
      const activeCount = vehicleList.length;
      const queuedCount = totalQueued();
      const profileFactor = currentDemandProfileFactor();
      const boundaryTotals = { boundaryOffered: 0, boundaryAdmitted: 0, boundaryQueued: 0, boundaryDropped: 0, boundaryWaitSeconds: 0 };
      for (const gate of boundaryDemand) {
        boundaryTotals.boundaryOffered += gate.offered;
        boundaryTotals.boundaryAdmitted += gate.admitted;
        boundaryTotals.boundaryQueued += gate.queued;
        boundaryTotals.boundaryDropped += gate.dropped;
        boundaryTotals.boundaryWaitSeconds += gate.waitSeconds;
      }
      return {
        active: activeCount,
        activeLimit: MAX_VEHICLES,
        atActiveLimit: activeCount >= MAX_VEHICLES,
        queued: queuedCount,
        spillbackQueued: vehicleList.reduce((sum, vehicle) => sum + Number(Boolean(vehicle.spillback)), 0),
        currentQueueAvgWait: currentQueueAverageWait(queuedCount),
        completed: totalCompleted,
        avgWait: nullableRounded(recentAverageWait),
        avgWaitSampleCount: recentWaitSamples.length,
        avgWaitWindowTrips: AVG_WAIT_TRIP_COUNT,
        avgWaitLatestSampleAgeSeconds: nullableRounded(avgWaitLatestSampleAge()),
        avgWaitOverall: nullableRounded(avgWaitOverall()),
        unfinishedWaitSeconds: rounded(unfinishedWait),
        unfinishedWaitPerActiveVehicleSeconds: activeCount ? rounded(unfinishedWait / activeCount) : null,
        unfinishedTripWaitSeconds: rounded(unfinishedTripWaitSeconds()),
        completedWaitSeconds: rounded(totalCompletedWaitSeconds),
        totalAccruedWaitSeconds: rounded(totalCompletedWaitSeconds + unfinishedWait),
        throughput: throughput(),
        totalArrived,
        timeOfDay: formatTimeOfDay(timeOfDaySeconds),
        demandProfileMode,
        demandProfileStartTime: formatTimeOfDay(demandProfileStartSeconds),
        demandProfileFactor: rounded(profileFactor, 3),
        effectiveDemand: rounded(effectiveDemandFactor(profileFactor), 3),
        ...boundaryTotals
      };
    }

    function makeRoadworkSnapshot(vehicle) {
      const { streetId, reverse, state, duration, progress, startedAt, endedAt } = vehicle.roadwork;
      let eta = null;
      if (state === 'enroute' && !vehicle.waiting && routeAllowed(streets.get(streetId), 'crane')) {
        const road = streets.get(vehicle.streetId);
        const distance = Math.max(0, roadworkApproachProgress(vehicle) - travelPosition(vehicle)) * road.length;
        eta = Math.ceil(distance / cruiseSpeed('crane', road));
      }
      const elapsed = startedAt === undefined ? 0 : rounded(Math.max(0, (endedAt ?? time) - startedAt), 2);
      let remaining = 0;
      if (state === 'working') remaining = rounded(Math.max(0, Math.min(duration * (1 - progress), MAX_ROADWORK_SECONDS - elapsed)), 2);
      if (state === 'clearing' || state === 'enroute') remaining = duration;
      return { id: vehicle.id, vehicleId: vehicle.id, streetId, reverse, state, duration, progress, remaining, elapsed, eta,
        dispatchSource: vehicle.dispatchSource };
    }

    function makeRoadworkSnapshots() {
      return vehicleList.filter((vehicle) => ['enroute', 'clearing', 'working'].includes(vehicle.roadwork?.state))
        .map(makeRoadworkSnapshot);
    }

    function makeIncidentSnapshots() {
      if (!automaticBreakdown) return [];
      const { id, vehicle, road, duration, endsAt } = automaticBreakdown;
      return [{ id, vehicleId: vehicle.id, plate: vehicle.plate, streetId: road.id, reverse: vehicle.reverse,
        progress: travelPosition(vehicle), remaining: rounded(Math.max(0, endsAt - time), 2), duration }];
    }

    function vehicleMotion(vehicle) {
      const previous = vehicle.route[vehicle.routeIndex - 1];
      const next = isBoundaryId(routeEndNode(routeCurrentLeg(vehicle))) ? null : vehicle.route[vehicle.routeIndex + 1];
      const bypass = breakdownBypass(vehicle);
      return {
        id: vehicle.id,
        plate: vehicle.plate,
        type: vehicle.type,
        ...(vehicle.dispatchSource && { dispatchSource: vehicle.dispatchSource }),
        ...(vehicle.bus && { bus: busSnapshot(vehicle) }),
        ...(vehicle.school && { school: { ...vehicle.school,
          remaining: vehicle.school.state === 'stopped' ? rounded(Math.max(0, vehicle.school.endsAt - time)) : 0 } }),
        streetId: vehicle.streetId,
        progress: travelPosition(vehicle),
        reverse: vehicle.reverse,
        waiting: vehicle.waiting,
        waitingReason: vehicle.waitingReason,
        spillback: Boolean(vehicle.spillback),
        brokenDown: Boolean(vehicle.brokenDown),
        breakdownPassing: bypass > 0,
        breakdownBypass: bypass,
        motionSpeed: vehicle.motionSpeed,
        routeIndex: vehicle.routeIndex,
        previousStreetId: previous?.streetId,
        previousReverse: previous?.reverse,
        nextStreetId: next?.streetId,
        nextReverse: next?.reverse,
        ...(vehicle.roadwork && { roadwork: makeRoadworkSnapshot(vehicle) })
      };
    }

    function getMotionSnapshot() {
      return { time, generation, stepRemainder, stepSeconds: SIMULATION_STEP_SECONDS,
        vehicles: vehicleList.map(vehicleMotion), crossings: makeCrossingSnapshots(), roadworks: makeRoadworkSnapshots(),
        incidents: makeIncidentSnapshots(), busStops: makeBusStopSnapshots(), passengerMotions: makePassengerSnapshots(), schools: makeSchoolSnapshots() };
    }

    function copyClosureDetour(detour) {
      if (!detour) return null;
      return {
        routeIndex: detour.routeIndex,
        originalRoute: detour.originalRoute.map((leg) => ({ ...leg })),
        closedRoadIds: [...detour.closedRoadIds]
      };
    }
/* Ye function simulation ko aage nahi chalata aur file save nahi karta. Sirf current information deta hai.*/
    function getSnapshot() {
      const boundaryDemand = makeBoundaryDemandSnapshots();
      return {
        time: rounded(time),
        timeOfDay: formatTimeOfDay(timeOfDaySeconds),
        timeOfDaySeconds: Math.floor(timeOfDaySeconds),
        running,
        speed,
        weather,
        mode,
        maxRedSeconds,
        demandProfileMode,
        demandProfileStartTime: formatTimeOfDay(demandProfileStartSeconds),
        demand: rounded(demand),
        roads: makeRoadSnapshots(),
        vehicles: vehicleList.map((vehicle) => ({
          ...vehicleMotion(vehicle),
          progress: rounded(travelPosition(vehicle), 4),
          route: vehicle.route.map((leg) => ({ streetId: leg.streetId, reverse: leg.reverse })),
          closureDetour: copyClosureDetour(vehicle.closureDetour),
          ...(vehicle.boundaryTrip && { boundaryTrip: { ...vehicle.boundaryTrip } }),
          waitTime: rounded(vehicle.waitTime),
          currentStopSeconds: rounded(vehicle.currentStopSeconds),
          runWaitTime: rounded(vehicle.runWaitTime)
        })),
        completed: completed.map((item) => ({
          id: item.id,
          plate: item.plate,
          type: item.type,
          ...(item.dispatchSource && { dispatchSource: item.dispatchSource }),
          ...(item.bus && { bus: { ...item.bus } }),
          ...(item.school && { school: { ...item.school } }),
          route: item.route.map((leg) => ({ streetId: leg.streetId, reverse: leg.reverse })),
          closureDetour: copyClosureDetour(item.closureDetour),
          ...(item.boundaryTrip && { boundaryTrip: { ...item.boundaryTrip } }),
          ...(item.roadwork && { roadwork: { ...item.roadwork } }),
          duration: rounded(item.duration),
          completedAt: rounded(item.completedAt),
          waitTime: rounded(item.waitTime),
          runWaitTime: rounded(item.runWaitTime)
        })),
        signals: makeSignalSnapshots(),
        crossings: makeCrossingSnapshots(),
        roadworks: makeRoadworkSnapshots(),
        incidents: makeIncidentSnapshots(),
        busStops: makeBusStopSnapshots(),
        passengerMotions: makePassengerSnapshots(),
        passengers: { ...passengerStats },
        schools: makeSchoolSnapshots(),
        boundaryDemand,
        metrics: snapshotMetrics(boundaryDemand),
        history: history.map((item) => ({ ...item })),
        events: events.map((item) => ({ ...item }))
      };
    }
/* getSnapshot() ki badi report se controller ke liye selected information nikalna.*/
    function getObservation(decision) {
      const snap = getSnapshot();
      const observation = {
        time: snap.time,
        weather: snap.weather,
        demand: snap.demand,
        roads: snap.roads.map((road) => ({
          id: road.id,
          oneWay: road.oneWay,
          flyover: road.flyover,
          count: road.count,
          carCount: road.carCount,
          bikeCount: road.bikeCount,
          craneCount: road.craneCount,
          busCount: road.busCount,
          queue: road.queue,
          spillbackQueue: road.spillbackQueue,
          pedestrians: road.pedestrians,
          speedFactor: road.speedFactor,
          forwardSpeedFactor: road.forwardSpeedFactor,
          reverseSpeedFactor: road.reverseSpeedFactor,
          surfaceWeather: road.surfaceWeather,
          closed: road.closed,
          manualClosed: road.manualClosed,
          workClosed: road.workClosed,
          breakdown: road.breakdown,
          manualBreakdown: road.manualBreakdown,
          autoBreakdown: road.autoBreakdown,
          bikeOnly: road.bikeOnly
        })),
        signals: snap.signals.map((signal) => ({ nodeId: signal.nodeId, streetId: signal.streetId, reverse: signal.reverse, color: signal.color, remaining: signal.remaining })),
        boundaryDemand: snap.boundaryDemand,
        metrics: { ...snap.metrics }
      };
      if (decision) observation.decision = { ...decision };
      return observation;
    }
/*ska kaam: simulation ka time aage badhana aur us dauraan hone wali cheezein calculate karna.
Matlab: 5 simulated seconds advance karo, phir updated traffic report lo. Iska matlab 5 real seconds wait karna nahi hai.
 */
/*getSnapshot() → simulation ki current detailed report deta hai.

getObservation() → us current report se controller ke liye selected details nikalta hai. Abhi ye specific detection areas tak restricted nahi hai; woh change baaki hai.

step(seconds) → prediction nahi deta. Simulation ko aage chalata hai. Uske baad nayi information getSnapshot() ya getObservation() se lete hain*/ 
    function step(dtSeconds, onTick) {
      if (!running) return stepRemainder;
      const dt = clamp(finiteNumber(dtSeconds, 0), 0, MAX_STEP);
      if (dt <= 0) return stepRemainder;
      stepRemainder += dt;
      while (stepRemainder + EPSILON >= SIMULATION_STEP_SECONDS) {
        const slice = SIMULATION_STEP_SECONDS;
        advanceSignals(slice);
        prepareRoadworks();
        updateRoads(slice);
        updateDemand(slice);
        dispatchScheduledBuses();
        dispatchSchoolTraffic();
        time += slice;
        updatePassengers(time);
        updateAutomaticBreakdowns();
        timeOfDaySeconds = (timeOfDaySeconds + slice) % SECONDS_PER_DAY;
        if (time >= nextPedestrianArrival) spawnPedestrians();
        if (time >= nextAutomaticCrane) dispatchAutomaticCrane();
        recordHistorySlice(slice);
        stepRemainder = Math.max(0, stepRemainder - slice);
        if (typeof onTick === 'function') onTick(getMotionSnapshot());
      }
      return stepRemainder;
    }

    function recordHistorySlice(dt) {
      historyElapsed += dt;
      if (historyElapsed + EPSILON < 5) return;
      historyElapsed = 0;
      const recentAverageWait = avgWait();
      const unfinishedWait = unfinishedWaitSeconds();
      const activeCount = vehicleList.length;
      const queuedCount = totalQueued();
      const profileFactor = currentDemandProfileFactor();
      history.push({
        time: rounded(time),
        active: vehicleList.length,
        queued: queuedCount,
        currentQueueAvgWait: currentQueueAverageWait(queuedCount),
        completed: totalCompleted,
        avgWait: nullableRounded(recentAverageWait),
        avgWaitSampleCount: recentWaitSamples.length,
        avgWaitWindowTrips: AVG_WAIT_TRIP_COUNT,
        avgWaitLatestSampleAgeSeconds: nullableRounded(avgWaitLatestSampleAge()),
        avgWaitOverall: nullableRounded(avgWaitOverall()),
        unfinishedWaitSeconds: rounded(unfinishedWait),
        unfinishedWaitPerActiveVehicleSeconds: activeCount ? rounded(unfinishedWait / activeCount) : null,
        completedWaitSeconds: rounded(totalCompletedWaitSeconds),
        totalAccruedWaitSeconds: rounded(totalCompletedWaitSeconds + unfinishedWait),
        unfinishedTripWaitSeconds: rounded(unfinishedTripWaitSeconds()),
        timeOfDay: formatTimeOfDay(timeOfDaySeconds),
        demandProfileMode,
        demandProfileStartTime: formatTimeOfDay(demandProfileStartSeconds),
        demandProfileFactor: rounded(profileFactor, 3),
        effectiveDemand: rounded(effectiveDemandFactor(profileFactor), 3)
      });
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    }

    function setRunning(value) {
      running = Boolean(value);
      return running;
    }

    function setSpeed(value) {
      const numeric = Number(value);
      if ([1, 2, 4, 8].includes(numeric)) speed = numeric;
      return speed;
    }

    function setWeather(value) {
      const surface = value === 'rain' ? 'wet' : value;
      if (!SURFACE_WEATHER.has(surface)) return { ok: false, message: 'Choose clear, wet, or snow weather for a road.' };
      if (weather === surface) return { ok: true, message: 'Legacy weather preference unchanged; set road surfaces individually.' };
      weather = surface;
      return { ok: true, message: 'Legacy weather preference recorded. Set road surfaces with setRoadWeather().' };
    }

    function setRoadWeather(streetId, value) {
      const road = streets.get(streetId);
      if (!road) return { ok: false, message: 'Road not found.' };
      if (!SURFACE_WEATHER.has(value)) return { ok: false, message: 'Choose clear, wet, or snow surface weather.' };
      if (road.surfaceWeather === value) return { ok: true, message: streetId + ' surface weather unchanged.' };
      const previous = road.surfaceWeather;
      road.surfaceWeather = value;
      if (getWeatherFactor('car', value) < getWeatherFactor('car', previous)) {
        vehicleList.forEach((vehicle) => {
          if (vehicle.route.slice(vehicle.routeIndex + 1).some((leg) => leg.streetId === streetId)) replanVehicle(vehicle);
        });
      }
      addEvent(streetId + ' surface changed to ' + value + '.', value === 'clear' ? 'success' : 'warning');
      return { ok: true, message: streetId + ' surface weather set to ' + value + '.' };
    }

    function setMode(value) {
      if (!['adaptive', 'fixed', 'custom'].includes(value)) return { ok: false, message: 'Unknown controller mode.' };
      if (value === 'custom' && !customController) return { ok: false, message: 'Register a controller before selecting custom mode.' };
      mode = value;
      replanUnservedGreens();
      addEvent('Signal controller set to ' + value + '.', 'info');
      return { ok: true, message: 'Controller mode set to ' + value + '.' };
    }

    function setDemand(value) {
      const numeric = finiteNumber(value, NaN);
      if (!Number.isFinite(numeric)) return { ok: false, message: 'Demand must be between 0 and 3.' };
      const previous = demand;
      demand = clamp(numeric, 0, 3);
      if (demand > previous) nextSpawnIn = Math.min(nextSpawnIn, 0.05);
      return { ok: true, message: 'Incoming demand set to ' + demand.toFixed(1) + '×.' };
    }

    function setDemandProfile(profileMode, startTimeOfDay) {
      if (!['steady', 'daily'].includes(profileMode)) {
        return { ok: false, message: 'Choose the steady or daily demand profile.' };
      }
      let parsedStartTime = null;
      if (startTimeOfDay !== undefined) {
        parsedStartTime = parseTimeOfDay(startTimeOfDay);
        if (parsedStartTime === null) {
          return { ok: false, message: 'Start time must be HH:MM or seconds since midnight.' };
        }
      }
      demandProfileMode = profileMode;
      if (parsedStartTime !== null) {
        demandProfileStartSeconds = parsedStartTime;
        timeOfDaySeconds = parsedStartTime;
      }
      addEvent('Demand profile set to ' + demandProfileMode + '.', 'info');
      return {
        ok: true,
        message: 'Demand profile set to ' + demandProfileMode +
          (parsedStartTime === null ? '.' : ' starting at ' + formatTimeOfDay(demandProfileStartSeconds) + '.')
      };
    }

    function rerouteAfterRoadChange(closedStreetId) {
      vehicleList.forEach((vehicle) => {
        const future = vehicle.route.slice(vehicle.routeIndex + 1);
        const stranded = !future.length && routeEndNode(routeCurrentLeg(vehicle)) !== vehicle.destination;
        const hasBlockedLeg = future.some((leg) => {
          const road = streets.get(leg.streetId);
          return !road || !routeAllowed(road, vehicle.type, vehicle.id);
        });
        if (!stranded && !hasBlockedLeg) return;

        const forkIndex = vehicle.routeIndex;
        replanVehicle(vehicle);
        if (closedStreetId && future.some((leg) => leg.streetId === closedStreetId)) {
          vehicle.closureDetour = {
            routeIndex: forkIndex,
            originalRoute: future,
            closedRoadIds: [closedStreetId]
          };
        }
      });
    }

    function activateBreakdown(road, gate, reverse, source) {
      road.breakdown = true;
      const inPassage = vehicleList.filter((vehicle) => {
        if (vehicle.streetId !== road.id || vehicle.reverse !== reverse || vehicle.brokenDown) return false;
        const progress = travelPosition(vehicle);
        return progress > gate.start + EPSILON && progress < gate.end;
      }).sort((a, b) => travelPosition(b) - travelPosition(a));
      const passing = new Set(inPassage.slice(0, 1).map((vehicle) => vehicle.id));
      road.breakdownPassage = { gate, reverse, source, passing, nextPassAt: time + BREAKDOWN_STARTUP_HOLD };
    }

    function finishBreakdownRecovery(road) {
      road.breakdownPassage = null;
      if (road.manualBreakdown) {
        activateBreakdown(road, breakdownGate(road), false, 'manual');
        addEvent('The manual breakdown on ' + road.id + ' is now active.', 'warning');
      }
    }

    function clearBreakdown(road) {
      road.breakdown = false;
      const passage = road.breakdownPassage;
      const pending = new Set(vehicleList.filter((vehicle) => vehicle.streetId === road.id &&
        vehicle.reverse === passage.reverse && vehicle.waitingReason === 'breakdown' &&
        travelPosition(vehicle) < passage.gate.end - EPSILON).map((vehicle) => vehicle.id));
      passage.pending = pending;
      passage.recovering = pending.size > 0;
      passage.nextReleaseAt = time + 0.5;
      if (!passage.passing.size && (!passage.recovering || road.manualBreakdown)) finishBreakdownRecovery(road);
    }

    function setManualBreakdown(road, active) {
      road.manualBreakdown = active;
      const passage = road.breakdownPassage;
      const timedPassageInUse = passage?.source === 'automatic' && (road.breakdown || passage.passing.size);
      if (!active) {
        if (road.breakdown && passage.source === 'manual') clearBreakdown(road);
        const remaining = timedPassageInUse ? ' The timed breakdown is still being handled.' : '';
        addEvent('The manual breakdown on ' + road.id + ' has cleared.' + remaining, 'success');
      } else if (timedPassageInUse) {
        addEvent('Manual breakdown queued on ' + road.id + ' until the timed breakdown clears.', 'info');
      } else {
        activateBreakdown(road, breakdownGate(road), false, 'manual');
        addEvent('A broken-down vehicle is narrowing ' + road.id + '; traffic is queueing to pass.', 'warning');
      }
    }

    function automaticBreakdownGate(vehicle, road) {
      if (vehicle.type !== 'car' || vehicle.waiting || vehicle.motionSpeed < 2 || roadIsClosed(road) ||
          road.bikeOnly || road.breakdownPassage) return null;
      const position = travelPosition(vehicle);
      if (position < 0.23 || position > 0.72) return null;
      const gate = breakdownGateAt(road, position);
      const nodeId = routeEndNode(routeCurrentLeg(vehicle));
      const stop = signalGroups.has(nodeId) ? vehicleStopProgress(nodeId, road.id, vehicle.reverse) : 1;
      if (gate.end >= stop - 0.02) return null;
      const byStreet = crossingsByStreet.get(road.id) || [];
      if (byStreet.some((crossing) => {
        const bounds = crossingBounds(crossing, road, vehicle.reverse, 'car');
        return bounds && gate.start < bounds.end && gate.end > bounds.start;
      })) return null;
      return gate;
    }

    function scheduleAutomaticBreakdown() {
      nextAutomaticBreakdown = time + AUTO_BREAKDOWN_MIN_GAP + breakdownRandom() * AUTO_BREAKDOWN_GAP_RANGE;
    }

    function updateAutomaticBreakdowns() {
      if (automaticBreakdown && time >= automaticBreakdown.endsAt) {
        const { vehicle, road } = automaticBreakdown;
        vehicle.brokenDown = false;
        automaticBreakdown = null;
        addEvent(vehicle.plate + ' has recovered on ' + road.id + '.', 'success');
        clearBreakdown(road);
      }
      if (time < nextAutomaticBreakdown) return;
      scheduleAutomaticBreakdown();
      const streetsWithCandidates = new Map();
      for (const vehicle of vehicleList) {
        const road = streets.get(vehicle.streetId);
        const gate = automaticBreakdownGate(vehicle, road);
        if (!gate) continue;
        if (!streetsWithCandidates.has(road.id)) streetsWithCandidates.set(road.id, []);
        streetsWithCandidates.get(road.id).push({ vehicle, road, gate });
      }
      if (!streetsWithCandidates.size) return;
      const byStreet = [...streetsWithCandidates.values()];
      const candidates = byStreet[Math.floor(breakdownRandom() * byStreet.length)];
      const { vehicle, road, gate } = candidates[Math.floor(breakdownRandom() * candidates.length)];
      const duration = Math.round((AUTO_BREAKDOWN_MIN_DURATION + breakdownRandom() * AUTO_BREAKDOWN_DURATION_RANGE) /
        SIMULATION_STEP_SECONDS) * SIMULATION_STEP_SECONDS;
      automaticBreakdown = { id: 'I' + nextBreakdownNumber++, vehicle, road, duration, endsAt: time + duration };
      vehicle.brokenDown = true;
      vehicle.waiting = true;
      vehicle.waitingReason = 'breakdown';
      vehicle.currentStopSeconds = 0;
      vehicle.motionSpeed = 0;
      activateBreakdown(road, gate, vehicle.reverse, 'automatic');
      addEvent(vehicle.plate + ' broke down on ' + road.id + '.', 'warning');
    }

    function setRoad(id, changes) {
      const road = streets.get(id);
      if (!road) return { ok: false, message: 'Road not found.' };
      const patch = changes || {};
      let changed = false;
      let newlyClosedStreetId = null;
      if (typeof patch.closed === 'boolean' && road.manualClosed !== patch.closed) {
        road.manualClosed = patch.closed;
        changed = true;
        if (road.workVehicleId !== null) {
          const message = road.manualClosed ? ' manual closure set. It will remain closed after roadwork.'
            : ' manual closure cleared. Crane roadwork is still active.';
          addEvent(id + message, 'info');
        } else {
          if (road.manualClosed) newlyClosedStreetId = id;
          addEvent(id + (road.manualClosed ? ' closed. Traffic is rerouting.' : ' reopened.'), road.manualClosed ? 'warning' : 'success');
        }
      }
      if (typeof patch.bikeOnly === 'boolean' && road.bikeOnly !== patch.bikeOnly) {
        road.bikeOnly = patch.bikeOnly;
        changed = true;
        addEvent(id + (road.bikeOnly ? ' is now motorbike-only.' : ' motorbike-only restriction lifted.'), 'info');
      }
      if (changed) rerouteAfterRoadChange(newlyClosedStreetId);
      if (typeof patch.breakdown === 'boolean' && road.manualBreakdown !== patch.breakdown) {
        setManualBreakdown(road, patch.breakdown);
        changed = true;
      }
      return { ok: true, message: changed ? id + ' updated.' : id + ' unchanged.' };
    }

    function addTraffic(streetId, count, type) {
      return insertTraffic(streetId, count, type, 'manual');
    }

    function insertTraffic(streetId, count, type, dispatchSource) {
      const road = streets.get(streetId);
      const vehicleType = type || 'car';
      const amount = Math.floor(finiteNumber(count, 10));
      if (!road) return { ok: false, message: 'Road not found.' };
      if (roadIsClosed(road)) return { ok: false, message: streetId + ' is closed.' };
      if (!TYPES.has(vehicleType)) return { ok: false, message: 'Choose car, bike, crane, or bus.' };
      if (!routeAllowed(road, vehicleType)) return { ok: false, message: streetId + ' is motorbike-only.' };
      if (amount < 1 || amount > 100) return { ok: false, message: 'Add between 1 and 100 vehicles.' };
      if (vehicleList.length + amount > MAX_VEHICLES) return { ok: false, message: 'The simulation is at its vehicle limit.' };
      let added = 0;
      const workStreets = new Set();
      const dispatchRandom = dispatchSource === 'automatic' ? automaticCraneRandom : craneRandom;
      for (let i = 0; i < amount; i += 1) {
        if (roadIsClosed(road)) break;
        const laneOptions = road.oneWay ? [false] : [false, true].sort((a, b) => {
          const countA = vehicleList.filter((vehicle) => vehicle.streetId === streetId && vehicle.reverse === a).length;
          const countB = vehicleList.filter((vehicle) => vehicle.streetId === streetId && vehicle.reverse === b).length;
          return countA - countB;
        });
        let chosen = null;
        for (const reverse of laneOptions) {
          const startTravel = findInsertionPosition(road, reverse, vehicleType);
          if (startTravel === null) continue;
          const atEntrance = startTravel <= ENTRY_PROGRESS + EPSILON;
          const built = vehicleType === 'crane' ? craneDispatch(road, reverse, atEntrance, dispatchRandom) : routeForOnStreet(streetId, reverse, vehicleType);
          if (!built) continue;
          chosen = { reverse, startTravel, built };
          break;
        }
        if (!chosen) break;
        const vehicle = makeVehicle({
          type: vehicleType,
          route: chosen.built.route,
          destination: chosen.built.destination,
          progress: geometricProgress(chosen.reverse, chosen.startTravel)
        });
        vehicleList.push(vehicle);
        road.lastEnteredAt[Number(chosen.reverse)] = time;
        totalArrived += 1;
        added += 1;
        if (vehicleType === 'crane') {
          vehicle.dispatchSource = dispatchSource;
          assignRoadwork(vehicle, chosen.built.workIndex);
          workStreets.add(vehicle.roadwork.streetId);
          if (chosen.built.workIndex === 0) {
            reserveRoadwork(vehicle);
            if (!roadworkOccupants(vehicle).length) startRoadwork(vehicle);
          }
        }
      }
      if (!added) return { ok: false, message: 'There is not enough clear road space to add vehicles.' };
      const vehicleName = vehicleType === 'crane' ? 'mobile crane' : vehicleType;
      const dispatch = workStreets.size ? ' Work assigned to ' + [...workStreets].join(', ') + '.' : '';
      const message = dispatchSource === 'automatic' ? 'Mobile crane automatically dispatched from ' + streetId + '.' + dispatch
        : added + ' ' + vehicleName + (added === 1 ? '' : 's') + ' added to ' + streetId + '.' + dispatch;
      addEvent(message, 'info');
      return { ok: true, message };
    }

    function dispatchAutomaticCrane() {
      nextAutomaticCrane = time + AUTO_CRANE_RETRY_SECONDS;
      if (!exitNodes.size || vehicleList.length >= MAX_VEHICLES ||
          vehicleList.filter((vehicle) => vehicle.dispatchSource === 'automatic').length >= MAX_AUTOMATIC_CRANES) return;

      const candidates = [...streets.values()].filter((road) => routeAllowed(road, 'crane') && !road.breakdown);
      while (candidates.length) {
        const index = Math.floor(automaticCraneRandom() * candidates.length);
        const [road] = candidates.splice(index, 1);
        if (insertTraffic(road.id, 1, 'crane', 'automatic').ok) {
          nextAutomaticCrane = time + AUTO_CRANE_MIN_GAP + automaticCraneRandom() * AUTO_CRANE_GAP_RANGE;
          return;
        }
      }
    }

    function nearestSignalNode(streetId) {
      const road = streets.get(streetId);
      if (!road || !signalGroups.size) return null;
      const endpoints = [nodes.get(road.from), nodes.get(road.to)];
      let nearest = null;
      let best = Infinity;
      signalGroups.forEach((group, nodeId) => {
        const candidate = nodes.get(nodeId);
        endpoints.forEach((endpoint) => {
          if (!candidate || !endpoint) return;
          const distance = Math.hypot(candidate.x - endpoint.x, candidate.y - endpoint.y);
          if (distance < best) {
            best = distance;
            nearest = nodeId;
          }
        });
      });
      return nearest;
    }

    function requestPedestrians(streetId, count) {
      if (!streets.has(streetId)) return { ok: false, message: 'Road not found.' };
      const amount = Math.floor(finiteNumber(count, 5));
      if (amount < 1 || amount > 100) return { ok: false, message: 'Request between 1 and 100 pedestrians.' };
      const nodeId = nearestSignalNode(streetId);
      if (!nodeId) return { ok: false, message: 'No signal crossing is available.' };
      const available = crossingsByNode.get(nodeId) || [];
      const crossing = available.find((definition) => definition.streetId === streetId) || available[0];
      return enqueuePedestrians(signalGroups.get(nodeId), streetId, crossing?.id, amount);
    }

    function requestCrossing(crossingId, count) {
      const crossing = crossings.get(crossingId);
      if (!crossing) return { ok: false, message: 'Crossing not found.' };
      const amount = Math.floor(finiteNumber(count, 5));
      if (amount < 1 || amount > 100) return { ok: false, message: 'Request between 1 and 100 pedestrians.' };
      return enqueuePedestrians(signalGroups.get(crossing.nodeId), crossing.streetId, crossing.id, amount);
    }

    function spawnPedestrians() {
      nextPedestrianArrival = time + 10 + pedestrianRandom() * 10;
      const available = realisticTraffic ? automaticCrossings : automaticCrossings.filter((crossing) =>
        !signalGroups.get(crossing.nodeId).waitingPedestrians.some((item) => item.crossingId === crossing.id));
      if (!available.length) return;
      const crossing = available[Math.floor(pedestrianRandom() * available.length)];
      const amount = 1 + Math.floor(pedestrianRandom() * 3);
      enqueuePedestrians(signalGroups.get(crossing.nodeId), crossing.streetId, crossing.id, amount);
    }

    function enqueuePedestrians(group, streetId, crossingId, amount) {
      const existing = group.waitingPedestrians.find((item) => item.streetId === streetId && item.crossingId === crossingId);
      const occupied = countPedestrians(group.waitingPedestrians) + countPedestrians(group.walkingPedestrians);
      const accepted = Math.min(amount, 200 - occupied);
      if (accepted < 1) return { ok: false, message: 'The crossing queue is full.' };
      if (existing) existing.count += accepted;
      else group.waitingPedestrians.push({ streetId, crossingId, count: accepted });
      if (group.stage === 'green') {
        const elapsed = group.greenSeconds - group.remaining;
        group.greenSeconds = Math.min(group.greenSeconds, maximumGreenDuration(group, true));
        group.remaining = Math.max(0, group.greenSeconds - elapsed);
      }
      const peopleWaiting = accepted + (accepted === 1 ? ' pedestrian is' : ' pedestrians are') + ' waiting';
      const crossingStreet = crossings.get(crossingId)?.streetId ?? streetId;
      addEvent(peopleWaiting + ' at the ' + crossingStreet + ' crossing.', 'info');
      return { ok: true, message: peopleWaiting + ' for a safe crossing.' };
    }

    function pedestrianWalkFitsRedLimit(group, activeIndex, phaseRedAt, walkStartsAt) {
      let seconds = PEDESTRIAN_WALK_SECONDS + SIGNAL_ALL_RED_SECONDS;
      const phaseInterval = maximumGreenDuration(group, true) + yellowSeconds + SIGNAL_ALL_RED_SECONDS;
      for (let ahead = 1; ahead <= group.phases.length; ahead += 1) {
        const index = (activeIndex + ahead) % group.phases.length;
        const redElapsed = walkStartsAt - phaseRedAt[index];
        if (redElapsed + seconds > maxRedSeconds + EPSILON) return false;
        seconds += phaseInterval;
      }
      return true;
    }

    function setController(fn) {
      if (fn !== null && typeof fn !== 'function') return { ok: false, message: 'Controller must be a function or null.' };
      const wasCustom = mode === 'custom';
      customController = fn;
      if (!customController && mode === 'custom') mode = 'adaptive';
      if (wasCustom) replanUnservedGreens();
      return { ok: true, message: customController ? 'Custom controller registered.' : 'Custom controller cleared.' };
    }

    function exportRun() {
      const snapshot = getSnapshot();
      return { ...snapshot, seed: currentSeed };
    }

    function seedInitialVehicles() {
      (Array.isArray(data.vehicles) ? data.vehicles : []).forEach((source) => {
        let amount = clamp(Math.floor(finiteNumber(source.count, 1)), 1, 20);
        const road = streets.get(source.streetId);
        if (!road) return;
        const carGap = gapMeters({ type: 'car' });
        amount = Math.min(amount, Math.max(1, Math.floor(road.length * 0.9 / carGap) + 1));
        const reverse = Boolean(source.reverse);
        if (road.oneWay && reverse) return;
        const approachNode = reverse ? road.from : road.to;
        const initialRed = signalGroups.has(approachNode) && !isApproachGreen(approachNode, { streetId: source.streetId, reverse });
        const initialStop = initialRed ? vehicleStopProgress(approachNode, source.streetId, reverse) : 0.975;
        if (initialRed) {
          amount = Math.min(amount, Math.max(0, Math.floor((initialStop - 0.025) * road.length / carGap) + 1));
        }
        if (amount < 1) return;
        const types = [];
        for (let i = 0; i < amount; i += 1) types.push(i === 0 || random() > 0.18 ? 'car' : 'bike');
        const gaps = types.slice(1).map((type, index) => followingGap(type, types[index]) / road.length);
        const spread = gaps.reduce((sum, gap) => sum + gap, 0);
        const baseProgress = clamp(finiteNumber(source.progress, reverse ? 0.8 : 0.2), 0.08, 0.92);
        const baseTravel = reverse ? 1 - baseProgress : baseProgress;
        let leaderTravel = clamp(baseTravel + spread / 2, 0.025 + spread, Math.min(0.975, initialStop));
        let travel = leaderTravel;
        for (let i = 0; i < amount && vehicleList.length < MAX_VEHICLES; i += 1) {
          const type = types[i];
          const progress = geometricProgress(reverse, travel);
          const vehicle = seededVehicle(source.streetId, progress, reverse, type, i === 0 ? source.plate : null);
          if (vehicle) {
            vehicleList.push(vehicle);
            totalArrived += 1;
          }
          if (i < gaps.length) travel -= gaps[i];
        }
      });

      // Seed every street that does not already have a map-defined platoon.
      // This keeps the opening scene balanced without adding a crowd to roads
      // that already start with several vehicles.
      const occupiedAtReset = new Set(vehicleList.map((vehicle) => vehicle.streetId));
      Array.from(streets.values()).forEach((road) => {
        if (occupiedAtReset.has(road.id) || vehicleList.length >= MAX_VEHICLES) return;
        const reverse = road.oneWay ? false : random() < 0.5;
        const type = random() < 0.18 ? 'bike' : 'car';
        const initialTravel = 0.16 + random() * 0.68;
        const approachNode = reverse ? road.from : road.to;
        const initialRed = signalGroups.has(approachNode) && !isApproachGreen(approachNode, { streetId: road.id, reverse });
        const stopLimit = initialRed
          ? vehicleStopProgress(approachNode, road.id, reverse) - gapMeters({ type }) / road.length
          : 0.84;
        const travel = Math.min(initialTravel, stopLimit);
        const progress = geometricProgress(reverse, clamp(travel, 0.025, 0.975));
        let vehicle = seededVehicle(road.id, progress, reverse, type);
        if (!vehicle && !road.oneWay) vehicle = seededVehicle(road.id, progress, !reverse, 'car');
        if (vehicle) {
          vehicleList.push(vehicle);
          occupiedAtReset.add(road.id);
          totalArrived += 1;
        }
      });
    }

    function initialize(seed) {
      generation += 1;
      currentSeed = finiteNumber(seed, 42) >>> 0;
      random = mulberry32(currentSeed);
      craneRandom = mulberry32(currentSeed ^ 0x85ebca6b);
      cranePlateRandom = mulberry32(currentSeed ^ 0xc2b2ae35);
      busRandom = mulberry32(currentSeed ^ 0x4cf5ad43);
      busPlateCounter = 0;
      peopleRandom = mulberry32(currentSeed ^ 0xb5297a4d);
      schoolRandom = mulberry32(currentSeed ^ 0x68e31da4);
      nextPersonNumber = 1;
      schoolCarNumber = 0;
      passengerMotions = [];
      passengerStats = { arrived: 0, boarded: 0, alighted: 0, completed: 0 };
      stopStates = new Map(busStops.map(stop => [stop.id, { waiting: [], nextSlot: 0, nextAt: 3 + peopleRandom() * 12 }]));
      schoolStates = new Map(schools.map(school => [school.id, { nextAt: 0, carsArrived: 0, carsServed: 0, studentsServed: 0 }]));
      busServices.forEach(service => { service.nextAt = Math.max(0, service.offset || 0); });
      automaticCraneRandom = mulberry32(currentSeed ^ 0x165667b1);
      nextAutomaticCrane = Infinity;
      breakdownRandom = mulberry32(currentSeed ^ 0x27d4eb2f);
      automaticBreakdown = null;
      nextBreakdownNumber = 1;
      nextAutomaticBreakdown = Infinity;
      pedestrianRandom = mulberry32(currentSeed ^ 0x9e3779b9);
      nextPedestrianArrival = Infinity;
      nextVehicleNumber = 1;
      plateCounter = 0;
      cranePlateCounter = 0;
      time = 0;
      timeOfDaySeconds = (demandProfileStartSeconds - warmupSeconds + SECONDS_PER_DAY) % SECONDS_PER_DAY;
      running = true;
      speed = 1;
      weather = 'clear';
      mode = 'adaptive';
      demand = 1;
      resetBoundaryDemand(true);
      totalArrived = 0;
      totalCompleted = 0;
      totalCompletedWaitSeconds = 0;
      stepRemainder = 0;
      nextSpawnIn = 5 + random() * 3;
      historyElapsed = 0;
      events = [];
      history = [];
      completed = [];
      completedPedestrians.clear();
      recentWaitSamples = [];
      vehicleList = [];
      departureTimes = [];
      clearanceUntil = new Map();
      streets.forEach((road) => {
        road.manualClosed = false;
        road.workVehicleId = null;
        road.breakdown = false;
        road.manualBreakdown = false;
        road.breakdownPassage = null;
        road.lastEnteredAt = [-Infinity, -Infinity];
        road.bikeOnly = false;
        road.surfaceWeather = 'clear';
      });
      createSignalGroups();

      if (!realisticTraffic) seedInitialVehicles();
      planInitialSignalDurations();

      // Pre-run the normal baseline so the first visible frame already has
      // representative moving traffic and a usable wait average.
      if (realisticTraffic && automaticCrossings.length) nextPedestrianArrival = 3 + pedestrianRandom() * 4;
      const warmupSteps = Math.ceil(warmupSeconds / MAX_STEP);
      for (let index = 0; index < warmupSteps; index += 1) step(MAX_STEP);

      const visibleStartOffset = time;
      signalGroups.forEach((group) => { group.phaseRedAt = group.phaseRedAt.map((at) => at - visibleStartOffset); });
      vehicleList.forEach((vehicle) => {
        // Keep warmed-up vehicles and their accumulated delay continuous across
        // the visible clock reset, so the live rolling average does not mix a
        // mature baseline with artificially reset, partial-trip samples.
        vehicle.startedAt -= visibleStartOffset;
        if (vehicle.boundaryTrip) {
          vehicle.boundaryTrip.offeredAt -= visibleStartOffset;
          vehicle.boundaryTrip.admittedAt -= visibleStartOffset;
        }
        vehicle.runWaitTime = 0;
        if (vehicle.departureReadyAt !== null) vehicle.departureReadyAt -= visibleStartOffset;
        if (vehicle.bus?.endsAt !== null && vehicle.bus?.endsAt !== undefined) vehicle.bus.endsAt -= visibleStartOffset;
        if (vehicle.school?.endsAt !== null && vehicle.school?.endsAt !== undefined) vehicle.school.endsAt -= visibleStartOffset;
        vehicle.lastEvent = 0;
      });
      recentWaitSamples.forEach((sample) => { sample.completedAt -= visibleStartOffset; });
      busServices.forEach(service => { service.nextAt -= visibleStartOffset; });
      stopStates.forEach(state => { state.nextAt -= visibleStartOffset; });
      schoolStates.forEach(state => { state.nextAt -= visibleStartOffset; state.carsArrived = 0; state.carsServed = 0; state.studentsServed = 0; });
      passengerMotions.forEach(motion => { motion.startsAt -= visibleStartOffset; motion.endsAt -= visibleStartOffset; });
      const livePassengers = [...stopStates.values()].reduce((sum, state) => sum + state.waiting.length, 0) +
        vehicleList.reduce((sum, vehicle) => sum + (vehicle.bus?.passengers.length || 0), 0) +
        passengerMotions.filter(motion => motion.started && !motion.schoolId).length;
      passengerStats = { arrived: livePassengers, boarded: 0, alighted: 0, completed: 0 };
      streets.forEach((road) => { road.lastEnteredAt = road.lastEnteredAt.map((at) => at - visibleStartOffset); });
      completed = [];
      completedPedestrians.clear();
      totalCompleted = 0;
      totalCompletedWaitSeconds = 0;
      totalArrived = vehicleList.length;
      departureTimes = [];
      events = [];
      history = [];
      historyElapsed = 0;
      clearanceUntil = new Map();
      time = 0;
      resetBoundaryDemand(false);
      if (options?.autoBreakdowns) scheduleAutomaticBreakdown();
      if (options?.autoCranes) nextAutomaticCrane = time + AUTO_CRANE_START_MIN + automaticCraneRandom() * AUTO_CRANE_START_RANGE;
      if (automaticCrossings.length) nextPedestrianArrival = 3 + pedestrianRandom() * 4;
      addEvent('Simulation ready with seeded city traffic.', 'success');
    }

    function reset(seed) {
      initialize(seed === undefined ? 42 : seed);
      return getSnapshot();
    }

    function rounded(value, digits) {
      const factor = Math.pow(10, digits === undefined ? 1 : digits);
      return Math.round((finiteNumber(value, 0) + Number.EPSILON) * factor) / factor;
    }

    function nullableRounded(value, digits) {
      return Number.isFinite(value) ? rounded(value, digits) : null;
    }

    initialize(finiteNumber(options && options.seed, 42));

    return {
      step,
      getSnapshot,
      getMotionSnapshot,
      setRunning,
      setSpeed,
      reset,
      setWeather,
      setMode,
      setDemand,
      setDemandProfile,
      setRoad,
      setRoadWeather,
      addTraffic,
      requestPedestrians,
      requestCrossing,
      setController,
      getObservation,
      exportRun
    };
  }

  root.TrafficSim = { create };
})(typeof window !== 'undefined' ? window : globalThis);
