(function buildSignalLayouts() {
  "use strict";

  const data = typeof window !== "undefined" ? window.MAP_PREVIEW_DATA : null;
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.streets)) return;

  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const streets = new Map();
  const roads = [];
  const labels = [];
  const nodeIncident = new Map(data.nodes.map((node) => [node.id, []]));

  for (const street of data.streets) {
    const curve = parseCubic(street.path);
    if (!curve) continue;
    const geometry = sampleCurve(curve);
    if (!(geometry.length > 0)) continue;
    const road = {
      street,
      curve,
      geometry,
      length: geometry.length,
      halfWidth: street.oneWay ? 11 : street.major ? 21 : 15,
      bounds: boundsOf(geometry.points)
    };
    streets.set(street.id, road);
    roads.push(road);
    if (nodeIncident.has(street.from)) nodeIncident.get(street.from).push(street.id);
    if (nodeIncident.has(street.to)) nodeIncident.get(street.to).push(street.id);

    if (street.label && Number.isFinite(Number(street.label.x)) && Number.isFinite(Number(street.label.y))) {
      labels.push({
        x: Number(street.label.x),
        y: Number(street.label.y),
        angle: uprightAngle(Number(street.label.angle) || 0),
        halfWidth: 23,
        halfHeight: 13
      });
    }
  }

  const controlledNodes = new Set();
  for (const definition of Array.isArray(data.signals) ? data.signals : []) {
    const road = streets.get(definition.streetId);
    if (!road) continue;
    const reverse = Boolean(definition.reverse);
    const nodeId = reverse ? road.street.from : road.street.to;
    if (nodes.has(nodeId)) controlledNodes.add(nodeId);
  }

  const approaches = [];
  for (const nodeId of controlledNodes) {
    const incident = nodeIncident.get(nodeId) || [];
    for (const streetId of incident) {
      const road = streets.get(streetId);
      if (!road) continue;
      if (road.street.to === nodeId) approaches.push(makeApproach(nodeId, road, false));
      if (road.street.from === nodeId && !road.street.oneWay) approaches.push(makeApproach(nodeId, road, true));
    }
  }

  const uniqueApproaches = new Map();
  for (const approach of approaches) uniqueApproaches.set(approach.id, approach);
  const planned = [...uniqueApproaches.values()];

  // The preview map is immutable in production and its solved curbside
  // placements are cached here to keep page initialization fast. The signature
  // covers every input that affects approaches, road clearances, or labels.
  const cachedPlacements = [
    ["k3:S24:1", 108, 204, 20], ["l2:S32:0", 60, 60, 20], ["k2:S3:1", 128, 176, 12],
    ["h3:S28:1", 38, 38, 20], ["q2:S20:0", 38, 38, 20], ["m4:S44:0", 60, 116, 12],
    ["h2:S34:1", 84, 124, 20], ["h3:S7:0", 38, 62, 24], ["l2:S36:1", 106, 106, 12],
    ["l3:S37:1", 38, 38, 20], ["q2:S21:1", 38, 38, 20], ["k2:S35:1", 102, 102, 20],
    ["h2:S7:1", 50, 114, 12], ["l3:S40:0", 38, 38, 20], ["h2:S22:0", 38, 38, 20],
    ["k3:S4:1", 38, 46, 20], ["h3:S27:0", 38, 38, 20], ["h2:S30:1", 46, 86, 20],
    ["l2:S9:0", 42, 42, 12], ["l3:S36:0", 38, 38, 20], ["h2:S23:1", 38, 38, 20],
    ["l2:S18:1", 126, 126, 20], ["m4:S43:1", 38, 38, 20], ["k2:S19:1", 38, 38, 20],
    ["k3:S3:0", 38, 38, 20], ["l2:S17:0", 50, 50, 20], ["k2:S18:0", 38, 38, 20],
    ["m4:S42:0", 38, 38, 20], ["m4:S46:0", 62, 62, 20], ["q2:S12:1", 38, 38, 20],
    ["k2:S2:0", 38, 46, 20], ["h2:S6:0", 38, 54, 20], ["h3:S8:1", 38, 46, 12]
  ];
  const cacheMatches = layoutSignature(data) === "1c9940dd86253abd" &&
    planned.length === cachedPlacements.length &&
    planned.every((approach) => cachedPlacements.some(([id]) => id === approach.id));
  if (cacheMatches) {
    const cacheById = new Map(cachedPlacements.map(([id, setback, headSetback, extra]) =>
      [id, { setback, headSetback, extra }]));
    const layouts = {};
    for (const approach of planned) {
      const placement = cacheById.get(approach.id);
      const candidate = candidateAt(approach, placement.setback, placement.headSetback, placement.extra);
      layouts[approach.id] = layoutFor(approach, candidate);
    }
    applyLayouts(layouts);
    return;
  }

  const candidateSets = planned.map((approach) => ({ approach, candidates: makeCandidates(approach) }));
  const byId = new Map(candidateSets.map((entry) => [entry.approach.id, entry]));
  const emptyDomains = candidateSets.filter((entry) => entry.candidates.length === 0).map((entry) => entry.approach.id);
  if (emptyDomains.length) {
    throw new Error(`No valid signal placement candidates for controlled approaches: ${emptyDomains.join(", ")}`);
  }

  // Solve the placement as a constraint problem instead of committing each
  // approach once. Dynamic minimum-remaining-values ordering explores the
  // tightest remaining approach first, and backtracking can re-home any number
  // of earlier heads when a close fork needs their curbside space.
  const selected = new Map();
  const maxSearchChecks = 3000000;
  let searchChecks = 0;
  let searchLimitExceeded = false;
  function solvePlacements() {
    if (selected.size === candidateSets.length) return true;

    const open = [];
    for (const entry of candidateSets) {
      if (selected.has(entry.approach.id)) continue;
      const compatible = [];
      for (const candidate of entry.candidates) {
        searchChecks += 1;
        if (searchChecks > maxSearchChecks) {
          searchLimitExceeded = true;
          return false;
        }
        if ([...selected.values()].every((prior) => !boxesTooClose(candidate, prior))) compatible.push(candidate);
      }
      if (!compatible.length) return false;
      open.push({ entry, compatible });
    }

    open.sort((a, b) => a.compatible.length - b.compatible.length ||
      b.entry.candidates.length - a.entry.candidates.length ||
      a.entry.approach.id.localeCompare(b.entry.approach.id));
    const { entry, compatible } = open[0];
    for (const candidate of compatible) {
      selected.set(entry.approach.id, candidate);
      if (solvePlacements()) return true;
      selected.delete(entry.approach.id);
      if (searchLimitExceeded) return false;
    }
    return false;
  }

  if (!solvePlacements()) {
    if (searchLimitExceeded) {
      throw new Error(`Signal layout search exceeded its ${maxSearchChecks} candidate-check budget; no partial layouts were emitted.`);
    }
    throw new Error(`Unable to place all controlled signal approaches without overlap: ${planned.map((approach) => approach.id).join(", ")}`);
  }

  const layouts = {};
  for (const candidate of selected.values()) {
    const approach = byId.get(candidate.approachId)?.approach;
    if (!approach) continue;
    layouts[approach.id] = layoutFor(approach, candidate);
  }

  const missing = planned.filter((approach) => !Object.prototype.hasOwnProperty.call(layouts, approach.id));
  if (missing.length) {
    throw new Error(`Signal layout solver omitted controlled approaches: ${missing.map((approach) => approach.id).join(", ")}`);
  }

  applyLayouts(layouts);

  function applyLayouts(layouts) {
    data.signalLayouts = layouts;
    for (const crossing of data.pedestrianCrossings || []) {
      const layout = layouts[crossing.id];
      if (!layout) continue;
      crossing.progress = Math.min(1 - 28 / layout.length, layout.progress + 11.5 / layout.length);
      crossing.halfSpan = 6.5 / layout.length;
    }
  }

  function layoutFor(approach, candidate) {
    return {
      id: approach.id,
      nodeId: approach.nodeId,
      streetId: approach.street.id,
      reverse: approach.reverse,
      progress: candidate.barProgress,
      vehicleStopProgress: candidate.vehicleStopProgress,
      head: { x: candidate.x, y: candidate.y },
      bar: candidate.bar,
      pole: candidate.pole,
      length: approach.road.length
    };
  }

  function candidateAt(approach, setback, headSetback, extra) {
    const { road } = approach;
    const barPose = poseFromNode(road, approach.reverse, setback);
    const barInner = offsetPoint(barPose.point, barPose.normal, road.street.oneWay ? 2 - road.halfWidth : 2);
    const barOuter = offsetPoint(barPose.point, barPose.normal, road.halfWidth - 2);
    const headPose = poseFromNode(road, approach.reverse, headSetback);
    const center = offsetPoint(headPose.point, headPose.normal, road.halfWidth + extra);
    const curb = offsetPoint(headPose.point, headPose.normal, road.halfWidth + 1);
    const base = { x: center.x, y: center.y + 15 };
    return {
      approachId: approach.id,
      x: center.x,
      y: center.y,
      barProgress: clamp(1 - setback / road.length, 0, 1),
      vehicleStopProgress: clamp(1 - (setback + 14) / road.length, 0, 1),
      bar: { x1: barInner.x, y1: barInner.y, x2: barOuter.x, y2: barOuter.y },
      pole: { x1: curb.x, y1: curb.y, x2: base.x, y2: base.y }
    };
  }

  function layoutSignature(source) {
    const input = JSON.stringify({
      version: "signal-layout-v5-incoming-lane",
      nodes: source.nodes.map((node) => node.id),
      streets: source.streets.map((street) => [
        street.id, street.from, street.to, street.path, Boolean(street.major), Boolean(street.oneWay), Boolean(street.flyover),
        street.label ? [street.label.x, street.label.y, street.label.angle] : null
      ]),
      signals: (Array.isArray(source.signals) ? source.signals : []).map((signal) =>
        [signal.streetId, Boolean(signal.reverse)])
    });
    let first = 2166136261;
    let second = 0x84222325;
    for (let i = 0; i < input.length; i += 1) {
      const character = input.charCodeAt(i);
      first = Math.imul(first ^ character, 16777619);
      second = Math.imul(second ^ character, 16777619);
    }
    return (first >>> 0).toString(16).padStart(8, "0") + (second >>> 0).toString(16).padStart(8, "0");
  }

  function makeApproach(nodeId, road, reverse) {
    const id = `${nodeId}:${road.street.id}:${reverse ? 1 : 0}`;
    return {
      id,
      nodeId,
      street: road.street,
      road,
      reverse
    };
  }

  function makeCandidates(approach) {
    const { road } = approach;
    const maxSetback = Math.min(180, road.length - 30);
    const candidates = [];
    const extras = [12, 16, 20, 24, 28, 30];
    // At the S9/S32 fork each head sits directly beside its own inbound bar.
    // Other tightly spaced streets can stagger the head along the same curb.
    const fork = approach.nodeId === "l2";
    const headShifts = fork ? [0] : [0, -8, 8, -16, 16, -24, 24, 32, 40, 48, 56, 64, 80, 96];
    for (let setback = 38; setback <= maxSetback + 0.001; setback += 2) {
      const barPose = poseFromNode(road, approach.reverse, setback);
      const barInner = offsetPoint(barPose.point, barPose.normal, road.street.oneWay ? 2 - road.halfWidth : 2);
      const barOuter = offsetPoint(barPose.point, barPose.normal, road.halfWidth - 2);
      if (!lineClearsOtherRoads(barInner, barOuter, road.street.id)) continue;
      if (labels.some((label) => barOverlapsLabel(barInner, barOuter, label))) continue;
      for (const headShift of headShifts) {
        const headSetback = setback + headShift;
        if (headSetback < 38 || headSetback > road.length - 24) continue;
        const headPose = poseFromNode(road, approach.reverse, headSetback);
        for (const extra of extras) {
          const center = offsetPoint(headPose.point, headPose.normal, road.halfWidth + extra);
          const box = { x: center.x, y: center.y, halfWidth: 7, halfHeight: 15 };
          if (labels.some((label) => boxOverlapsLabel(box, label))) continue;
          if (!boxClearsRoads(box)) continue;
          if (fork && !lineClearsOtherRoads(center, center, road.street.id, extra + 3)) continue;

          const curb = offsetPoint(headPose.point, headPose.normal, road.halfWidth + 1);
          const base = { x: center.x, y: center.y + 15 };
          const poleLength = Math.hypot(base.x - curb.x, base.y - curb.y);
          if (poleLength > 46 || !poleClearsOtherRoads(curb, base, road.street.id)) continue;

          candidates.push({
            ...box,
            approachId: approach.id,
            setback,
            headSetback,
            extra,
            score: setback * 1000 + Math.abs(headShift) * 20 + Math.abs(extra - 20),
            barProgress: clamp(1 - setback / road.length, 0, 1),
            vehicleStopProgress: clamp(1 - (setback + 14) / road.length, 0, 1),
            bar: { x1: barInner.x, y1: barInner.y, x2: barOuter.x, y2: barOuter.y },
            pole: { x1: curb.x, y1: curb.y, x2: base.x, y2: base.y }
          });
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score || a.x - b.x || a.y - b.y);
    return candidates;
  }

  function poseFromNode(road, reverse, setback) {
    const baseDistance = reverse ? setback : road.length - setback;
    const pose = pointTangentAtDistance(road, baseDistance);
    let tx = pose.tx;
    let ty = pose.ty;
    if (reverse) { tx = -tx; ty = -ty; }
    const magnitude = Math.hypot(tx, ty) || 1;
    tx /= magnitude;
    ty /= magnitude;
    return {
      point: pose.point,
      tangent: { x: tx, y: ty },
      normal: { x: -ty, y: tx }
    };
  }

  function boxClearsRoads(box) {
    for (const road of roads) {
      const radius = road.halfWidth + 1;
      if (!boundsOverlap(expandBounds(boxBounds(box), radius), road.bounds)) continue;
      const left = box.x - box.halfWidth - radius;
      const right = box.x + box.halfWidth + radius;
      const top = box.y - box.halfHeight - radius;
      const bottom = box.y + box.halfHeight + radius;
      for (let i = 1; i < road.geometry.points.length; i += 1) {
        const a = road.geometry.points[i - 1];
        const b = road.geometry.points[i];
        if (Math.max(a.x, b.x) < left || Math.min(a.x, b.x) > right || Math.max(a.y, b.y) < top || Math.min(a.y, b.y) > bottom) continue;
        if (segmentRectDistance(a, b, box) < radius) return false;
      }
    }
    return true;
  }

  function poleClearsOtherRoads(a, b, ownStreetId) {
    return lineClearsOtherRoads(a, b, ownStreetId);
  }

  function lineClearsOtherRoads(a, b, ownStreetId, margin = 1) {
    for (const road of roads) {
      if (road.street.id === ownStreetId) continue;
      const clearance = road.halfWidth + margin;
      const minX = Math.min(a.x, b.x) - clearance;
      const maxX = Math.max(a.x, b.x) + clearance;
      const minY = Math.min(a.y, b.y) - clearance;
      const maxY = Math.max(a.y, b.y) + clearance;
      if (maxX < road.bounds.minX || minX > road.bounds.maxX || maxY < road.bounds.minY || minY > road.bounds.maxY) continue;
      for (let i = 1; i < road.geometry.points.length; i += 1) {
        const c = road.geometry.points[i - 1];
        const d = road.geometry.points[i];
        if (Math.max(c.x, d.x) < minX || Math.min(c.x, d.x) > maxX || Math.max(c.y, d.y) < minY || Math.min(c.y, d.y) > maxY) continue;
        if (segmentDistance(a, b, c, d) < clearance) return false;
      }
    }
    return true;
  }

  function boxesTooClose(a, b) {
    const dx = Math.max(0, Math.abs(a.x - b.x) - a.halfWidth - b.halfWidth);
    const dy = Math.max(0, Math.abs(a.y - b.y) - a.halfHeight - b.halfHeight);
    return Math.hypot(dx, dy) < 8;
  }

  function barOverlapsLabel(a, b, label) {
    const angle = label.angle * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const local = (point) => {
      const x = point.x - label.x;
      const y = point.y - label.y;
      return { x: x * cos + y * sin, y: -x * sin + y * cos };
    };
    const w = label.halfWidth + 3;
    const h = label.halfHeight + 3;
    return segmentIntersectsRect(local(a), local(b), -w, w, -h, h);
  }

  function boxOverlapsLabel(box, label) {
    const radians = label.angle * Math.PI / 180;
    const ux = { x: Math.cos(radians), y: Math.sin(radians) };
    const uy = { x: -Math.sin(radians), y: Math.cos(radians) };
    const dx = box.x - label.x;
    const dy = box.y - label.y;
    const axes = [
      { x: 1, y: 0 }, { x: 0, y: 1 }, ux, uy
    ];
    for (const axis of axes) {
      const boxRadius = box.halfWidth * Math.abs(axis.x) + box.halfHeight * Math.abs(axis.y);
      const labelRadius = label.halfWidth * Math.abs(ux.x * axis.x + ux.y * axis.y) +
        label.halfHeight * Math.abs(uy.x * axis.x + uy.y * axis.y);
      if (Math.abs(dx * axis.x + dy * axis.y) > boxRadius + labelRadius) return false;
    }
    return true;
  }

  function parseCubic(path) {
    if (typeof path !== "string") return null;
    const values = path.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi);
    if (!values || values.length < 8) return null;
    const n = values.slice(0, 8).map(Number);
    if (!n.every(Number.isFinite)) return null;
    return { p0: { x: n[0], y: n[1] }, p1: { x: n[2], y: n[3] }, p2: { x: n[4], y: n[5] }, p3: { x: n[6], y: n[7] } };
  }

  function sampleCurve(curve) {
    const controlLength = distance(curve.p0, curve.p1) + distance(curve.p1, curve.p2) + distance(curve.p2, curve.p3);
    const count = Math.max(96, Math.min(640, Math.ceil(controlLength / 1.15)));
    const points = [];
    let length = 0;
    for (let i = 0; i <= count; i += 1) {
      const t = i / count;
      const point = cubicPoint(curve, t);
      if (i) length += distance(points[i - 1], point);
      points.push({ x: point.x, y: point.y, t, distance: length });
    }
    return { points, length };
  }

  function pointTangentAtDistance(road, targetDistance) {
    const points = road.geometry.points;
    const target = clamp(targetDistance, 0, road.length);
    let low = 0;
    let high = points.length - 1;
    while (low + 1 < high) {
      const mid = (low + high) >> 1;
      if (points[mid].distance < target) low = mid;
      else high = mid;
    }
    const a = points[low];
    const b = points[high];
    const span = b.distance - a.distance;
    const fraction = span ? (target - a.distance) / span : 0;
    const t = a.t + (b.t - a.t) * fraction;
    return { point: cubicPoint(road.curve, t), ...cubicTangent(road.curve, t) };
  }

  function cubicPoint(curve, t) {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
      x: a * curve.p0.x + b * curve.p1.x + c * curve.p2.x + d * curve.p3.x,
      y: a * curve.p0.y + b * curve.p1.y + c * curve.p2.y + d * curve.p3.y
    };
  }

  function cubicTangent(curve, t) {
    const u = 1 - t;
    return {
      tx: 3 * u * u * (curve.p1.x - curve.p0.x) + 6 * u * t * (curve.p2.x - curve.p1.x) + 3 * t * t * (curve.p3.x - curve.p2.x),
      ty: 3 * u * u * (curve.p1.y - curve.p0.y) + 6 * u * t * (curve.p2.y - curve.p1.y) + 3 * t * t * (curve.p3.y - curve.p2.y)
    };
  }

  function segmentRectDistance(a, b, rect) {
    const left = rect.x - rect.halfWidth;
    const right = rect.x + rect.halfWidth;
    const top = rect.y - rect.halfHeight;
    const bottom = rect.y + rect.halfHeight;
    if (segmentIntersectsRect(a, b, left, top, right, bottom)) return 0;
    const corners = [
      { x: left, y: top }, { x: right, y: top },
      { x: right, y: bottom }, { x: left, y: bottom }
    ];
    let best = Math.min(pointRectDistance(a, left, top, right, bottom), pointRectDistance(b, left, top, right, bottom));
    for (const corner of corners) best = Math.min(best, pointSegmentDistance(corner, a, b));
    return best;
  }

  function segmentIntersectsRect(a, b, left, top, right, bottom) {
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const checks = [
      [-dx, a.x - left], [dx, right - a.x],
      [-dy, a.y - top], [dy, bottom - a.y]
    ];
    for (const [p, q] of checks) {
      if (p === 0) { if (q < 0) return false; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  }

  function pointRectDistance(point, left, top, right, bottom) {
    const dx = Math.max(left - point.x, 0, point.x - right);
    const dy = Math.max(top - point.y, 0, point.y - bottom);
    return Math.hypot(dx, dy);
  }

  function segmentDistance(a, b, c, d) {
    if (segmentsIntersect(a, b, c, d)) return 0;
    return Math.min(
      pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
      pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b)
    );
  }

  function segmentsIntersect(a, b, c, d) {
    const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const o1 = orient(a, b, c); const o2 = orient(a, b, d);
    const o3 = orient(c, d, a); const o4 = orient(c, d, b);
    const epsilon = 1e-9;
    const within = (value, start, end) => value >= Math.min(start, end) - epsilon && value <= Math.max(start, end) + epsilon;
    if (((o1 < -epsilon && o2 > epsilon) || (o1 > epsilon && o2 < -epsilon)) &&
        ((o3 < -epsilon && o4 > epsilon) || (o3 > epsilon && o4 < -epsilon))) return true;
    if (Math.abs(o1) <= epsilon && within(c.x, a.x, b.x) && within(c.y, a.y, b.y)) return true;
    if (Math.abs(o2) <= epsilon && within(d.x, a.x, b.x) && within(d.y, a.y, b.y)) return true;
    if (Math.abs(o3) <= epsilon && within(a.x, c.x, d.x) && within(a.y, c.y, d.y)) return true;
    if (Math.abs(o4) <= epsilon && within(b.x, c.x, d.x) && within(b.y, c.y, d.y)) return true;
    return false;
  }

  function pointSegmentDistance(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const denominator = dx * dx + dy * dy;
    const t = denominator ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator, 0, 1) : 0;
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
  }

  function offsetPoint(point, normal, amount) {
    return { x: point.x + normal.x * amount, y: point.y + normal.y * amount };
  }

  function boundsOf(points) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
    return { minX, minY, maxX, maxY };
  }

  function boxBounds(box) {
    return { minX: box.x - box.halfWidth, minY: box.y - box.halfHeight, maxX: box.x + box.halfWidth, maxY: box.y + box.halfHeight };
  }

  function expandBounds(bounds, amount) {
    return { minX: bounds.minX - amount, minY: bounds.minY - amount, maxX: bounds.maxX + amount, maxY: bounds.maxY + amount };
  }

  function boundsOverlap(a, b) {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
  }

  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function uprightAngle(angle) {
    let normalized = ((angle % 360) + 360) % 360;
    if (normalized > 90 && normalized < 270) normalized -= 180;
    return normalized;
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
})();
