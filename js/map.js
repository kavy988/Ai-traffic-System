(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const mix = (start, end, fraction) => start + (end - start) * fraction;
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const titleCase = (value) => `${(String(value || "")[0] || "").toUpperCase()}${String(value || "").slice(1)}`;
  const roadHalfWidth = (street) => street.oneWay ? 11 : street.major ? 21 : 15;
  const vehicleTypeLabel = (type) => ({ bike: "Motorbike", crane: "Mobile crane", bus: "City bus" }[type] || "Car");
  const pedestrianOffsets = [0, -.55, .55, -.25];
  const pedestrianJackets = ["#316b77", "#a85c35", "#766280", "#657247"];
  const pedestrianStrideLength = 7.2;
  const pedestrianStance = .6;
  const maxVisibleStopPeople = 4;

  function create(options = {}) {
    const { svg, frame, tooltip, data } = options;
    if (!svg || !frame || !data) throw new Error("TrafficMap.create requires svg, frame, tooltip, and map data.");
    const onStreetSelect = typeof options.onStreetSelect === "function" ? options.onStreetSelect : () => {};
    const onVehicleSelect = typeof options.onVehicleSelect === "function" ? options.onVehicleSelect : () => {};
    const onSignalSelect = typeof options.onSignalSelect === "function" ? options.onSignalSelect : () => {};
    const onCrossingSelect = typeof options.onCrossingSelect === "function" ? options.onCrossingSelect : () => {};

    const layers = {};
    const roads = new Map();
    const roadStates = new Map();
    const signals = new Map();
    const crossings = new Map();
    const roadworkMarkers = new Map();
    const breakdownTimers = new Map();
    const vehicleMarkers = new Map();
    const transitStops = new Map();
    const transitPeople = new Map();
    const schoolBadges = new Map();
    const pathLengths = new WeakMap();
    const pathSamples = new WeakMap();
    const junctionCurves = new Map();
    const exitNodes = new Set((data.nodes || []).filter((node) =>
      node.x < 0 || node.y < 0 || node.x > data.width || node.y > data.height).map((node) => node.id));
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let paintedRoute = new Map();
    let snapshot = null;
    let previousMotion = null;
    let currentMotion = null;
    let vehicleTracks = [];
    let pedestrianTracks = [];
    let roadworkTracks = [];
    let roadworksByVehicle = new Map();
    let incidentsByVehicle = new Map();
    let roadsideGeometry;
    let motionDirty = true;
    let lastFraction = -1;
    let renderOptions = {
      selectedStreetId: null, selectedVehicleId: null, selectedCrossingId: null,
      showCounts: false, showSignals: true, showLabels: true
    };
    let activeTooltipTarget = null;
    let activeTooltipText = "";
    let transform = { x: 0, y: 0, scale: 1 };
    let drag = null;
    let suppressClick = false;

    const make = (tag, attrs = {}) => {
      const element = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) {
        if (value !== undefined && value !== null) element.setAttribute(name, String(value));
      }
      return element;
    };
    const add = (parent, tag, attrs = {}) => {
      const element = make(tag, attrs);
      parent.appendChild(element);
      return element;
    };
    const clear = (element) => { while (element.firstChild) element.removeChild(element.firstChild); };

    function initializeSvg() {
      const sidePadding = 24;
      svg.setAttribute("viewBox", `${-sidePadding} 0 ${finite(data.width, 1440) + 2 * sidePadding} ${finite(data.height, 900)}`);
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      svg.setAttribute("role", "group");
      svg.setAttribute("aria-label", "Interactive traffic map. Select a street, vehicle, signal, or pedestrian crossing. Drag to pan.");
      svg.classList.add("traffic-map-svg");
      clear(svg);
      const defs = layers.defs = add(svg, "defs");
      const softShadow = add(defs, "filter", { id: "mapSoftShadow", x: "-40%", y: "-40%", width: "180%", height: "180%" });
      add(softShadow, "feDropShadow", { dx: 0, dy: 1.4, stdDeviation: 1.8, "flood-color": "#17211b", "flood-opacity": ".14" });
      const flyoverShadow = add(defs, "filter", { id: "mapFlyoverShadow", x: "-35%", y: "-35%", width: "170%", height: "190%" });
      add(flyoverShadow, "feDropShadow", { dx: 0, dy: 4, stdDeviation: 3, "flood-color": "#14201b", "flood-opacity": ".32" });
      const wetRoadPattern = add(defs, "pattern", { id: "mapWetRoadPattern", patternUnits: "userSpaceOnUse", width: 32, height: 32 });
      add(wetRoadPattern, "rect", { width: 32, height: 32, fill: "#648493", opacity: ".25" });
      add(wetRoadPattern, "path", { d: "M2 8H10M19 23H29M23 4H28", fill: "none", stroke: "#e5f0f2", "stroke-width": 1.2, opacity: ".76", "stroke-linecap": "round" });
      const snowRoadPattern = add(defs, "pattern", { id: "mapSnowRoadPattern", patternUnits: "userSpaceOnUse", width: 28, height: 28 });
      add(snowRoadPattern, "rect", { width: 28, height: 28, fill: "#eff4f2", opacity: ".94" });
      for (const [cx, cy, radius] of [[5, 7, 1.3], [18, 5, 1], [13, 18, 1.6], [24, 23, 1.2], [3, 25, .8]]) {
        add(snowRoadPattern, "circle", { cx, cy, r: radius, fill: "#fff", opacity: ".96" });
      }
      const treeShadow = add(defs, "filter", { id: "mapTreeShadow", x: "-40%", y: "-40%", width: "180%", height: "180%" });
      add(treeShadow, "feDropShadow", { dx: 0, dy: 1.5, stdDeviation: 2.2, "flood-color": "#26342a", "flood-opacity": ".15" });
      const dividerMask = add(defs, "mask", {
        id: "mapDividerMask",
        maskUnits: "userSpaceOnUse",
        maskContentUnits: "userSpaceOnUse",
        x: 0,
        y: 0,
        width: finite(data.width, 1440),
        height: finite(data.height, 900)
      });
      add(dividerMask, "rect", { x: 0, y: 0, width: finite(data.width, 1440), height: finite(data.height, 900), fill: "#fff" });
      layers.dividerMaskNodes = add(dividerMask, "g");
      makeCarGlyph(add(defs, "g", { id: "mapCarGlyph" }));
      makeCraneGlyph(add(defs, "g", { id: "mapCraneGlyph" }));
      makeBusGlyph(add(defs, "g", { id: "mapBusGlyph" }));
      makeMotorbikeGlyph(add(defs, "g", { id: "mapBikeGlyph" }));
      const walkingGlyph = add(defs, "g", { id: "mapWalkingGlyph" });
      add(walkingGlyph, "circle", { cx: 1.1, cy: -5, r: 1.5, class: "map-crossing-person-head" });
      add(walkingGlyph, "path", { d: "M-4 .2 -2.2 -2.1 1 -2.5 3 0 5 .3M.6 -2.3 -1.2 1.6 -4.7 5.5M-1.2 1.6 2.1 2.7 2.7 6", class: "map-crossing-person" });
      const pedestrianBody = add(defs, "g", { id: "mapPedestrianBody" });
      add(pedestrianBody, "rect", { x: -.55, y: -11.1, width: 1.1, height: 1.35, rx: .35, class: "map-pedestrian-skin" });
      add(pedestrianBody, "path", {
        d: "M-1.2 -10.2Q-2.1 -10.1-2.05 -9.06L-1.43 -5.82Q0 -5.25 1.43 -5.82L2.05 -9.06Q2.1 -10.1 1.2 -10.2Q0 -9.72-1.2 -10.2Z",
        class: "map-pedestrian-torso"
      });
      add(pedestrianBody, "circle", { cy: -12, r: 1.52, class: "map-pedestrian-skin" });
      add(pedestrianBody, "path", { d: "M-1.5 -12c0 -2.2 3 -2.2 3 0C.55 -12.1 .1 -12.74-.31 -12.65L-1.5 -12Z", class: "map-pedestrian-hair" });

      layers.camera = add(svg, "g", { class: "map-camera" });
      layers.ground = add(layers.camera, "rect", { x: 0, y: 0, width: finite(data.width, 1440), height: finite(data.height, 900), class: "map-ground" });
      layers.terrain = add(layers.camera, "g", { class: "map-terrain" });
      layers.selection = add(layers.camera, "g", { class: "map-road-selection-layer", "aria-hidden": "true" });
      layers.casing = add(layers.camera, "g", { class: "map-road-casing-layer" });
      layers.surfaces = add(layers.camera, "g", { class: "map-road-surface-layer" });
      layers.status = add(layers.camera, "g", { class: "map-road-status-layer", "aria-hidden": "true" });
      layers.hit = add(layers.camera, "g", { class: "map-road-hit-layer" });
      layers.routes = add(layers.camera, "g", { class: "map-route-layer", "aria-hidden": "true" });
      layers.centerlines = add(layers.camera, "g", { class: "map-road-centerline-layer", "aria-hidden": "true", mask: "url(#mapDividerMask)" });
      layers.arrows = add(layers.camera, "g", { class: "map-direction-arrow-layer", "aria-hidden": "true" });
      layers.counts = add(layers.camera, "g", { class: "map-road-count-layer", "aria-hidden": "true" });
      layers.crossingPaint = add(layers.camera, "g", { class: "map-crossing-paint-layer", "aria-hidden": "true" });
      layers.signals = add(layers.camera, "g", { class: "map-signal-layer" });
      layers.vehicles = add(layers.camera, "g", { class: "map-vehicle-layer" });
      layers.breakdowns = add(layers.camera, "g", { class: "map-breakdown-layer", "aria-hidden": "true" });
      layers.flyovers = add(layers.camera, "g", { class: "map-flyover-layer" });
      layers.elevatedVehicles = add(layers.camera, "g", { class: "map-vehicle-layer" });
      layers.elevatedBreakdowns = add(layers.camera, "g", { class: "map-breakdown-layer", "aria-hidden": "true" });
      layers.crossings = add(layers.camera, "g", { class: "map-crossing-layer" });
      layers.roadworks = add(layers.camera, "g", { class: "map-roadwork-markers" });
      layers.breakdownTimers = add(layers.camera, "g", { class: "map-breakdown-timers" });
      layers.labels = add(layers.camera, "g", { class: "map-label-layer", "aria-hidden": "true" });
      layers.stalledVehicles = add(layers.camera, "g", { class: "map-vehicle-layer map-stalled-vehicle-layer" });
      layers.transitPeople = add(layers.camera, "g", { class: "map-transit-people", "aria-hidden": "true" });
      layers.schoolActivity = add(layers.camera, "g", { class: "map-school-activity", "aria-hidden": "true" });

      renderTerrain();
      createRoads();
      createBusStops();
      createCrossings();
      svg.addEventListener("click", handleMapClick);
      svg.addEventListener("pointerdown", handlePointerDown);
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", finishPointer);
      window.addEventListener("pointercancel", finishPointer);
      svg.addEventListener("keydown", (event) => {
        if (event.key === "Escape") hideTooltip();
      });
      frame.addEventListener("keydown", (event) => {
        if (event.target !== frame && event.target !== svg) return;
        const moves = { ArrowLeft: [48, 0], ArrowRight: [-48, 0], ArrowUp: [0, 48], ArrowDown: [0, -48] };
        if (!moves[event.key]) return;
        event.preventDefault();
        transform.x += moves[event.key][0];
        transform.y += moves[event.key][1];
        applyTransform();
      });
      window.addEventListener("resize", () => {
        if (activeTooltipTarget) positionTooltip(activeTooltipTarget);
      });
      resetView();
    }

    function renderTerrain() {
      for (const shape of data.blocks || []) {
        if (!shape.path) continue;
        const type = shape.type === "park" || shape.type === "water" ? shape.type : "block";
        if (type === "block" && data.buildings?.length) continue;
        add(layers.terrain, "path", { d: shape.path, class: `map-${type}-shape` });
      }
      for (const ground of data.grounds || []) {
        const { width: w, height: h } = ground;
        const group = add(layers.terrain, "g", { transform: `translate(${ground.x} ${ground.y})`, class: `map-place-ground is-${ground.kind}` });
        add(group, "rect", { width: w, height: h, rx: 7, class: "map-place-lawn" });
        if (ground.kind === "school") {
          add(group, "path", { d: `M${w - 27} 0V-11H${w + 14}V-28`, class: "map-place-footpath" });
          add(group, "rect", { x: 14, y: h - 44, width: 47, height: 33, rx: 2, class: "map-school-court" });
          add(group, "path", { d: `M15 ${h - 27.5}H60M37.5 ${h - 43}V${h - 12}`, class: "map-school-court-lines" });
        } else {
          add(group, "path", { d: `M5 ${h - 11}Q${w * .5} -8 ${w - 5} 12`, class: "map-place-footpath" });
          for (const [x, y] of [[29, 13], [57, h - 16]]) {
            add(group, "path", { d: `M${x} ${y}h13m-11 3h9`, class: "map-park-bench" });
          }
        }
      }
      for (const building of data.buildings || []) renderBuilding(building);
      for (const tree of data.trees || []) {
        const radius = finite(tree.r, 8);
        const group = add(layers.terrain, "g", { class: "map-tree-symbol", "aria-hidden": "true" });
        add(group, "circle", { cx: tree.x, cy: tree.y, r: radius, class: "map-tree-crown" });
        add(group, "circle", { cx: finite(tree.x) - radius * .2, cy: finite(tree.y) - radius * .2, r: radius * .35, class: "map-tree-core" });
      }
      for (const district of data.districts || []) {
        const label = add(layers.terrain, "text", { x: district.x, y: district.y, "text-anchor": "middle", "font-size": district.size || 21,
          class: "map-district-name", "data-district": district.id });
        if (district.lines?.length) district.lines.forEach((line, index) => {
          add(label, "tspan", { x: district.x, dy: index ? 18 : 0 }).textContent = line;
        });
        else label.textContent = district.name;
      }
    }

    function renderBuilding(building) {
      const { width: w, height: h } = building;
      const group = add(layers.terrain, "g", { transform: `translate(${building.x} ${building.y})`,
        class: `map-building is-${building.kind} tone-${building.tone || "sand"}`, "data-building": building.id });
      if (building.name) add(group, "title").textContent = building.name;
      add(group, "rect", { x: 2.5, y: 4, width: w, height: h, rx: 3, class: "map-building-shadow" });
      add(group, "rect", { y: 3, width: w, height: h, rx: 2.5, class: "map-building-wall" });
      add(group, "rect", { width: w, height: h, rx: 2.5, class: "map-building-roof" });
      if (building.kind === "home") {
        add(group, "path", { d: `M${w / 2} 5V${h - 5}M3 3L${w / 2} 8L${w - 3} 3M3 ${h - 3}L${w / 2} ${h - 8}L${w - 3} ${h - 3}`, class: "map-building-ridge" });
        add(group, "rect", { x: w - 11, y: 6, width: 5, height: 7, rx: .7, class: "map-building-chimney" });
        add(group, "rect", { x: w * .38, y: h + 1, width: w * .24, height: 4, rx: 1, class: "map-building-entrance" });
      } else {
        add(group, "rect", { x: 4, y: 4, width: w - 8, height: h - 8, rx: 1, class: "map-building-roof-inset" });
        add(group, "rect", { x: w * .27, y: h * .28, width: w * .25, height: h * .27, rx: 1, class: "map-building-skylight" });
        add(group, "rect", { x: w - 13, y: 7, width: 6, height: 7, rx: 1, class: "map-building-chimney" });
      }
      if (building.kind === "shop") {
        for (let x = 4; x < w - 5; x += 7) add(group, "rect", { x, y: h - 1, width: 6, height: 5, rx: .6, class: "map-shop-awning" });
      } else if (building.kind === "school") {
        for (let x = 9; x < w - 7; x += 13) add(group, "rect", { x, y: h - 4, width: 7, height: 3, class: "map-building-skylight" });
      }
    }

    function createBusStops() {
      for (const stop of data.busStops || []) {
        const road = roads.get(stop.streetId);
        if (!road) continue;
        const pose = pathPose(road.surface, stop.progress, Boolean(stop.reverse), roadHalfWidth(road.street) + 9);
        if (!pose) continue;
        const group = add(layers.terrain, "g", { transform: `translate(${pose.x} ${pose.y}) rotate(${pose.angle})`, class: "map-bus-stop", "data-bus-stop": stop.id });
        add(group, "title").textContent = `${stop.name} bus stop`;
        add(group, "path", { d: "M-20 -6H16", class: "map-bus-stop-curb" });
        add(group, "rect", { x: -13, y: 0, width: 24, height: 7, rx: 1.4, class: "map-bus-shelter" });
        add(group, "path", { d: "M-10 4H8", class: "map-bus-stop-bench" });
        const sign = add(group, "g", { transform: `translate(21 0) rotate(${-pose.angle})` });
        add(sign, "rect", { x: -5.5, y: -6.5, width: 11, height: 13, rx: 2, class: "map-bus-stop-sign" });
        add(sign, "text", { y: 3, "text-anchor": "middle", class: "map-bus-stop-letter" }).textContent = "B";
        const overflow = add(layers.transitPeople, "text", { class: "map-stop-overflow", "text-anchor": "middle", display: "none" });
        transitStops.set(stop.id, { stop, road, pose, group, overflow });
      }
      for (const school of data.schools || []) {
        const group = add(layers.schoolActivity, "g", { transform: `translate(${school.gate.x - 77} ${school.gate.y - 12})`, class: "map-school-badge" });
        add(group, "rect", { x: -59, y: -10, width: 118, height: 20, rx: 4 });
        const label = add(group, "text", { y: 4, "text-anchor": "middle" });
        schoolBadges.set(school.id, { group, label });
      }
    }

    function transitPoint(stopId, slot, kind) {
      const entry = transitStops.get(stopId);
      if (!entry) return null;
      const { stop, road } = entry;
      const at = pathPose(road.surface, stop.progress, Boolean(stop.reverse), laneCenter(road.street));
      if (kind === "door" || kind === "rear-door") {
        const along = kind === "rear-door" ? -10 : 10;
        return { x: at.x + Math.cos(at.angle * Math.PI / 180) * along - Math.sin(at.angle * Math.PI / 180) * 6,
          y: at.y + Math.sin(at.angle * Math.PI / 180) * along + Math.cos(at.angle * Math.PI / 180) * 6 };
      }
      const curb = pathPose(road.surface, stop.progress, Boolean(stop.reverse), roadHalfWidth(road.street) + 18);
      const angle = curb.angle * Math.PI / 180;
      const along = kind === "away" ? 40 : -16.5 + (slot % maxVisibleStopPeople) * 11;
      return { x: curb.x + Math.cos(angle) * along, y: curb.y + Math.sin(angle) * along };
    }

    function animateTransport(fraction) {
      const desired = new Set();
      const motions = currentMotion.passengerMotions || [];
      const representativeMotions = new Map();
      for (const kind of ["boarding", "alighting", "walking-away"]) for (const motion of motions) {
        if (motion.kind === kind && motion.stopId && !representativeMotions.has(motion.stopId)) representativeMotions.set(motion.stopId, motion);
      }
      for (const [stopId, entry] of transitStops) {
        const retained = motions.find(motion => motion.stopId === stopId && motion.id === entry.movingPersonId);
        if (retained) representativeMotions.set(stopId, retained);
        entry.movingPersonId = representativeMotions.get(stopId)?.id || null;
      }
      const previousWaitingSlots = new Map();
      for (const stop of previousMotion.busStops || []) {
        stop.waiting.slice(0, maxVisibleStopPeople).forEach((person, index) => previousWaitingSlots.set(person.id, index));
      }
      const place = (id, point, child, distance = 0, total = 0, dx = 0, dy = 0, stopId = null, scale = 1) => {
        if (!point) return;
        desired.add(id);
        let person = transitPeople.get(id);
        if (!person) {
          const jacket = child ? "#c88447" : pedestrianJackets[Array.from(id).reduce((sum, c) => sum + c.charCodeAt(0), 0) % pedestrianJackets.length];
          person = createCrossingPerson(layers.transitPeople, "transit", jacket);
          person.group.classList.add("map-transit-person", "is-visible");
          person.group.dataset.personId = id;
          transitPeople.set(id, person);
        }
        if (stopId) person.group.dataset.stopId = stopId;
        else delete person.group.dataset.stopId;
        person.group.setAttribute("transform", `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)}) scale(${scale})`);
        const length = Math.hypot(dx, dy) || 1;
        posePedestrian(person, distance, total, dx / length, dy / length);
      };
      for (const state of currentMotion.busStops || []) {
        const entry = transitStops.get(state.id);
        const visibleWaiting = Math.min(state.waiting.length, maxVisibleStopPeople - Number(representativeMotions.has(state.id)));
        const extraWaiting = state.waiting.length - visibleWaiting;
        if (entry) {
          entry.group.setAttribute("aria-label", `${entry.stop.name} bus stop, ${state.waiting.length} people waiting`);
          entry.overflow.setAttribute("display", extraWaiting ? "inline" : "none");
          entry.overflow.setAttribute("aria-label", `${extraWaiting} additional people waiting`);
          if (extraWaiting) {
            const point = transitPoint(state.id, maxVisibleStopPeople - 1, "platform"), angle = entry.pose.angle * Math.PI / 180;
            entry.overflow.setAttribute("x", point.x + Math.cos(angle) * 26);
            entry.overflow.setAttribute("y", point.y + Math.sin(angle) * 26 - 2);
            entry.overflow.textContent = `+${extraWaiting}`;
          }
        }
        state.waiting.slice(0, visibleWaiting).forEach((person, index) => {
          place(person.id, transitPoint(state.id, index, "platform"), person.child, 0, 0, 0, 0, state.id);
        });
      }
      const previous = new Map((previousMotion.passengerMotions || []).map(item => [item.id, item]));
      for (const motion of currentMotion.passengerMotions || []) {
        if (motion.stopId && representativeMotions.get(motion.stopId) !== motion) continue;
        const before = previous.get(motion.id);
        const progress = before?.kind === motion.kind ? mix(before.progress, motion.progress, fraction) : motion.progress;
        let start, end, via;
        if (motion.schoolId) {
          const school = (data.schools || []).find(item => item.id === motion.schoolId);
          const road = school && roads.get(school.streetId);
          if (!road) continue;
          start = pathPose(road.surface, school.progress, Boolean(school.reverse), roadHalfWidth(road.street) + 12);
          via = school.gate;
          end = school.entrance;
          if (motion.kind === "school-pickup") [start, end] = [end, start];
        } else {
          const slot = previousWaitingSlots.get(motion.id) ?? motion.slot % maxVisibleStopPeople;
          start = transitPoint(motion.stopId, slot, "platform");
          end = transitPoint(motion.stopId, slot, motion.kind === "walking-away" ? "away" : "door");
          if (motion.kind === "alighting") [start, end] = [transitPoint(motion.stopId, slot, "rear-door"), start];
        }
        if (!start || !end) continue;
        const a = via && progress < .5 ? start : via || start;
        const b = via && progress < .5 ? via : end;
        const local = via ? progress < .5 ? progress * 2 : (progress - .5) * 2 : progress;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        place(motion.id, { x: mix(a.x, b.x, local), y: mix(a.y, b.y, local) }, motion.child,
          local * length, length, b.x - a.x, b.y - a.y, motion.stopId, motion.schoolId ? .47 : 1);
      }
      for (const [id, person] of transitPeople) if (!desired.has(id)) {
        person.group.remove();
        transitPeople.delete(id);
      }
      for (const school of currentMotion.schools || []) {
        const badge = schoolBadges.get(school.id);
        if (!badge) continue;
        badge.group.dataset.phase = school.phase;
        badge.label.textContent = school.phase === "closed" ? "School · quiet" : `${school.phase === "pickup" ? "Pickup" : "Drop-off"} · ${school.carsInNetwork} cars`;
      }
    }

    function createRoads() {
      for (const street of data.streets || []) {
        const widthClass = street.major ? "major" : "minor";
        const oneWayClass = street.oneWay ? " one-way" : "";
        const flyoverClass = street.flyover ? " flyover" : "";
        const specialClasses = `${oneWayClass}${flyoverClass}`;
        const selection = add(layers.selection, "path", { d: street.path, class: `map-road-selection ${widthClass}${specialClasses}` });
        const casing = add(layers.casing, "path", { d: street.path, class: `map-road-casing ${widthClass}${specialClasses}` });
        const surface = add(layers.surfaces, "path", { d: street.path, class: `map-road-surface ${widthClass}${specialClasses}` });
        const centerline = add(layers.centerlines, "path", { d: street.path, class: `map-road-centerline ${widthClass}${specialClasses}` });
        const start = pointAt(surface, 0);
        const end = pointAt(surface, 1);
        if (start) add(layers.dividerMaskNodes, "circle", { cx: start.x, cy: start.y, r: 19, fill: "#000" });
        if (end) add(layers.dividerMaskNodes, "circle", { cx: end.x, cy: end.y, r: 19, fill: "#000" });
        const state = add(layers.status, "g", { class: "map-road-state", "aria-hidden": "true" });
        add(state, "path", { d: street.path, class: `map-road-weather-overlay ${widthClass}${specialClasses}` });
        const bikeOffsets = street.oneWay
          ? [{ reverse: false, offset: 0 }]
          : [
            { reverse: false, offset: laneCenter(street) },
            { reverse: true, offset: laneCenter(street) }
          ];
        for (const lane of bikeOffsets) {
          const lanePath = offsetRoadPath(surface, lane.reverse, lane.offset);
          add(state, "path", { d: lanePath, class: `map-road-bike-lane ${widthClass}${specialClasses}` });
          add(state, "path", { d: lanePath, class: `map-road-bike-lane-guide ${widthClass}${specialClasses}` });
        }
        const closureLine = add(state, "path", { d: street.path, class: "map-road-closed-line" });
        const marker = add(state, "g", { class: "map-road-condition-marker", transform: "translate(0 0)" });
        add(marker, "circle", { r: 11, class: "map-condition-disc" });
        add(marker, "path", { d: "M-4 -4L4 4M4 -4L-4 4", class: "map-condition-cross" });
        const warning = add(street.flyover ? layers.elevatedBreakdowns : layers.breakdowns, "g", {
          class: "map-breakdown-marker", "data-for-street": street.id
        });
        add(warning, "rect", { x: -10, y: -4.9, width: 20, height: 9.8, rx: 3.4, class: "map-breakdown-carbody" });
        add(warning, "rect", { x: -4, y: -3.1, width: 8, height: 6.2, rx: 1.8, class: "map-breakdown-window" });
        add(warning, "path", { d: "M-8 -2.6h1.5m-1.5 5.2h1.5m13-5.2h1.5m-1.5 5.2h1.5", class: "map-breakdown-lights" });
        const flag = add(warning, "g", { class: "map-breakdown-flag" });
        drawBreakdownFlag(flag);
        const labelPoint = labelPosition(street, surface);
        const bikeMarking = createBikeMarking(state, street, surface, labelPoint);
        createWeatherMarker(state, street, surface, labelPoint);

        const group = add(layers.hit, "g", {
          class: "map-street-hit",
          "data-street-id": street.id,
          tabindex: "0",
          role: "button",
          "aria-pressed": "false",
          "aria-label": `Select street ${street.id}${street.oneWay ? ", one way" : ", two way"}${street.flyover ? ", elevated flyover" : ""}`
        });
        add(group, "path", { d: street.path, class: `map-road-hitpath ${widthClass}${specialClasses}` });
        group.addEventListener("click", (event) => {
          event.stopPropagation();
          if (suppressClick) return;
          onStreetSelect(street.id);
        });
        group.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onStreetSelect(street.id);
          }
        });
        group.addEventListener("pointerenter", () => paintRoad(street.id));
        group.addEventListener("pointerleave", () => paintRoad(street.id));
        group.addEventListener("focus", () => paintRoad(street.id));
        group.addEventListener("blur", () => paintRoad(street.id));

        const arrows = add(layers.arrows, "g");
        createDirectionalArrows(arrows, street, surface, labelPoint);
        const visibleLabelPoint = crossingAwareLabelPosition(street, surface, labelPoint);
        const labelGroup = add(layers.labels, "g", {
          class: "map-street-label",
          transform: `translate(${visibleLabelPoint.x} ${visibleLabelPoint.y}) rotate(${uprightAngle(finite(street.label?.angle))})`,
          "data-for-street": street.id,
          "aria-hidden": "true"
        });
        add(labelGroup, "rect", { x: -23, y: -13, width: 46, height: 26, rx: 7, class: "map-label-plate" });
        const labelText = add(labelGroup, "text", { x: 0, y: .5, class: "map-label-text" });
        labelText.textContent = street.id;

        const countGroup = add(layers.counts, "g", { class: "map-road-count", transform: `translate(${visibleLabelPoint.x} ${visibleLabelPoint.y + 19})`, "data-for-street": street.id });
        add(countGroup, "rect", { x: -36, y: -8, width: 72, height: 16, rx: 8, class: "map-road-count-plate" });
        const countText = add(countGroup, "text", { x: 0, y: .4, class: "map-road-count-text" });
        countText.textContent = "0 vehicles · Q0";
        const routePath = add(layers.routes, "path", { d: street.path, class: "map-selected-route" });
        if (street.flyover && start && end) {
          createFlyoverDeck(street, start, end, { selection, casing, surface, state, centerline, routePath, arrows });
        }

        roads.set(street.id, { street, selection, casing, surface, centerline, state, closureLine, marker, warning, bikeMarking,
          flag, group, labelGroup, labelPoint: visibleLabelPoint, countGroup, countText, routePath });
        roadStates.set(street.id, { closed: false, breakdown: false, bikeOnly: false, surfaceWeather: "clear" });
      }
    }

    function createFlyoverDeck(street, start, end, elements) {
      const clipId = `mapFlyoverClip-${street.id}`;
      const clip = add(layers.defs, "clipPath", { id: clipId });
      const circle = ({ x, y }) => `M${x - 30} ${y}a30 30 0 1 0 60 0a30 30 0 1 0 -60 0Z`;
      add(clip, "path", {
        d: `M0 0H${data.width}V${data.height}H0Z${circle(start)}${circle(end)}`,
        "clip-rule": "evenodd"
      });
      // Continue the road colors at its approaches. Only the raised span
      // occludes ground traffic at crossings.
      const deck = add(layers.flyovers, "g", { "clip-path": `url(#${clipId})`, "aria-hidden": "true" });
      for (const [name, element] of Object.entries(elements)) {
        const id = `mapFlyover-${street.id}-${name}`;
        element.setAttribute("id", id);
        const overlay = add(deck, "use", { href: `#${id}`, "pointer-events": "none" });
        if (name === "casing") overlay.setAttribute("filter", "url(#mapFlyoverShadow)");
      }
      const hit = add(deck, "path", { d: street.path, class: "map-road-hitpath map-flyover-hitpath" });
      hit.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!suppressClick) onStreetSelect(street.id);
      });
    }

    function laneCenter(street) {
      if (street.oneWay) return 0;
      // Keep each direction in its right-hand lane, one quarter of the
      // rendered road width away from the center divider.
      return street.major ? 10.5 : 7.5;
    }

    function offsetRoadPath(path, reverse, offset) {
      const length = lengthFor(path);
      const steps = Math.max(2, Math.ceil(length / 8));
      const points = [];
      for (let index = 0; index <= steps; index += 1) {
        const pose = pathPose(path, index / steps, reverse, offset);
        if (pose) points.push(`${pose.x.toFixed(2)},${pose.y.toFixed(2)}`);
      }
      return points.length ? `M${points[0]} L${points.slice(1).join(" ")}` : "";
    }

    function roadSignalPoints(street, path) {
      const definitions = snapshot?.signals?.length ? snapshot.signals : data.signals || [];
      return definitions.filter((signal) => signal.streetId === street.id).map((signal) => {
        const reverse = Boolean(signal.reverse);
        const nodeId = signal.nodeId || (reverse ? street.from : street.to);
        const key = signal.id || `${nodeId}:${street.id}:${reverse ? 1 : 0}`;
        const head = data.signalLayouts?.[key]?.head;
        if (head && Number.isFinite(Number(head.x)) && Number.isFinite(Number(head.y))) {
          return { x: Number(head.x), y: Number(head.y) };
        }
        return pathPose(path, finite(signal.progress, .84), reverse, 0);
      }).filter(Boolean);
    }

    function roadVehiclePoints(street, path) {
      const fromSnapshot = Array.isArray(snapshot?.vehicles);
      const vehicles = fromSnapshot ? snapshot.vehicles : data.vehicles || [];
      const length = lengthFor(path);
      const points = [];
      for (const vehicle of vehicles) {
        if (vehicle.streetId !== street.id) continue;
        const reverse = Boolean(vehicle.reverse);
        if (fromSnapshot) {
          const pose = pathPose(path, clamp(finite(vehicle.progress), 0, 1), reverse, laneCenter(street));
          if (pose) points.push(pose);
          continue;
        }
        const count = clamp(Math.floor(finite(vehicle.count, 1)), 1, 20);
        const baseTravel = reverse ? 1 - finite(vehicle.progress, .5) : finite(vehicle.progress, .5);
        const gap = 7.2 / Math.max(1, length);
        for (let index = 0; index < count; index += 1) {
          const travel = clamp(baseTravel + (count - 1) * gap / 2 - index * gap, .025, .975);
          const pose = pathPose(path, travel, reverse, laneCenter(street));
          if (pose) points.push(pose);
        }
      }
      return points;
    }

    function chooseRoadMarkerPose(street, path, labelPoint, offset, clearance = 34, avoidVehicles = false) {
      const signalPoints = roadSignalPoints(street, path);
      const arrowPoints = street.oneWay
        ? [pathPose(path, .5, false, 0)]
        : [pathPose(path, .25, false, laneCenter(street)), pathPose(path, .75, true, laneCenter(street))];
      const obstacles = signalPoints.concat(arrowPoints.filter(Boolean), avoidVehicles ? roadVehiclePoints(street, path) : []);
      const candidates = [.24, .31, .39, .47, .55, .63, .71, .78].map((progress) => {
        const pose = pathPose(path, progress, false, offset);
        if (!pose) return null;
        const labelDistance = labelPoint ? Math.hypot(pose.x - labelPoint.x, pose.y - labelPoint.y) : Infinity;
        const obstacleDistance = obstacles.length
          ? Math.min(...obstacles.map((point) => Math.hypot(pose.x - point.x, pose.y - point.y)))
          : Infinity;
        return { pose, score: Math.min(labelDistance, obstacleDistance) };
      }).filter(Boolean);
      const clear = candidates.filter((candidate) => candidate.score >= clearance);
      return (clear.length ? clear : candidates).sort((a, b) => b.score - a.score)[0]?.pose || pathPose(path, .5, false, offset);
    }

    function createBikeMarking(parent, street, path, labelPoint) {
      const offset = street.oneWay ? 0 : laneCenter(street);
      const pose = chooseRoadMarkerPose(street, path, labelPoint, offset, 36, true);
      if (!pose) return null;
      const marker = add(parent, "g", {
        class: "map-bike-road-marking",
        transform: `translate(${pose.x} ${pose.y}) rotate(${pose.angle})`,
        "aria-hidden": "true"
      });
      add(marker, "circle", { r: 8, class: "map-bike-marking-disc" });
      add(marker, "circle", { cx: -4, cy: 1.5, r: 2.25, class: "map-bike-marking-wheel" });
      add(marker, "circle", { cx: 4.6, cy: 1.5, r: 2.25, class: "map-bike-marking-wheel" });
      add(marker, "path", { d: "M-4 1.5L-1.4 -2.1L1 1.5L4.6 1.5M-1.4 -2.1L2 -2.1M-1.4 -2.1L-.2 -3.5M2 -2.1L3.2 -3.5", class: "map-bike-marking-frame" });
      return marker;
    }

    function createWeatherMarker(parent, street, path, labelPoint) {
      const halfWidth = street.major ? 21 : street.oneWay ? 11 : 15;
      const pose = chooseRoadMarkerPose(street, path, labelPoint, halfWidth + 13, 42);
      if (!pose) return null;
      const marker = add(parent, "g", {
        class: "map-weather-marker",
        transform: `translate(${pose.x} ${pose.y})`,
        "aria-hidden": "true"
      });
      add(marker, "circle", { r: 10, class: "map-weather-disc" });
      const wet = add(marker, "g", { class: "map-weather-icon weather-wet-icon" });
      add(wet, "path", { d: "M-7 1C-9 -2-6 -5-3 -4C-1 -8 5 -7 6 -3C10 -3 10 3 6 3H-4C-7 3-8 2-7 1Z", class: "map-weather-cloud" });
      add(wet, "path", { d: "M-4 5L-5.5 8M1 5L-.5 8M6 5L4.5 8", class: "map-weather-rain" });
      const snow = add(marker, "g", { class: "map-weather-icon weather-snow-icon" });
      add(snow, "path", { d: "M0 -6V6M-5.2 -3L5.2 3M-5.2 3L5.2 -3M-2 -4.8L0 -3.8L2 -4.8M-2 4.8L0 3.8L2 4.8M-5.2 -.7L-3.2 -1.1L-3.2 -3.1M5.2 .7L3.2 1.1L3.2 3.1M-5.2 .7L-3.2 1.1L-3.2 3.1M5.2 -.7L3.2 -1.1L3.2 -3.1", class: "map-weather-snowflake" });
      return marker;
    }

    function createDirectionalArrows(parent, street, path, labelPoint) {
      const length = lengthFor(path);
      if (length < 90) return;
      const offset = laneCenter(street);
      const crossesBoundary = exitNodes.has(street.from) || exitNodes.has(street.to);
      const base = street.oneWay ? .5 : .25;
      const candidates = street.oneWay ? [.5, .45, .55, .4, .6, .35, .65] : [.25, .3, .2, .35, .16];
      // The preferred position for an arrow can be outside the map on a boundary road.
      if (crossesBoundary) {
        for (const progress of [.4, .45, .5, .55, .6, .65, .7, .75, .8, .85]) {
          if (!candidates.includes(progress)) candidates.push(progress);
        }
      }
      for (const reverse of street.oneWay ? [false] : [false, true]) {
        const options = candidates.map((progress) => {
          const pose = pathPose(path, progress, reverse, offset);
          const distance = pose ? Math.hypot(pose.x - labelPoint.x, pose.y - labelPoint.y) : 0;
          return { progress, distance, pose };
        }).filter(({ pose }) => pose && (!crossesBoundary ||
          (pose.x >= 8 && pose.x <= data.width - 8 && pose.y >= 8 && pose.y <= data.height - 8)));
        const clear = options.filter((item) => item.distance >= 38);
        const chosen = (clear.length ? clear : options.filter((item) => item.distance >= 28))
          .sort((a, b) => Math.abs(a.progress - base) - Math.abs(b.progress - base))[0];
        if (!chosen) continue;
        const arrow = add(parent, "g", {
          class: `map-direction-arrow${street.oneWay ? " one-way" : ""}`,
          transform: `translate(${chosen.pose.x} ${chosen.pose.y}) rotate(${chosen.pose.angle})`,
          "aria-hidden": "true"
        });
        add(arrow, "path", { d: "M-7 0H5M0 -4L5 0L0 4", class: "map-direction-arrow-mark" });
      }
    }

    function labelPosition(street, path) {
      if (Number.isFinite(Number(street.label?.x)) && Number.isFinite(Number(street.label?.y))) return { x: Number(street.label.x), y: Number(street.label.y) };
      return pointAt(path, .5) || { x: 0, y: 0 };
    }

    function crossingAwareLabelPosition(street, path, labelPoint) {
      const overlapsCrossing = (data.pedestrianCrossings || []).some((crossing) => {
        if (crossing.streetId !== street.id || !Number.isFinite(crossing.progress)) return false;
        const pose = pathPose(path, crossing.progress, Boolean(crossing.reverse));
        return pose && Math.hypot(pose.x - labelPoint.x, pose.y - labelPoint.y) < 31;
      });
      return overlapsCrossing ? pointAt(path, .5) || labelPoint : labelPoint;
    }

    function uprightAngle(angle) {
      let normalized = ((angle % 360) + 360) % 360;
      if (normalized > 90 && normalized < 270) normalized -= 180;
      return normalized;
    }

    function pathPose(path, progress, reverse = false, offset = 0) {
      if (!path || typeof path.getTotalLength !== "function") return null;
      try {
        let samples = pathSamples.get(path);
        if (!samples) {
          const length = lengthFor(path);
          if (!Number.isFinite(length) || length <= 0) return null;
          const steps = Math.max(2, Math.ceil(length / 3));
          const points = Array.from({ length: steps + 1 }, (_, index) => path.getPointAtLength(index * length / steps));
          samples = points.map((point, index) => {
            const a = points[Math.max(index - 1, 0)];
            const b = points[Math.min(index + 1, steps)];
            return { x: point.x, y: point.y, angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI };
          });
          pathSamples.set(path, samples);
        }
        const p = clamp(finite(progress), 0, 1);
        const at = (reverse ? 1 - p : p) * (samples.length - 1);
        const index = Math.min(Math.floor(at), samples.length - 2);
        const a = samples[index];
        const b = samples[index + 1];
        const fraction = at - index;
        const angle = a.angle + ((b.angle - a.angle + 540) % 360 - 180) * fraction + (reverse ? 180 : 0);
        const radians = angle * Math.PI / 180;
        return { x: mix(a.x, b.x, fraction) - Math.sin(radians) * offset, y: mix(a.y, b.y, fraction) + Math.cos(radians) * offset, angle };
      } catch {
        return null;
      }
    }

    function pointAt(path, progress) {
      if (!path || typeof path.getTotalLength !== "function") return null;
      try {
        const length = lengthFor(path);
        const point = path.getPointAtLength(length * clamp(finite(progress), 0, 1));
        return { x: point.x, y: point.y };
      } catch { return null; }
    }

    function lengthFor(path) {
      let length = pathLengths.get(path);
      if (length === undefined) {
        length = path.getTotalLength();
        pathLengths.set(path, length);
      }
      return length;
    }

    function paintRoad(id) {
      const entry = roads.get(id);
      if (!entry) return;
      const selected = id === renderOptions.selectedStreetId;
      const active = selected || entry.group.matches(":hover") || document.activeElement === entry.group;
      entry.selection.classList.toggle("visible", active);
      entry.group.classList.toggle("selected", selected);
      entry.group.setAttribute("aria-pressed", String(selected));
      entry.labelGroup.classList.toggle("selected", selected);
    }

    function renderRoadStates() {
      const states = new Map((snapshot?.roads || []).map((road) => [road.id, road]));
      for (const [id, entry] of roads) {
        const road = states.get(id) || {};
        const prev = roadStates.get(id) || {};
        const surfaceWeather = ["wet", "snow"].includes(road.surfaceWeather) ? road.surfaceWeather : "clear";
        const next = {
          closed: Boolean(road.manualClosed ?? (road.closed && !road.workClosed)),
          breakdown: Boolean(road.breakdown), breakdownRecovering: Boolean(road.breakdownRecovering),
          manualBreakdown: Boolean(road.manualBreakdownActive ?? ((road.manualBreakdown ?? road.breakdown) && !road.autoBreakdown)),
          bikeOnly: Boolean(road.bikeOnly), surfaceWeather
        };
        entry.casing.classList.toggle("closed", next.closed);
        entry.surface.classList.toggle("closed", next.closed);
        entry.centerline.classList.toggle("closed", next.closed);
        entry.casing.classList.toggle("weather-wet", surfaceWeather === "wet");
        entry.casing.classList.toggle("weather-snow", surfaceWeather === "snow");
        entry.surface.classList.toggle("weather-wet", surfaceWeather === "wet");
        entry.surface.classList.toggle("weather-snow", surfaceWeather === "snow");
        entry.state.classList.toggle("is-closed", next.closed);
        entry.warning.classList.toggle("is-visible", next.manualBreakdown);
        entry.state.classList.toggle("bike-only", next.bikeOnly);
        entry.state.classList.toggle("is-wet", surfaceWeather === "wet");
        entry.state.classList.toggle("is-snow", surfaceWeather === "snow");
        if (next.bikeOnly && !prev.bikeOnly && entry.bikeMarking) {
          const offset = entry.street.oneWay ? 0 : laneCenter(entry.street);
          const labelPoint = labelPosition(entry.street, entry.surface);
          const pose = chooseRoadMarkerPose(entry.street, entry.surface, labelPoint, offset, 36, true);
          if (pose) entry.bikeMarking.setAttribute("transform", `translate(${pose.x} ${pose.y}) rotate(${pose.angle})`);
        }
        if (next.closed && !prev.closed) {
          const point = pointAt(entry.surface, .5);
          if (point) entry.marker.setAttribute("transform", `translate(${point.x} ${point.y})`);
        }
        if (next.manualBreakdown && (!prev.manualBreakdown ||
          prev.breakdownProgress !== road.breakdownProgress || prev.breakdownReverse !== road.breakdownReverse)) {
          const offset = laneCenter(entry.street) + (entry.street.major ? 5 : 4.5);
          const pose = pathPose(entry.surface, finite(road.breakdownProgress, .52), Boolean(road.breakdownReverse), offset);
          if (pose) {
            entry.warning.setAttribute("transform", `translate(${pose.x} ${pose.y}) rotate(${pose.angle})`);
            entry.flag.setAttribute("transform", `translate(0 11) rotate(${-pose.angle})`);
          }
        }
        next.breakdownProgress = road.breakdownProgress;
        next.breakdownReverse = road.breakdownReverse;
        entry.state.classList.toggle("show-condition-marker", next.closed || next.breakdown);
        if (renderOptions.showCounts) {
          entry.countGroup.classList.remove("is-hidden");
          const count = Math.max(0, Math.floor(finite(road.count)));
          const queue = Math.max(0, Math.floor(finite(road.queue)));
          const label = `${count} vehicles · Q${queue}`;
          if (entry.countText.textContent !== label) entry.countText.textContent = label;
        } else entry.countGroup.classList.add("is-hidden");
        roadStates.set(id, next);
      }
    }

    function createRoadworkMarker(job, road) {
      const anchor = pathPose(road.surface, .5);
      if (!anchor) return null;
      const radius = roadHalfWidth(road.street);
      const length = lengthFor(road.surface);
      const site = make("g", { class: "map-roadwork-site", "data-roadwork-site": road.street.id });
      road.state.insertBefore(site, road.closureLine);
      const paving = add(site, "path", {
        d: road.street.path, pathLength: 1, "stroke-width": radius * 2 - 1,
        class: "map-roadwork-paving"
      });
      const occupiedProgress = [...Object.values(data.signalLayouts || {}), ...(data.pedestrianCrossings || [])]
        .filter((entry) => entry.streetId === road.street.id)
        .map((entry) => entry.reverse ? 1 - entry.progress : entry.progress);
      const setback = Math.min(48 / length, .29);
      for (const end of [0, 1]) {
        const positions = [setback, setback + 10 / length, setback - 9 / length]
          .filter((value) => value > .12 && value < .45)
          .map((value) => end ? 1 - value : value);
        const progress = positions.find((value) => occupiedProgress.every((other) => Math.abs(value - other) * length > 10))
          ?? (end ? 1 - setback : setback);
        const pose = pathPose(road.surface, progress);
        if (!pose) continue;
        const span = radius * .72;
        const barrier = add(site, "g", {
          class: "map-roadwork-barrier", transform: `translate(${pose.x} ${pose.y}) rotate(${pose.angle})`
        });
        add(barrier, "rect", { x: -3.1, y: -span, width: 6.2, height: span * 2, rx: 1.2, class: "map-roadwork-barrier-board" });
        const hatches = [];
        for (let y = -span + 1; y + 3.2 <= span - .8; y += 4.8) hatches.push(`M-2.2 ${y} 2.2 ${y + 3.2}`);
        add(barrier, "path", { d: hatches.join(" "), class: "map-roadwork-barrier-hatch" });
      }

      const spot = placeRoadsideBadge(anchor, radius, 42, 15);
      const angle = anchor.angle * Math.PI / 180;
      const group = add(layers.roadworks, "g", {
        class: "map-roadwork-marker", role: "button", tabindex: "0", "data-roadwork-target": road.street.id
      });
      add(group, "line", {
        x1: anchor.x - Math.sin(angle) * radius * spot.side, y1: anchor.y + Math.cos(angle) * radius * spot.side,
        x2: spot.x, y2: spot.y, class: "map-roadwork-link", "aria-hidden": "true"
      });
      const badge = add(group, "g", { transform: `translate(${spot.x} ${spot.y})`, "aria-hidden": "true" });
      const plate = add(badge, "rect", { x: -42, y: -10.5, width: 84, height: 21, rx: 5, class: "map-roadwork-plate" });
      add(badge, "path", {
        d: "M-35 5.75H-23M-33.2 4.1 -29.8 -5.75h1.45L-24.9 4.1Zm1.2-3.45h5.75m-4.55-3.5h3.3",
        class: "map-roadwork-cone"
      });
      const label = add(badge, "text", { x: -18, class: "map-roadwork-label" });
      add(badge, "rect", { x: -42, y: -15, width: 84, height: 30, rx: 5, class: "map-roadwork-hit" });
      const mark = { group, site, paving, spot, label, plate, streetId: road.street.id, tooltip: "", state: null, progress: null };
      bindRoadsideBadge(mark, job.streetId);
      return mark;
    }

    function placeRoadsideBadge(anchor, radius, halfWidth, halfHeight) {
      const { roadSamples, occupied } = getRoadsideGeometry();
      const marks = [...crossings.values(), ...roadworkMarkers.values(), ...breakdownTimers.values()];
      return roadsideBadgePosition(anchor, radius, roadSamples, [...occupied, ...marks.map((mark) => mark.spot)], halfWidth, halfHeight);
    }

    function bindRoadsideBadge(mark, streetId) {
      const { group, plate } = mark;
      const show = () => showTooltip(plate, mark.tooltip);
      const select = () => {
        show();
        onStreetSelect(streetId);
      };
      group.addEventListener("pointerenter", show);
      group.addEventListener("pointerleave", () => { if (document.activeElement !== group) hideTooltip(plate); });
      group.addEventListener("focus", show);
      group.addEventListener("blur", () => hideTooltip(plate));
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!suppressClick) select();
      });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
        if (event.key === "Escape") hideTooltip(plate);
      });
    }

    function prepareRoadworkTracks() {
      const dashboard = snapshot?.roadworks || [];
      const before = new Map((previousMotion.roadworks || dashboard).map((job) => [job.id, job]));
      const active = currentMotion.roadworks || dashboard;
      roadworksByVehicle = new Map(active.map((job) => [String(job.vehicleId), job]));
      const live = new Map(active.map((job) => [job.id, job.streetId]));
      for (const [key, mark] of roadworkMarkers) {
        if (live.get(key) === mark.streetId) continue;
        if (activeTooltipTarget === mark.plate) hideTooltip(mark.plate);
        mark.group.remove();
        mark.site.remove();
        roadworkMarkers.delete(key);
      }
      roadworkTracks = [];
      for (const job of active) {
        const road = roads.get(job.streetId);
        if (!road) continue;
        let mark = roadworkMarkers.get(job.id);
        if (!mark) {
          mark = createRoadworkMarker(job, road);
          if (!mark) continue;
          roadworkMarkers.set(job.id, mark);
        }
        roadworkTracks.push({ mark, from: before.get(job.id), to: job });
      }
    }

    function animateRoadworks(fraction) {
      for (const { mark, from, to } of roadworkTracks) {
        const working = to.state === "working";
        const clearing = to.state === "clearing";
        const seconds = Math.max(0, Math.ceil(finite(to.remaining)));
        const eta = Number.isFinite(to.eta) ? Math.max(0, Math.ceil(to.eta)) : null;
        const label = working ? `WORK ${seconds}s` : clearing ? "CLEARING" : eta === null ? "EN ROUTE" : `IN ${eta}s`;
        if (mark.label.textContent !== label) mark.label.textContent = label;
        const detail = working ? `Resurfacing · ${seconds}s remaining` :
          clearing ? "Clearing traffic for resurfacing" :
            eta === null ? "Crane en route" : `Crane en route · ETA ${eta}s`;
        const tooltipText = `${to.streetId} · ${detail}`;
        if (mark.tooltip !== tooltipText) {
          mark.group.setAttribute("aria-label", `${tooltipText}. Select street.`);
          mark.tooltip = tooltipText;
          if (activeTooltipTarget === mark.plate) updateTooltipText(tooltipText);
        }
        if (mark.state !== to.state) {
          mark.site.classList.toggle("is-closed", working || clearing);
          mark.group.classList.toggle("is-enroute", !working && !clearing);
          mark.state = to.state;
        }
        const fromProgress = from?.state === "working" ? finite(from.progress) : 0;
        const progress = working ? clamp(mix(fromProgress, finite(to.progress), fraction), 0, 1) : 0;
        const length = progress.toFixed(5);
        if (length !== mark.progress || to.reverse !== mark.reverse) {
          mark.paving.classList.toggle("is-visible", progress > 0);
          mark.paving.setAttribute("stroke-dasharray", `${length} 1`);
          mark.paving.setAttribute("stroke-dashoffset", to.reverse ? (progress - 1).toFixed(5) : 0);
          mark.progress = length;
          mark.reverse = to.reverse;
        }
      }
    }

    function drawBreakdownFlag(flag) {
      add(flag, "path", { d: "M0 -6.4L6.4 0 0 6.4 -6.4 0Z", class: "map-breakdown-diamond" });
      add(flag, "path", { d: "M0 -2.9V.65M0 2.7V2.8", class: "map-breakdown-exclamation" });
    }

    function createBreakdownTimer(incident, road) {
      const progress = clamp(finite(incident.progress), 0, 1);
      const reverse = Boolean(incident.reverse);
      const anchor = pathPose(road.surface, progress, reverse);
      const carPose = pathPose(road.surface, progress, reverse, laneCenter(road.street));
      if (!anchor || !carPose) return null;
      const spot = placeRoadsideBadge(anchor, roadHalfWidth(road.street), 29, 15);
      const group = add(layers.breakdownTimers, "g", {
        class: "map-breakdown-timer", role: "button", tabindex: "0",
        "data-breakdown-street": incident.streetId, "data-breakdown-vehicle": incident.vehicleId
      });
      const link = add(group, "line", { x1: carPose.x, y1: carPose.y, x2: spot.x, y2: spot.y,
        class: "map-breakdown-timer-link", "aria-hidden": "true" });
      const badge = add(group, "g", { transform: `translate(${spot.x} ${spot.y})`, "aria-hidden": "true" });
      const plate = add(badge, "rect", { x: -29, y: -10.5, width: 58, height: 21, rx: 5, class: "map-breakdown-timer-plate" });
      drawBreakdownFlag(add(badge, "g", { transform: "translate(-17 0)" }));
      const label = add(badge, "text", { x: -6, class: "map-breakdown-timer-label" });
      add(badge, "rect", { x: -29, y: -15, width: 58, height: 30, rx: 5, class: "map-breakdown-timer-hit" });
      const mark = { group, spot, link, label, plate, incident, tooltip: "" };
      bindRoadsideBadge(mark, incident.streetId);
      return mark;
    }

    function prepareBreakdownTimers() {
      const active = currentMotion.incidents || snapshot?.incidents || [];
      incidentsByVehicle = new Map(active.map((incident) => [String(incident.vehicleId), incident]));
      const live = new Map(active.map((incident) => [incident.id, incident]));
      for (const [key, mark] of breakdownTimers) {
        const incident = live.get(key);
        if (incident?.streetId === mark.incident.streetId && incident.vehicleId === mark.incident.vehicleId &&
          incident.reverse === mark.incident.reverse && incident.progress === mark.incident.progress) continue;
        if (activeTooltipTarget === mark.plate) hideTooltip(mark.plate);
        mark.group.remove();
        breakdownTimers.delete(key);
      }
      for (const incident of active) {
        const road = roads.get(incident.streetId);
        if (!road) continue;
        let mark = breakdownTimers.get(incident.id);
        if (!mark) {
          mark = createBreakdownTimer(incident, road);
          if (!mark) continue;
          breakdownTimers.set(incident.id, mark);
        }
        mark.incident = incident;
        const seconds = Math.max(0, Math.ceil(finite(incident.remaining)));
        const description = incident.plate ? `${incident.plate} broke down` : "Car breakdown";
        const tooltipText = `${incident.streetId} · ${description} · ${seconds}s remaining`;
        if (mark.tooltip === tooltipText) continue;
        mark.label.textContent = `${seconds}s`;
        mark.group.setAttribute("aria-label", `${incident.streetId} car breakdown, ${seconds} seconds remaining. Select street.`);
        mark.tooltip = tooltipText;
        if (activeTooltipTarget === mark.plate) updateTooltipText(tooltipText);
      }
    }

    function positionBreakdownTimers() {
      for (const mark of breakdownTimers.values()) {
        const pose = vehicleMarkers.get(String(mark.incident.vehicleId))?.position;
        if (pose) setLinePoints(mark.link, { x1: pose.x, y1: pose.y, x2: mark.spot.x, y2: mark.spot.y });
      }
    }

    function renderRoutes() {
      const selected = renderOptions.selectedVehicleId;
      if (!selected && !paintedRoute.size) return;
      const active = (snapshot?.vehicles || []).find((vehicle) => vehicle.id === selected);
      const completed = active ? null : (snapshot?.completed || []).find((vehicle) => vehicle.id === selected);
      const route = active?.route || completed?.route || [];
      const visible = new Map();
      for (const [index, step] of route.entries()) {
        if (visible.get(step.streetId) === "route-current") continue;
        const style = completed ? "route-complete" : index === active?.routeIndex ? "route-current" : "";
        visible.set(step.streetId, style);
      }
      for (const id of new Set([...paintedRoute.keys(), ...visible.keys()])) {
        const style = visible.get(id);
        const path = roads.get(id)?.routePath;
        if (!path || style === paintedRoute.get(id)) continue;
        path.classList.toggle("visible", style !== undefined);
        path.classList.toggle("route-complete", style === "route-complete");
        path.classList.toggle("route-current", style === "route-current");
      }
      paintedRoute = visible;
    }

    function signalKey(signal, index) { return signal.id ?? `${signal.streetId}:${signal.reverse ? 1 : 0}:${index}`; }

    function createSignal(key) {
      const group = add(layers.signals, "g", { class: "map-signal", tabindex: "0", role: "button", "data-signal-key": key });
      const pole = add(group, "line", { class: "map-signal-pole", "aria-hidden": "true" });
      const stopbarUnder = add(group, "line", { class: "map-signal-stopbar-under", "aria-hidden": "true" });
      const stopbar = add(group, "line", { class: "map-signal-stopbar", "aria-hidden": "true" });
      const head = add(group, "g", { class: "map-signal-head", "aria-hidden": "true" });
      add(head, "rect", { x: -7, y: -15, width: 14, height: 30, rx: 4, class: "map-signal-housing" });
      for (const [color, y] of [["red", -8], ["yellow", 0], ["green", 8]]) add(head, "circle", { cx: 0, cy: y, r: 3, class: `map-signal-lamp lamp-${color}` });
      const hitbox = add(group, "rect", { x: -22, y: -22, width: 44, height: 44, rx: 8, class: "map-signal-hit", "aria-hidden": "true" });
      hitbox.addEventListener("pointerenter", () => showTooltip(hitbox, signalTooltipText(hitbox)));
      hitbox.addEventListener("pointerleave", () => { if (document.activeElement !== group) hideTooltip(hitbox); });
      group.addEventListener("focus", () => showTooltip(hitbox, signalTooltipText(hitbox)));
      group.addEventListener("blur", () => hideTooltip(hitbox));
      hitbox.addEventListener("click", (event) => {
        event.stopPropagation();
        if (suppressClick) return;
        const signal = signals.get(key)?.data;
        if (signal) {
          showTooltip(hitbox, signalTooltipText(hitbox));
          onSignalSelect(signal.id ?? key);
        }
      });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          const signal = signals.get(key)?.data;
          if (signal) {
            showTooltip(hitbox, signalTooltipText(hitbox));
            onSignalSelect(signal.id ?? key);
          }
        }
        if (event.key === "Escape") hideTooltip(hitbox);
      });
      return { group, pole, stopbarUnder, stopbar, head, hitbox, data: null, color: "red", remaining: 0, position: null };
    }

    function signalTooltipText(target) {
      const key = target.closest?.(".map-signal")?.getAttribute("data-signal-key") || target.getAttribute("data-signal-key");
      const state = signals.get(key);
      const color = state?.color || "red";
      const seconds = Math.max(0, Math.ceil(state?.remaining || 0));
      return `${titleCase(color)} · ${seconds}s`;
    }

    function signalLayoutFor(signal, road, pose) {
      const reverse = Boolean(signal.reverse);
      const key = signal.id ?? (signal.nodeId ? `${signal.nodeId}:${signal.streetId}:${reverse ? 1 : 0}` : null);
      const layout = key ? data.signalLayouts?.[key] : null;
      if (layout?.head && layout?.bar && layout?.pole) return layout;
      if (!pose || !road) return null;

      const angle = pose.angle * Math.PI / 180;
      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      const halfWidth = road.street.major ? 21 : 15;
      const headOffset = halfWidth + 16;
      const head = { x: pose.x + nx * headOffset, y: pose.y + ny * headOffset };
      return {
        head,
        bar: {
          x1: pose.x + nx * 2,
          y1: pose.y + ny * 2,
          x2: pose.x + nx * (halfWidth - 2),
          y2: pose.y + ny * (halfWidth - 2)
        },
        pole: {
          x1: pose.x + nx * (halfWidth - 1),
          y1: pose.y + ny * (halfWidth - 1),
          x2: head.x,
          y2: head.y + 15
        }
      };
    }

    function setLinePoints(line, points) {
      for (const key of ["x1", "y1", "x2", "y2"]) {
        const value = String(points[key]);
        if (line.getAttribute(key) !== value) line.setAttribute(key, value);
      }
    }

    function getRoadsideGeometry() {
      if (roadsideGeometry) return roadsideGeometry;
      const roadSamples = [...roads.values()].map(({ street, surface }) => {
        const count = Math.max(1, Math.ceil(lengthFor(surface) / 9));
        return {
          radius: roadHalfWidth(street) + 1,
          points: Array.from({ length: count + 1 }, (_, index) => pointAt(surface, index / count)).filter(Boolean)
        };
      });
      const signalBounds = Object.values(data.signalLayouts || {}).map(({ head }) => ({
        x: head.x, y: head.y, halfWidth: 10, halfHeight: 17
      }));
      const occupied = [...signalBounds];
      for (const { street, labelPoint } of roads.values()) {
        const angle = finite(street.label?.angle) * Math.PI / 180;
        const c = Math.abs(Math.cos(angle));
        const s = Math.abs(Math.sin(angle));
        occupied.push({ ...labelPoint, halfWidth: 23 * c + 13 * s, halfHeight: 23 * s + 13 * c });
        occupied.push({ x: labelPoint.x, y: labelPoint.y + 19, halfWidth: 36, halfHeight: 8 });
      }
      roadsideGeometry = { roadSamples, signalBounds, occupied };
      return roadsideGeometry;
    }

    function createCrossings() {
      if (!data.pedestrianCrossings?.length) return;
      const geometry = getRoadsideGeometry();
      const { roadSamples, signalBounds } = geometry;
      const occupied = [...geometry.occupied];
      for (const definition of data.pedestrianCrossings) {
        const road = roads.get(definition.streetId);
        if (!road || !Number.isFinite(definition.progress) || !Number.isFinite(definition.halfSpan)) continue;
        const pose = pathPose(road.surface, definition.progress, Boolean(definition.reverse));
        if (!pose) continue;
        const radius = roadHalfWidth(road.street);
        const depth = definition.halfSpan * lengthFor(road.surface);
        const spot = roadsideBadgePosition(pose, radius, roadSamples, occupied);
        const pedestrianLane = crossingPedestrianLane(pose, radius, depth, spot.side, signalBounds, roadSamples);
        occupied.push(spot);
        const mark = createCrossing(definition, pose, radius, depth, spot, pedestrianLane);
        crossings.set(definition.id, mark);
      }
    }

    function roadsideBadgePosition(pose, radius, roadSamples, occupied, halfWidth = 34, halfHeight = 18) {
      const radians = pose.angle * Math.PI / 180;
      const c = Math.cos(radians);
      const s = Math.sin(radians);
      const candidates = [];
      for (const side of [1, -1]) {
        for (const forward of [0, -12, 8, -24, 16, -36, -48, -64, -82]) {
          for (const gap of [16, 23, 30, 38, 48, 60, 74, 88]) {
            const across = (radius + gap) * side;
            const x = pose.x + c * forward - s * across;
            const y = pose.y + s * forward + c * across;
            candidates.push({ x, y, side, halfWidth, halfHeight, distance: Math.hypot(forward, gap) + Math.max(0, forward) });
          }
        }
      }
      candidates.sort((a, b) => a.distance - b.distance);
      let best = candidates[0];
      let bestCost = Infinity;
      for (const spot of candidates) {
        let intrusion = Math.max(0, halfWidth - spot.x, halfHeight - spot.y,
          spot.x + halfWidth - data.width, spot.y + halfHeight - data.height);
        for (const box of occupied) {
          const dx = Math.abs(spot.x - box.x) - halfWidth - box.halfWidth - 2;
          const dy = Math.abs(spot.y - box.y) - halfHeight - box.halfHeight - 2;
          intrusion = Math.max(intrusion, Math.min(-dx, -dy));
        }
        for (const road of roadSamples) {
          for (const point of road.points) {
            const dx = Math.max(0, Math.abs(spot.x - point.x) - halfWidth);
            const dy = Math.max(0, Math.abs(spot.y - point.y) - halfHeight);
            if (dx < road.radius && dy < road.radius) intrusion = Math.max(intrusion, road.radius - Math.hypot(dx, dy));
          }
        }
        if (intrusion === 0) return spot;
        const cost = spot.distance + intrusion * 12;
        if (cost < bestCost) {
          best = spot;
          bestCost = cost;
        }
      }
      return best;
    }

    function crossingPedestrianLane(pose, radius, depth, preferredSide, signalBounds, roadSamples) {
      const angle = pose.angle * Math.PI / 180;
      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      const geometry = { pose, nx, ny, radius, depth };
      let best = null;
      let bestScore = Infinity;
      // Reserve standing room beside the stripes with space around signal heads.
      for (const side of [preferredSide, -preferredSide]) {
        for (const along of [0, -1.5, 1.5]) {
          for (const gap of [6, 9, 12, 16, 20]) {
            let score = (gap - 6) * .8 + Math.abs(along) + (side === preferredSide ? 0 : 2);
            for (const [index, offset] of pedestrianOffsets.entries()) {
              const ahead = along + depth * offset;
              const near = crossingPoint(geometry, ahead, side * (radius + gap + index * 5.5));
              for (const box of signalBounds) {
                const width = Math.min(near.x + 5, box.x + box.halfWidth) - Math.max(near.x - 5, box.x - box.halfWidth);
                const height = Math.min(near.y + 1, box.y + box.halfHeight) - Math.max(near.y - 15, box.y - box.halfHeight);
                score += Math.max(0, width) * Math.max(0, height) * .4;
              }
              const far = crossingPoint(geometry, ahead, -side * (radius + 6 + index * 2.8));
              for (const foot of [near, far]) {
                let encroachment = 0;
                for (const road of roadSamples) {
                  for (const point of road.points) {
                    const dx = Math.abs(foot.x - point.x);
                    const dy = Math.abs(foot.y - point.y);
                    if (dx < road.radius && dy < road.radius) {
                      encroachment = Math.max(encroachment, road.radius - Math.hypot(dx, dy));
                    }
                  }
                }
                score += encroachment * 8;
              }
              if (score >= bestScore) break;
            }
            if (score < bestScore) {
              best = { ...geometry, side, along, start: radius + gap };
              bestScore = score;
            }
          }
        }
      }
      return best;
    }

    function crossingPoint(lane, along, across) {
      return {
        x: lane.pose.x + lane.ny * along + lane.nx * across,
        y: lane.pose.y - lane.nx * along + lane.ny * across
      };
    }

    function createCrossing(definition, pose, radius, depth, spot, pedestrianLane) {
      const { id } = definition;
      const group = add(layers.crossings, "g", { class: "map-crossing", role: "button", tabindex: "0", "data-crossing-id": id });
      const transform = `translate(${pose.x} ${pose.y}) rotate(${pose.angle})`;
      const paint = add(layers.crossingPaint, "g", { class: "map-crossing-marking", "data-crossing-paint-id": id });
      const marking = add(paint, "g", { transform });
      const nearbyCrossings = data.pedestrianCrossings.filter((crossing) => crossing.nodeId === definition.nodeId).length;
      const halfWidth = radius - (nearbyCrossings >= 4 ? 6 : 1.75);
      add(marking, "rect", { x: -depth - 1.5, y: -halfWidth - 1, width: 2 * depth + 3, height: 2 * halfWidth + 2, rx: 2, class: "map-crossing-outline" });
      const stripes = radius >= 20 ? 6 : radius >= 14 ? 4 : 3;
      const band = 2 * halfWidth / stripes;
      for (let index = 0; index < stripes; index += 1) {
        add(marking, "rect", { x: -depth, y: -halfWidth + index * band + .9, width: 2 * depth, height: band - 1.8, rx: .65, class: "map-crossing-stripe" });
      }
      add(layers.dividerMaskNodes, "rect", { x: -depth - 1, y: -3, width: 2 * depth + 2, height: 6, fill: "#000", transform });
      add(marking, "rect", { x: -depth - 2, y: -halfWidth, width: 2 * depth + 4, height: 2 * halfWidth, class: "map-crossing-hit" });

      const waiters = pedestrianJackets.map((jacket) => createCrossingPerson(paint, "waiter", jacket));
      const walkers = pedestrianJackets.map((jacket) => createCrossingPerson(paint, "walker", jacket));
      const curb = crossingPoint(pedestrianLane, 0, radius * spot.side);
      const link = add(group, "line", {
        x1: curb.x, y1: curb.y,
        x2: spot.x, y2: spot.y, class: "map-crossing-link", "aria-hidden": "true"
      });
      const badge = add(group, "g", { class: "map-crossing-badge", "aria-hidden": "true" });
      const plate = add(badge, "rect", { rx: 5, class: "map-crossing-plate" });
      const icon = add(badge, "g");
      add(icon, "use", { href: "#mapWalkingGlyph", class: "map-crossing-walk-icon" });
      add(icon, "path", {
        d: "M-3.7 .2V-2.8a.9.9 0 0 1 1.8 0v1.3-3.2a.9.9 0 0 1 1.8 0v3.2-3.9a.9.9 0 0 1 1.8 0v3.9-2.8a.9.9 0 0 1 1.8 0V1.6C3.5 4 2.4 5.3.3 5.3H-.5C-2 5.3-3 4.2-3.7 3L-5.2 .7a.92.92 0 0 1 1.5-1.05L-2 .9",
        class: "map-crossing-wait-icon"
      });
      const label = add(badge, "text", { x: -11, y: -5.3, class: "map-crossing-label" });
      const detail = add(badge, "text", { x: -11, y: 6.2, class: "map-crossing-label map-crossing-detail" });
      const hit = add(badge, "rect", { y: -18, height: 36, rx: 6, class: "map-crossing-hit" });
      const mark = { definition, group, paint, badge, link, spot, plate, icon, label, detail, hit,
        pedestrianLane, waiters, walkers, tooltip: "", expanded: null };
      const show = () => showTooltip(plate, mark.tooltip);
      const select = () => {
        show();
        onCrossingSelect(id);
      };
      for (const target of [group, paint]) {
        target.addEventListener("pointerenter", show);
        target.addEventListener("pointerleave", () => { if (document.activeElement !== group) hideTooltip(plate); });
        target.addEventListener("click", (event) => {
          event.stopPropagation();
          if (!suppressClick) select();
        });
      }
      group.addEventListener("focus", () => {
        paint.classList.add("is-focused");
        show();
      });
      group.addEventListener("blur", () => {
        paint.classList.remove("is-focused");
        hideTooltip(plate);
      });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
        if (event.key === "Escape") hideTooltip(plate);
      });
      return mark;
    }

    function createCrossingPerson(parent, kind, jacket) {
      const group = add(parent, "g", { class: `map-crossing-figure map-crossing-${kind}` });
      group.style.setProperty("--pedestrian-jacket", jacket);
      add(group, "ellipse", { rx: 3, ry: 1.05, class: "map-crossing-foot-shadow" });
      const figure = add(group, "g", { class: "map-crossing-figure-icon" });
      const legs = ["far", "near"].map((side) => add(figure, "path", { class: `map-pedestrian-leg is-${side}` }));
      const farArm = add(figure, "path", { class: "map-pedestrian-arm is-far" });
      add(figure, "use", { href: "#mapPedestrianBody", class: "map-pedestrian-body" });
      const nearArm = add(figure, "path", { class: "map-pedestrian-arm" });
      const person = { group, legs, arms: [farArm, nearArm], visible: false, position: "", strideDistance: null };
      posePedestrian(person, 0, 0, 0, 0);
      return person;
    }

    function preparePedestrianTracks() {
      const dashboard = snapshot?.crossings || [];
      const from = new Map((previousMotion.crossings || dashboard).map((crossing) => [crossing.id, crossing]));
      const to = new Map((currentMotion.crossings || dashboard).map((crossing) => [crossing.id, crossing]));
      pedestrianTracks = Array.from(crossings, ([id, mark]) => ({ mark, from: from.get(id), to: to.get(id) }));
    }

    function positionCrossingPerson(person, lane, along, across) {
      const { x, y } = crossingPoint(lane, along, across);
      const position = `translate(${x.toFixed(2)} ${y.toFixed(2)})`;
      if (person.position !== position) person.group.setAttribute("transform", position);
      person.position = position;
    }

    function posePedestrian(person, distance, totalDistance, headingX, headingY) {
      const strength = reducedMotion?.matches ? 0 : clamp(Math.min(distance, totalDistance - distance) / 1.6, 0, 1);
      const strideDistance = strength ? Math.round(distance * 100) / 100 : 0;
      if (person.strideDistance === strideDistance) return;
      const reach = pedestrianStrideLength * pedestrianStance / 2;
      const decimal = (value) => value.toFixed(2);
      for (const [index, side] of [-1, 1].entries()) {
        const phase = (strideDistance / pedestrianStrideLength + index * .5) % 1;
        const swing = clamp((phase - pedestrianStance) / (1 - pedestrianStance), 0, 1);
        // Advance the planted foot backward relative to the body by exactly the
        // distance walked. Only the swinging foot advances in map coordinates.
        const advance = (reach - pedestrianStrideLength * phase + pedestrianStrideLength * swing * swing * (3 - 2 * swing)) * strength;
        const lift = 1.38 * Math.sin(Math.PI * swing) ** 2 * strength;
        const footX = side * 1.22 + headingX * advance;
        const footY = headingY * advance - lift;
        const kneeX = mix(side * .77, footX, .56) + headingX * lift * .31;
        const kneeY = mix(-5.83, footY, .51);
        person.legs[index].setAttribute("d", `M${side * .77} -5.83 ${decimal(kneeX)} ${decimal(kneeY)} ${decimal(footX)} ${decimal(footY)}`);

        const armSwing = -1.24 * Math.cos(phase * 2 * Math.PI) * strength;
        const handX = side * 2.34 + headingX * armSwing;
        const handY = -5.77 + headingY * armSwing * .72 - Math.abs(armSwing) * .22;
        const elbowX = mix(side * 1.65, handX, .55) + side * .38;
        const elbowY = mix(-9.47, handY, .54);
        person.arms[index].setAttribute("d", `M${side * 1.65} -9.47 ${decimal(elbowX)} ${decimal(elbowY)} ${decimal(handX)} ${decimal(handY)}`);
      }
      person.strideDistance = strideDistance;
    }

    function showPedestrians(people, count) {
      people.forEach((person, index) => {
        const visible = index < count;
        if (person.visible !== visible) person.group.classList.toggle("is-visible", visible);
        person.visible = visible;
      });
    }

    function animatePedestrians(fraction) {
      for (const { mark, from, to } of pedestrianTracks) {
        const state = fraction === 1 ? to : from;
        const waiting = clamp(Math.floor(finite(state?.waiting)), 0, mark.waiters.length);
        const walking = state?.state === "walk" ? clamp(Math.floor(finite(state.crossing)), 0, mark.walkers.length) : 0;
        showPedestrians(mark.waiters, waiting);
        showPedestrians(mark.walkers, walking);
        const lane = mark.pedestrianLane;
        const curbEnd = lane.radius + 6;
        const queueOffset = walking ? -lane.depth : 0;
        for (let index = 0; index < waiting; index += 1) {
          const along = lane.along + lane.depth * pedestrianOffsets[index] + queueOffset;
          const across = lane.side * (lane.start + index * 5.5);
          positionCrossingPerson(mark.waiters[index], lane, along, across);
        }
        if (!walking) continue;
        const duration = finite(state.duration) || 7;
        // Use the same previous/current simulation ticks as vehicle frames.
        // People in the last WALK frame finish at the far curb as WAIT resumes.
        const remaining = from?.state === "walk"
          ? mix(finite(from.remaining), to?.state === "walk" ? finite(to.remaining) : 0, fraction)
          : finite(state.remaining);
        const progress = clamp(1 - remaining / duration, 0, 1);
        const stagger = .07;
        const walkingSpan = 1 - (walking - 1) * stagger;
        const headingX = -lane.nx * lane.side;
        const headingY = -lane.ny * lane.side;
        for (let index = 0; index < walking; index += 1) {
          const travel = clamp((progress - index * stagger) / walkingSpan, 0, 1);
          const along = lane.along + lane.depth * pedestrianOffsets[index];
          const start = lane.start + index * 5.5;
          const end = curbEnd + index * 2.8;
          const distance = (start + end) * travel;
          const person = mark.walkers[index];
          positionCrossingPerson(person, lane, along, lane.side * (start - distance));
          posePedestrian(person, distance, start + end, headingX, headingY);
        }
      }
    }

    function renderCrossings() {
      const live = new Map((snapshot?.crossings || []).map((crossing) => [crossing.id, crossing]));
      for (const [id, mark] of crossings) {
        const state = live.get(id);
        const walk = state?.state === "walk";
        const waiting = Math.max(0, Math.floor(finite(state?.waiting)));
        const crossing = Math.max(0, Math.floor(finite(state?.crossing)));
        const seconds = Math.max(0, Math.ceil(finite(state?.remaining)));
        const selected = id === renderOptions.selectedCrossingId;
        const expanded = walk || waiting > 0 || selected;
        if (mark.expanded !== expanded) {
          const width = expanded ? 64 : 21;
          const height = expanded ? 29 : 21;
          const halfWidth = width / 2;
          const direction = Math.sign(mark.spot.x - finite(mark.link.getAttribute("x1")));
          const x = mark.spot.x - direction * Math.max(0, 18 - halfWidth);
          mark.link.setAttribute("x2", x);
          mark.badge.setAttribute("transform", `translate(${x} ${mark.spot.y})`);
          mark.plate.setAttribute("x", -halfWidth);
          mark.plate.setAttribute("y", -height / 2);
          mark.plate.setAttribute("width", width);
          mark.plate.setAttribute("height", height);
          mark.hit.setAttribute("x", -Math.max(18, halfWidth));
          mark.hit.setAttribute("width", Math.max(36, width));
          mark.icon.setAttribute("transform", expanded ? "translate(-22 0)" : "translate(0 0)");
          mark.expanded = expanded;
        }
        const labelText = expanded ? (walk ? "WALK" : "WAIT") : "";
        const detailText = expanded ? (walk ? `${seconds}s${crossing ? ` · ${crossing}` : ""}` : `×${waiting}`) : "";
        if (mark.label.textContent !== labelText) mark.label.textContent = labelText;
        if (mark.detail.textContent !== detailText) mark.detail.textContent = detailText;
        const streetId = mark.definition.streetId;
        const status = walk ? `WALK for ${seconds}s` : "WAIT";
        const tooltipText = `${streetId} crossing · ${status} · ${waiting} waiting · ${crossing} crossing`;
        const aria = `Pedestrian crossing on ${streetId} at ${mark.definition.nodeId}. ${status}. ${waiting} waiting, ${crossing} crossing.`;
        if (mark.group.getAttribute("aria-label") !== aria) mark.group.setAttribute("aria-label", aria);
        mark.group.setAttribute("aria-pressed", String(selected));
        mark.group.classList.toggle("is-walk", walk);
        mark.group.classList.toggle("has-people", waiting > 0 || crossing > 0);
        mark.group.classList.toggle("is-selected", selected);
        mark.paint.classList.toggle("is-selected", selected);
        mark.tooltip = tooltipText;
        if (activeTooltipTarget === mark.plate) updateTooltipText(tooltipText);
      }
    }

    function renderSignals() {
      const desired = new Set();
      for (const [index, signal] of (snapshot?.signals || []).entries()) {
        const key = signalKey(signal, index);
        desired.add(String(key));
        let state = signals.get(String(key));
        if (!state) {
          state = createSignal(String(key));
          signals.set(String(key), state);
        }
        state.data = signal;
        state.color = ["red", "yellow", "green"].includes(signal.color) ? signal.color : "red";
        state.remaining = Math.max(0, finite(signal.remaining, finite(signal.seconds)));
        if (!state.position) {
          const road = roads.get(signal.streetId);
          const layout = signalLayoutFor(signal, road, pathPose(road?.surface, signal.progress, Boolean(signal.reverse)));
          if (!layout) {
            state.group.setAttribute("display", "none");
            continue;
          }
          state.position = { x: Number(layout.head.x), y: Number(layout.head.y) };
          state.group.removeAttribute("display");
          setLinePoints(state.pole, layout.pole);
          setLinePoints(state.stopbarUnder, layout.bar);
          setLinePoints(state.stopbar, layout.bar);
          const headTransform = `translate(${layout.head.x} ${layout.head.y})`;
          state.head.setAttribute("transform", headTransform);
          state.hitbox.setAttribute("transform", headTransform);
        }
        const aria = `${titleCase(state.color)} signal, ${Math.ceil(state.remaining)} seconds remaining on ${signal.streetId}. Select signal.`;
        if (state.group.getAttribute("aria-label") !== aria) state.group.setAttribute("aria-label", aria);
        state.group.classList.toggle("is-red", state.color === "red");
        state.group.classList.toggle("is-yellow", state.color === "yellow");
        state.group.classList.toggle("is-green", state.color === "green");
        if (activeTooltipTarget === state.hitbox) updateTooltipText(signalTooltipText(state.hitbox));
      }
      for (const [key, state] of signals) {
        if (!desired.has(key)) {
          if (activeTooltipTarget === state.hitbox) hideTooltip();
          state.group.remove();
          signals.delete(key);
        }
      }
      layers.signals.classList.toggle("is-hidden", !renderOptions.showSignals);
    }

    function makeCarGlyph(parent) {
      const car = parent;
      add(car, "ellipse", { cx: 0, cy: 1.5, rx: 11.2, ry: 5.4, class: "map-car-shadow" });
      add(car, "rect", { x: -10.5, y: -4.8, width: 21, height: 9.6, rx: 3.6, class: "map-car-body" });
      add(car, "path", { d: "M-5.2 -4.25Q-3.7 -2.8-3.5 0Q-3.7 2.8-5.2 4.25L4.3 4.25Q6.1 2.6 6.2 0Q6.1-2.6 4.3-4.25Z", class: "map-car-window" });
      add(car, "rect", { x: 7.3, y: -3.6, width: 2.2, height: 1.5, rx: .5, class: "map-car-light" });
      add(car, "rect", { x: 7.3, y: 2.1, width: 2.2, height: 1.5, rx: .5, class: "map-car-light" });
      add(car, "path", { d: "M-9.7 -3H-8v1.6h-1.7zM-9.7 1.4H-8V3h-1.7z", class: "map-car-brake" });
      for (const y of [-5.1, 3.75]) {
        for (const x of [-7.7, 3.6]) {
          add(car, "rect", { x, y, width: 4, height: 1.35, rx: .55, class: "map-car-tire" });
        }
      }
    }

    function makeBusGlyph(bus) {
      add(bus, "ellipse", { cy: 1.2, rx: 19.5, ry: 7.3, class: "map-car-shadow" });
      for (const x of [-12.5, 9]) for (const y of [-6.9, 5.2]) {
        add(bus, "rect", { x, y, width: 4.2, height: 1.7, rx: .6, class: "map-car-tire" });
      }
      add(bus, "rect", { x: -18, y: -6.2, width: 36, height: 12.4, rx: 3.7, class: "map-bus-body" });
      add(bus, "rect", { x: -12.8, y: -4.2, width: 24.5, height: 8.4, rx: 1.5, class: "map-bus-roof" });
      for (const x of [-11.5, -6, -.5, 5]) for (const y of [-5.5, 4.2]) {
        add(bus, "rect", { x, y, width: 4.4, height: 1.35, rx: .4, class: "map-bus-window" });
      }
      add(bus, "rect", { x: 12.7, y: -4.6, width: 2.8, height: 9.2, rx: .9, class: "map-bus-windscreen" });
      add(bus, "rect", { x: -5.5, y: -2, width: 7.5, height: 4, rx: .8, class: "map-bus-roof-vent" });
      add(bus, "path", { d: "M16.5 -4v1.7m0 4.6V4", class: "map-bus-headlights" });
      add(bus, "path", { d: "M-16.7 -4v1.7m0 4.6V4", class: "map-bus-tail-lights" });
      add(bus, "path", { d: "M9 5h4.2", class: "map-bus-door" });
      add(bus, "path", { d: "M-13 5h4.2", class: "map-bus-door" });
    }

    function makeCraneGlyph(crane) {
      add(crane, "ellipse", { cy: 1.05, rx: 13.1, ry: 5.5, class: "map-car-shadow" });
      const stabilizers = add(crane, "g", { class: "map-crane-raised map-crane-stabilizers" });
      for (const side of [-1, 1]) {
        for (const x of [-7.7, 5.2]) {
          const padX = x + Math.sign(x) * 1.45;
          const padY = side * 7.85;
          add(stabilizers, "path", { d: `M${x} ${side * 2.6}L${padX} ${padY}`, class: "map-crane-outrigger" });
          add(stabilizers, "rect", { x: padX - 1.45, y: padY - .9, width: 2.9, height: 1.8, rx: .4, class: "map-crane-outrigger-pad" });
        }
        for (const x of [-10.8, -6.6, 4.1, 8.15]) {
          add(crane, "rect", { x, y: side * 4.55 - 1.22, width: 3.05, height: 2.44, rx: .6, class: "map-car-tire" });
        }
      }
      add(crane, "path", {
        d: "M-12.15 -2.15H-3.3L-1.65 -1.65H2.75L4.1 -2.85H11.5V2.85H4.1L2.75 1.65H-1.65L-3.3 2.15H-12.15Z",
        class: "map-crane-chassis"
      });
      add(crane, "path", {
        d: "M-11.85 -2.9Q-11.8 -3.75-10.85 -3.75H-6.75L-4.6 -2.25V2.25L-6.75 3.75H-10.85Q-11.8 3.75-11.85 2.9Z",
        class: "map-crane-counterweight"
      });
      add(crane, "path", { d: "M-11 -2.6l1.65 1.65m-1.65.25 1.65 1.65m-1.65.25 1.35 1.35", class: "map-crane-counterweight-stripes" });
      add(crane, "path", {
        d: "M4.25 -2.75H8.35Q9.4 -2.75 10.15 -2.04L11.95 -.25V3.65H4.25Z",
        class: "map-crane-cab"
      });
      add(crane, "path", { d: "M6.75 -1.85H8.2L10.77 .1V2.6H8.72V.23L6.75 -.28Z", class: "map-crane-windshield" });
      add(crane, "path", { d: "M11.72 .34v1.2m0 .94v.65", class: "map-crane-headlights" });
      add(crane, "circle", { cx: -6.04, r: 3.02, class: "map-crane-pivot" });
      makeCraneBoom(crane, false);
      makeCraneBoom(crane, true);
    }

    function makeCraneBoom(crane, working) {
      const baseX = -6.04;
      const angle = working ? -36 : -29;
      const reach = working ? 24.45 : 21.05;
      const elbow = working ? 16.25 : 14.2;
      const mode = add(crane, "g", { class: working ? "map-crane-raised" : "map-crane-folded" });
      const boom = add(mode, "g", { transform: `translate(${baseX} 0) rotate(${angle})` });
      add(boom, "path", {
        d: `M-.95 -2.03H8.95V-1.46H${elbow}v.45H${reach}v2.02H${elbow}v.45H8.95v.57H-.95Z`,
        class: "map-crane-boom"
      });
      add(boom, "path", { d: `M8.95 -1.42H${elbow}v2.84H8.95Z`, class: "map-crane-boom-sleeve" });
      add(boom, "path", { d: `M${elbow} -1H${reach}v2H${elbow}Z`, class: "map-crane-boom-tip" });
      add(boom, "path", { d: `M1.45 -1.02H7.83M10 -.69H${elbow - 1.25}`, class: "map-crane-boom-detail" });
      add(boom, "circle", { r: 1.07, class: "map-crane-boom-pin" });

      const radians = angle * Math.PI / 180;
      const tipX = (baseX + Math.cos(radians) * (reach - .22)).toFixed(2);
      const tipY = (Math.sin(radians) * (reach - .22)).toFixed(2);
      const drop = working ? 5.45 : 3.9;
      add(mode, "path", { d: `M${tipX} ${tipY}v${drop}q0 1.74-1.34 1.74-1.16 0-1.16-.98`, class: "map-crane-hook" });
    }

    function makeMotorbikeGlyph(bike) {
      // Match the cars' overhead view, with the front pointing along +X.
      // A side-view rider appears inverted when westbound traffic rotates 180°.
      add(bike, "ellipse", { cy: .4, rx: 7.6, ry: 3.5, class: "map-car-shadow" });
      for (const x of [-7.2, 4]) {
        add(bike, "rect", { x, y: -1.05, width: 3.7, height: 2.1, rx: .8, class: "map-motorbike-tire" });
      }
      add(bike, "path", {
        d: "M-5.2 -1.5Q-3.2 -2.2-.3 -1.75L4.9 -.9V.9L-.3 1.75Q-3.2 2.2-5.2 1.5Z",
        class: "map-motorbike-body"
      });
      add(bike, "rect", { x: -4.6, y: -1.15, width: 3.8, height: 2.3, rx: 1, class: "map-motorbike-seat" });
      add(bike, "path", { d: "M3.8 -3v6M-4.6 2.15H-1.4", class: "map-motorbike-chrome" });
      add(bike, "path", { d: "M-2.3 -1.25-1.1 -2.5 .3 -2.25M-2.3 1.25-1.1 2.5 .3 2.25", class: "map-motorbike-trousers" });
      add(bike, "ellipse", { cx: -1.5, rx: 2.3, ry: 1.8, class: "map-motorbike-rider" });
      add(bike, "path", { d: "M-1.2 -1.5 .9 -2.6 3.8 -2.6M-1.2 1.5 .9 2.6 3.8 2.6", class: "map-motorbike-arm" });
      add(bike, "circle", { cx: .8, r: 1.8, class: "map-motorbike-helmet" });
      add(bike, "path", { d: "M1.25 -1.25Q2.4 0 1.25 1.25L1.5 0Z", class: "map-motorbike-visor" });
      add(bike, "path", { d: "M6.1 -.7v1.4", class: "map-motorbike-lights" });
      add(bike, "path", { d: "M-5.7 -.7v1.4", class: "map-motorbike-tail-light" });
    }

    function createVehicleMarker(vehicle) {
      const key = String(vehicle.id);
      const bike = vehicle.type === "bike";
      const crane = vehicle.type === "crane";
      const bus = vehicle.type === "bus";
      const group = add(layers.vehicles, "g", {
        class: `map-vehicle-marker${bike ? " is-bike" : ""}${crane ? " is-crane" : ""}${bus ? " is-bus" : ""}`,
        tabindex: "0",
        role: "button",
        "data-vehicle-key": key
      });
      const color = ["#42947c", "#aa9549", "#548ab5", "#ba7f63"];
      const hash = Array.from(key).reduce((value, character) => value + character.charCodeAt(0), 0);
      if (!bike && !crane && !bus) group.style.setProperty("--map-car-tone", color[hash % color.length]);
      const hitRadius = bus ? 19 : crane ? 13.5 : 11;
      add(group, "rect", { x: -hitRadius, y: -7.5, width: 2 * hitRadius, height: 15, rx: 5, class: "map-vehicle-hitarea", "aria-hidden": "true" });
      add(group, "ellipse", { rx: bus ? 22 : crane ? 14.5 : 12, ry: crane ? 9.5 : 12, class: "map-vehicle-selection-ring", "aria-hidden": "true" });
      add(group, "use", { href: bike ? "#mapBikeGlyph" : crane ? "#mapCraneGlyph" : bus ? "#mapBusGlyph" : "#mapCarGlyph",
        transform: bike ? "scale(1.05)" : crane ? "scale(.94)" : bus ? "scale(1)" : "scale(.83)", "aria-hidden": "true" });
      const marker = { group, data: vehicle, position: null, completed: false };
      const select = () => {
        showTooltip(group, vehicleTooltipText(marker));
        onVehicleSelect(marker.data.id);
      };
      group.addEventListener("pointerenter", () => showTooltip(group, vehicleTooltipText(marker)));
      group.addEventListener("pointerleave", () => { if (document.activeElement !== group) hideTooltip(group); });
      group.addEventListener("focus", () => showTooltip(group, vehicleTooltipText(marker)));
      group.addEventListener("blur", () => hideTooltip(group));
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!suppressClick) select();
      });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
        if (event.key === "Escape") hideTooltip(group);
      });
      vehicleMarkers.set(key, marker);
      return marker;
    }

    function vehicleStatus(vehicle, completed = false) {
      if (completed) return "Journey complete";
      const incident = incidentsByVehicle.get(String(vehicle.id));
      if (incident) return `Broken down · ${Math.max(0, Math.ceil(finite(incident.remaining)))}s remaining`;
      if (vehicle.brokenDown) return "Broken down";
      if (vehicle.bus?.stage === "boarding") return `Boarding at ${vehicle.bus.stopName} · ${Math.ceil(vehicle.bus.remaining)}s until departure`;
      if (vehicle.bus?.stage === "rejoining") return "Waiting for space to pull away";
      const work = roadworksByVehicle.get(String(vehicle.id));
      if (work?.state === "working") return `Resurfacing ${work.streetId}`;
      if (work?.state === "clearing") return `Waiting for ${work.streetId} to clear`;
      if (vehicle.waitingReason === "breakdown") {
        return roadStates.get(vehicle.streetId)?.breakdownRecovering ? "Waiting for the breakdown queue to clear" : "Queued behind a breakdown";
      }
      if (vehicle.breakdownPassing) return "Passing a breakdown";
      if (vehicle.waiting) return vehicle.waitingReason === "signal" ? "Waiting at a signal" : "Waiting for traffic";
      return work ? `En route to ${work.streetId}` : "Moving";
    }

    function vehicleTooltipText(marker) {
      const vehicle = marker.data;
      const type = vehicleTypeLabel(vehicle.type);
      const angle = marker.position?.angle || 0;
      const directions = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
      const heading = directions[Math.round(((angle % 360) + 360) % 360 / 45) % directions.length];
      const streetId = marker.position?.streetId || vehicle.streetId;
      return `${vehicle.plate || vehicle.id} · ${type} · ${vehicleStatus(vehicle, marker.completed)} · Heading ${heading}${streetId ? ` · ${streetId}` : ""}`;
    }

    function configureMarker(marker, vehicle, completed = false) {
      marker.data = vehicle;
      marker.completed = completed;
      marker.group.classList.toggle("is-selected", vehicle.id === renderOptions.selectedVehicleId);
      marker.group.classList.toggle("is-complete", completed);
      marker.group.classList.toggle("is-queued", !completed && vehicle.waitingReason === "breakdown");
      marker.group.classList.toggle("is-broken-down", !completed &&
        Boolean(vehicle.brokenDown || incidentsByVehicle.has(String(vehicle.id))));
      marker.group.classList.toggle("is-working", vehicle.type === "crane" && !completed &&
        roadworksByVehicle.get(String(vehicle.id))?.state === "working");
      const type = vehicleTypeLabel(vehicle.type).toLowerCase();
      const label = `${vehicle.plate || vehicle.id}, ${type}${vehicle.streetId ? ` on ${vehicle.streetId}` : ""}. ${vehicleStatus(vehicle, completed)}. Select to inspect its route.`;
      if (marker.group.getAttribute("aria-label") !== label) marker.group.setAttribute("aria-label", label);
    }

    function setMotion(next) {
      if (!next || next === currentMotion) return;
      const interval = currentMotion ? next.time - currentMotion.time : Infinity;
      const newRun = !currentMotion || next.generation !== currentMotion.generation || interval < 0;
      if (newRun) {
        for (const person of transitPeople.values()) person.group.remove();
        transitPeople.clear();
        for (const marker of vehicleMarkers.values()) marker.group.remove();
        vehicleMarkers.clear();
        if (activeTooltipTarget?.classList.contains("map-vehicle-marker")) hideTooltip();
      }
      if (newRun || interval > (next.stepSeconds || .25) + .001) previousMotion = next;
      else if (interval > 0) previousMotion = currentMotion;
      currentMotion = next;
      motionDirty = true;
    }

    function prepareVehicleTracks() {
      const previous = new Map(previousMotion.vehicles.map((vehicle) => [String(vehicle.id), vehicle]));
      const tracks = [];
      for (const vehicle of currentMotion.vehicles) {
        const key = String(vehicle.id);
        const marker = vehicleMarkers.get(key) || createVehicleMarker(vehicle);
        configureMarker(marker, vehicle);
        tracks.push({ marker, from: previous.get(key) || vehicle, to: vehicle });
        previous.delete(key);
      }
      // Keep cars and motorbikes visible through the last leg's exit tick.
      for (const [key, vehicle] of previous) {
        if (vehicle.type === "crane") continue;
        const marker = vehicleMarkers.get(key) || createVehicleMarker(vehicle);
        configureMarker(marker, vehicle);
        tracks.push({ marker, from: vehicle, to: { ...vehicle, progress: 1, nextStreetId: null } });
      }
      const selected = renderOptions.selectedVehicleId;
      if (selected !== null && !tracks.some(({ to }) => to.id === selected)) {
        const complete = snapshot?.completed?.find((vehicle) => vehicle.id === selected);
        const existing = vehicleMarkers.get(String(selected));
        const last = complete?.route?.at(-1) || existing?.data;
        if (last && (complete?.type ?? existing?.data.type) !== "crane") {
          const terminal = { ...complete, ...last, progress: 1, nextStreetId: null };
          const marker = existing || createVehicleMarker(terminal);
          configureMarker(marker, terminal, true);
          tracks.push({ marker, from: terminal, to: terminal });
        }
      }
      const retained = new Set(tracks.map(({ marker }) => marker));
      for (const [key, marker] of vehicleMarkers) {
        if (retained.has(marker)) continue;
        if (activeTooltipTarget === marker.group) hideTooltip(marker.group);
        marker.group.remove();
        vehicleMarkers.delete(key);
      }
      vehicleTracks = tracks;
    }

    function junctionCurve(fromRoad, fromReverse, toRoad, toReverse) {
      if (!fromRoad || !toRoad) return null;
      const incomingNode = fromReverse ? fromRoad.street.from : fromRoad.street.to;
      const outgoingNode = toReverse ? toRoad.street.to : toRoad.street.from;
      if (incomingNode !== outgoingNode || exitNodes.has(incomingNode)) return null;
      const key = `${fromRoad.street.id}:${Number(fromReverse)}>${toRoad.street.id}:${Number(toReverse)}`;
      if (junctionCurves.has(key)) return junctionCurves.get(key);
      const fromLength = lengthFor(fromRoad.surface);
      const toLength = lengthFor(toRoad.surface);
      const trim = (road, length) => Math.min(length * .22, 19 + laneCenter(road.street) * .6);
      const incoming = trim(fromRoad, fromLength);
      const outgoing = trim(toRoad, toLength);
      const start = pathPose(fromRoad.surface, 1 - incoming / fromLength, fromReverse, laneCenter(fromRoad.street));
      const end = pathPose(toRoad.surface, outgoing / toLength, toReverse, laneCenter(toRoad.street));
      const handle = Math.min(23, Math.max(5, Math.hypot(end.x - start.x, end.y - start.y) * .48));
      const control = (point, distance) => {
        const angle = point.angle * Math.PI / 180;
        return { x: point.x + Math.cos(angle) * distance, y: point.y + Math.sin(angle) * distance };
      };
      const curve = { incoming, outgoing, start, startControl: control(start, handle), endControl: control(end, -handle), end };
      junctionCurves.set(key, curve);
      return curve;
    }

    function curvePose(curve, distance) {
      const { incoming, outgoing, start, startControl, endControl, end } = curve;
      const t = (distance + incoming) / (incoming + outgoing);
      const v = 1 - t;
      const a = v * v;
      const b = 2 * v * t;
      const c = t * t;
      const dx = a * (startControl.x - start.x) + b * (endControl.x - startControl.x) + c * (end.x - endControl.x);
      const dy = a * (startControl.y - start.y) + b * (endControl.y - startControl.y) + c * (end.y - endControl.y);
      return {
        x: a * v * start.x + 3 * a * t * startControl.x + 3 * v * c * endControl.x + c * t * end.x,
        y: a * v * start.y + 3 * a * t * startControl.y + 3 * v * c * endControl.y + c * t * end.y,
        angle: Math.atan2(dy, dx) * 180 / Math.PI
      };
    }

    function vehiclePose(vehicle, progress, bypass) {
      const road = roads.get(vehicle.streetId);
      if (!road) return null;
      const reverse = Boolean(vehicle.reverse);
      const length = lengthFor(road.surface);
      const distance = progress * length;
      let pose;
      // Trim the lane ends into one tangent-continuous curve. Both adjacent
      // legs sample that curve, including the tick that crosses the node.
      if (vehicle.previousStreetId && distance < 28) {
        const curve = junctionCurve(roads.get(vehicle.previousStreetId), Boolean(vehicle.previousReverse), road, reverse);
        if (curve && distance < curve.outgoing) pose = curvePose(curve, distance);
      }
      if (vehicle.nextStreetId && length - distance < 28) {
        const curve = junctionCurve(road, reverse, roads.get(vehicle.nextStreetId), Boolean(vehicle.nextReverse));
        if (curve && length - distance < curve.incoming) pose = curvePose(curve, distance - length);
      }
      const laneOffset = laneCenter(road.street) - (road.street.oneWay ? 4.8 : 5.4) * bypass;
      return { ...(pose || pathPose(road.surface, progress, reverse, laneOffset)), streetId: vehicle.streetId, elevated: Boolean(road.street.flyover) };
    }

    function interpolateVehicle(from, to, fraction) {
      const bypass = mix(finite(from.breakdownBypass), finite(to.breakdownBypass), fraction);
      if (from.streetId === to.streetId && from.reverse === to.reverse) {
        return vehiclePose(to, mix(from.progress, to.progress, fraction), bypass);
      }
      const oldRoad = roads.get(from.streetId);
      const newRoad = roads.get(to.streetId);
      if (!oldRoad || !newRoad) return vehiclePose(to, to.progress, bypass);
      const oldLength = lengthFor(oldRoad.surface);
      const newLength = lengthFor(newRoad.surface);
      const travelled = mix((from.progress - 1) * oldLength, to.progress * newLength, fraction);
      if (travelled < 0) {
        const incoming = from.nextStreetId === to.streetId && from.nextReverse === to.reverse
          ? from : { ...from, nextStreetId: to.streetId, nextReverse: to.reverse };
        return vehiclePose(incoming, 1 + travelled / oldLength, bypass);
      }
      const outgoing = to.previousStreetId === from.streetId && to.previousReverse === from.reverse
        ? to : { ...to, previousStreetId: from.streetId, previousReverse: from.reverse };
      return vehiclePose(outgoing, travelled / newLength, bypass);
    }

    function positionVehicle(marker, pose) {
      if (!pose) return;
      const layer = marker.group.classList.contains("is-broken-down") ? layers.stalledVehicles :
        pose.elevated ? layers.elevatedVehicles : layers.vehicles;
      if (marker.group.parentNode !== layer) {
        if (typeof layer.moveBefore === "function") layer.moveBefore(marker.group, null);
        else {
          const focused = document.activeElement === marker.group;
          layer.appendChild(marker.group);
          if (focused) marker.group.focus({ preventScroll: true });
        }
      }
      const last = marker.position;
      if (!last || Math.abs(pose.x - last.x) >= .01 || Math.abs(pose.y - last.y) >= .01 || Math.abs(pose.angle - last.angle) >= .1) {
        marker.group.setAttribute("transform", `translate(${pose.x.toFixed(2)} ${pose.y.toFixed(2)}) rotate(${pose.angle.toFixed(2)})`);
        marker.position = pose;
      }
    }

    function animate(fraction) {
      fraction = clamp(finite(fraction), 0, 1);
      if (!currentMotion || (!motionDirty && lastFraction === fraction)) return;
      lastFraction = fraction;
      if (motionDirty) {
        prepareRoadworkTracks();
        prepareBreakdownTimers();
        prepareVehicleTracks();
        preparePedestrianTracks();
      }
      motionDirty = false;
      for (const { marker, from, to } of vehicleTracks) {
        positionVehicle(marker, interpolateVehicle(from, to, fraction));
      }
      positionBreakdownTimers();
      animatePedestrians(fraction);
      animateTransport(fraction);
      animateRoadworks(fraction);
      const hovered = activeTooltipTarget;
      if (hovered?.classList.contains("map-vehicle-marker")) {
        const marker = vehicleMarkers.get(hovered.getAttribute("data-vehicle-key"));
        if (marker) {
          const label = vehicleTooltipText(marker);
          if (label !== activeTooltipText) updateTooltipText(label);
          else if (marker.group.matches(":hover, :focus-visible")) positionTooltip(marker.group);
        }
      }
    }

    function updateTooltipText(text) {
      if (!tooltip || !activeTooltipTarget || !text || text === activeTooltipText) return;
      activeTooltipText = text;
      tooltip.textContent = text;
      positionTooltip(activeTooltipTarget);
    }

    function showTooltip(target, text) {
      if (!tooltip || !target || !text) return;
      activeTooltipTarget = target;
      activeTooltipText = "";
      tooltip.hidden = false;
      updateTooltipText(text);
    }

    function hideTooltip(target) {
      if (target && activeTooltipTarget && target !== activeTooltipTarget) return;
      activeTooltipTarget = null;
      activeTooltipText = "";
      if (tooltip) tooltip.hidden = true;
    }

    function positionTooltip(target) {
      if (!tooltip || !target?.isConnected) return;
      const mapBox = frame.getBoundingClientRect();
      const targetBox = target.getBoundingClientRect();
      const x = targetBox.left + targetBox.width / 2 - mapBox.left;
      const targetTop = targetBox.top - mapBox.top;
      const tooltipWidth = tooltip.offsetWidth || 100;
      const tooltipHeight = tooltip.offsetHeight || 28;
      const left = clamp(x, tooltipWidth / 2 + 6, mapBox.width - tooltipWidth / 2 - 6);
      const below = targetTop < tooltipHeight + 14;
      const top = below ? clamp(targetBox.bottom - mapBox.top + 8, 4, mapBox.height - tooltipHeight - 4) : clamp(targetTop - 8, tooltipHeight + 4, mapBox.height - 4);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      tooltip.classList.toggle("below", below);
    }

    function handleMapClick(event) {
      if (suppressClick) return;
      const interactive = event.target.closest?.(".map-street-hit, .map-signal-hit, .map-vehicle-marker, .map-crossing-hit, .map-roadwork-hit, .map-breakdown-timer-hit");
      if (interactive) return;
      hideTooltip();
      onStreetSelect(null);
    }

    function svgPoint(event) {
      const matrix = svg.getScreenCTM();
      if (!matrix) return { x: event.clientX, y: event.clientY };
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const local = point.matrixTransform(matrix.inverse());
      return { x: local.x, y: local.y };
    }

    function handlePointerDown(event) {
      if (event.button !== 0 && event.pointerType !== "touch") return;
      if (event.target.closest?.(".map-signal-hit, .map-vehicle-marker, .map-crossing-hit, .map-roadwork-hit, .map-breakdown-timer-hit")) return;
      const point = svgPoint(event);
      drag = { id: event.pointerId, start: point, origin: { ...transform }, moved: false };
    }

    function handlePointerMove(event) {
      if (!drag || drag.id !== event.pointerId) {
        if (activeTooltipTarget && event.pointerType !== "touch") positionTooltip(activeTooltipTarget);
        return;
      }
      const point = svgPoint(event);
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      if (!drag.moved) {
        try { svg.setPointerCapture(event.pointerId); } catch {}
      }
      drag.moved = true;
      transform.x = drag.origin.x + dx;
      transform.y = drag.origin.y + dy;
      applyTransform();
      if (activeTooltipTarget) positionTooltip(activeTooltipTarget);
    }

    function finishPointer(event) {
      if (!drag || drag.id !== event.pointerId) return;
      const moved = drag.moved;
      drag = null;
      try { svg.releasePointerCapture(event.pointerId); } catch {}
      if (moved) {
        suppressClick = true;
        window.setTimeout(() => { suppressClick = false; }, 0);
      }
    }

    function applyTransform() {
      layers.camera.setAttribute("transform", `translate(${transform.x} ${transform.y}) scale(${transform.scale})`);
    }

    function zoomBy(factor) {
      const next = clamp(transform.scale * finite(factor, 1), .35, 2.8);
      if (next === transform.scale) return;
      const center = frameCenterPoint();
      const ratio = next / transform.scale;
      transform.x = center.x - (center.x - transform.x) * ratio;
      transform.y = center.y - (center.y - transform.y) * ratio;
      transform.scale = next;
      applyTransform();
      if (activeTooltipTarget) positionTooltip(activeTooltipTarget);
    }

    function resetView() {
      const box = frame.getBoundingClientRect();
      const topLeft = svgPoint({ clientX: box.left, clientY: box.top });
      const bottomRight = svgPoint({ clientX: box.right, clientY: box.bottom });
      const width = finite(data.width, 1440);
      const height = finite(data.height, 900);
      const scale = Math.min(1, Math.abs(bottomRight.x - topLeft.x) / width, Math.abs(bottomRight.y - topLeft.y) / height) || 1;
      transform = { x: (topLeft.x + bottomRight.x - width * scale) / 2, y: (topLeft.y + bottomRight.y - height * scale) / 2, scale };
      applyTransform();
      if (activeTooltipTarget) positionTooltip(activeTooltipTarget);
    }

    function focusVehicle(id) {
      const live = currentMotion?.vehicles?.find((item) => item.id === id);
      const vehicle = live || snapshot?.vehicles?.find((item) => item.id === id);
      const completed = vehicle ? null : snapshot?.completed?.find((item) => item.id === id);
      const marker = vehicleMarkers.get(String(id));
      if (!live && (vehicle?.type ?? completed?.type ?? marker?.data.type) === "crane") return false;
      let pose = marker?.position;
      if (!pose && vehicle) pose = vehiclePose(vehicle, vehicle.progress, finite(vehicle.breakdownBypass));
      if (!pose && completed?.route?.length) {
        const last = completed.route[completed.route.length - 1];
        pose = pathPose(roads.get(last.streetId)?.surface, 1, Boolean(last.reverse));
      }
      if (!pose) return false;
      transform.scale = Math.max(transform.scale, 1.28);
      const center = frameCenterPoint();
      transform.x = center.x - pose.x * transform.scale;
      transform.y = center.y - pose.y * transform.scale;
      applyTransform();
      return true;
    }

    function frameCenterPoint() {
      const box = frame.getBoundingClientRect();
      return svgPoint({ clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 });
    }

    function render(nextSnapshot, nextOptions = {}, motion = nextSnapshot) {
      snapshot = nextSnapshot || {};
      const previouslySelectedStreet = renderOptions.selectedStreetId;
      if ("selectedVehicleId" in nextOptions && renderOptions.selectedVehicleId !== nextOptions.selectedVehicleId) motionDirty = true;
      renderOptions = { ...renderOptions, ...nextOptions };
      setMotion(motion);
      if (motion && (!motion.crossings || !motion.roadworks || !motion.incidents)) motionDirty = true;
      renderRoadStates();
      if (previouslySelectedStreet !== renderOptions.selectedStreetId) {
        paintRoad(previouslySelectedStreet);
        paintRoad(renderOptions.selectedStreetId);
      }
      renderRoutes();
      renderCrossings();
      renderSignals();
      layers.labels.classList.toggle("is-hidden", !renderOptions.showLabels);
      if (!renderOptions.showSignals && activeTooltipTarget?.closest?.(".map-signal")) hideTooltip();
      if (activeTooltipTarget) positionTooltip(activeTooltipTarget);
      if (motion === nextSnapshot) animate(1);
    }

    function setTheme(theme) {
      const dark = theme === "dark";
      svg.dataset.theme = dark ? "dark" : "light";
    }

    function clearSelection() {
      const previouslySelectedStreet = renderOptions.selectedStreetId;
      renderOptions = { ...renderOptions, selectedStreetId: null, selectedVehicleId: null, selectedCrossingId: null };
      paintRoad(previouslySelectedStreet);
      renderRoutes();
      renderCrossings();
      motionDirty = true;
      animate(lastFraction);
      hideTooltip();
    }

    initializeSvg();
    setTheme("light");
    return { render, setMotion, animate, setTheme, zoomBy, resetView, focusVehicle, clearSelection };
  }

  window.TrafficMap = { create };
})();
