/* Plan geometry shared by the 2D plan style, the 3D view and the analysis layers.
   Pure functions on AI_MAP_SPEC data (no DOM, no three.js); works as a browser
   global (window.WorkbenchGeometry) and as a Node module for tests. */
(root => {
  'use strict';

  const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
  // Default block height per object kind (metres) when objects[].height is missing.
  const OBJECT_HEIGHT = {
    hero: 1.3, case: 1, display: 1, artifact: .9, altar: 1.1, column: 3, pier: 3, bench: .45, couch: .5,
    table: .75, desk: .8, planter: .8, rope: .9, sign: 1.8, relief: 2, supply: .6, hearth: .8, fountain: .6,
    mosaic: .04, dome: .04, spawn: .04, cover: 1.1, object: .8,
  };
  const defaultHeight = kind => (Object.prototype.hasOwnProperty.call(OBJECT_HEIGHT, kind) ? OBJECT_HEIGHT[kind] : .8);
  const NEAR_FACTOR = 1.25;
  const EPS = 1e-9;

  function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, zi] = polygon[i], [xj, zj] = polygon[j];
      if ((zi > point[1]) !== (zj > point[1]) && point[0] < (xj - xi) * (point[1] - zi) / ((zj - zi) || 1e-9) + xi) inside = !inside;
    }
    return inside;
  }

  function segmentDistance(point, a, b) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const length = dx * dx + dz * dz;
    const t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / length)) : 0;
    return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dz);
  }

  function boxOf(points) {
    return {
      minX: Math.min(...points.map(p => p[0])), maxX: Math.max(...points.map(p => p[0])),
      minZ: Math.min(...points.map(p => p[1])), maxZ: Math.max(...points.map(p => p[1])),
    };
  }

  // An object as it stands in its current state: the state's fields override the
  // object's own. overrides maps object id → state id (else initialState, else states[0]).
  function resolveObject(object, overrides = {}) {
    const current = {
      points: object.points, solid: object.solid, baseHeight: object.baseHeight ?? 0,
      height: object.height, present: true, stateId: null,
    };
    const states = Array.isArray(object.states) ? object.states : [];
    if (!states.length) return current;
    const stateId = overrides[object.id] ?? object.initialState ?? states[0].id;
    current.stateId = stateId;
    const chosen = states.find(item => item.id === stateId);
    if (chosen) {
      for (const key of ['points', 'solid', 'baseHeight', 'height']) if (chosen[key] !== undefined) current[key] = chosen[key];
      if (chosen.present === false) current.present = false;
    }
    return current;
  }

  // Collinear room edges on one floor merged into continuous wall runs.
  // heightOf(room) → wall height; rooms with height 0 (open spaces) add no walls;
  // edges listed in room.openEdges add no wall either.
  function wallRuns(rooms, heightOf = () => 1) {
    const lines = new Map();
    for (const room of rooms) {
      const height = heightOf(room);
      if (!(height > 0) || !room.points?.length) continue;
      const open = new Set(Array.isArray(room.openEdges) ? room.openEdges : []);
      room.points.forEach((a, index) => {
        if (open.has(index)) return;
        const b = room.points[(index + 1) % room.points.length];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length < .15) return;
        let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (angle < 0) angle += Math.PI;
        if (angle >= Math.PI - 1e-6) angle -= Math.PI;
        const ux = Math.cos(angle), uz = Math.sin(angle);
        const offset = -a[0] * uz + a[1] * ux;
        const key = `${angle.toFixed(3)}|${offset.toFixed(2)}`;
        const t1 = a[0] * ux + a[1] * uz, t2 = b[0] * ux + b[1] * uz;
        if (!lines.has(key)) lines.set(key, { ux, uz, offset, spans: [] });
        lines.get(key).spans.push([Math.min(t1, t2), Math.max(t1, t2), height]);
      });
    }
    const runs = [];
    for (const { ux, uz, offset, spans } of lines.values()) {
      const at = t => [t * ux - offset * uz, t * uz + offset * ux];
      spans.sort((m, n) => m[0] - n[0]);
      let current = null;
      const flush = () => current && runs.push({ a: at(current[0]), b: at(current[1]), height: current[2] });
      for (const span of spans) {
        if (current && span[0] <= current[1] + .05) {
          current[1] = Math.max(current[1], span[1]);
          current[2] = Math.max(current[2], span[2]);
        } else {
          flush();
          current = [...span];
        }
      }
      flush();
    }
    return runs;
  }

  // Door openings lying on run a→b, as [start, end] distances along it.
  function doorCuts(a, b, doors) {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < .15) return { length, cuts: [] };
    const ux = (b[0] - a[0]) / length, uz = (b[1] - a[1]) / length;
    const offset = p => Math.abs((p[0] - a[0]) * uz - (p[1] - a[1]) * ux);
    const along = p => (p[0] - a[0]) * ux + (p[1] - a[1]) * uz;
    const cuts = [];
    for (const door of doors) {
      const [p, q] = door.points;
      if (offset(p) > .35 || offset(q) > .35) continue;
      let t1 = Math.min(along(p), along(q)), t2 = Math.max(along(p), along(q));
      if (t2 - t1 < (door.width || 0)) {
        const mid = (t1 + t2) / 2;
        t1 = mid - door.width / 2;
        t2 = mid + door.width / 2;
      }
      if (t2 > 0 && t1 < length) cuts.push([Math.max(0, t1), Math.min(length, t2), door]);
    }
    return { length, cuts: cuts.sort((m, n) => m[0] - n[0]) };
  }

  // Wall pieces left on run a→b after cutting out every door lying on it.
  function wallSpans(a, b, doors) {
    const { length, cuts } = doorCuts(a, b, doors);
    if (length < .15) return [];
    const ux = (b[0] - a[0]) / length, uz = (b[1] - a[1]) / length;
    const spans = [];
    let t = 0;
    for (const [c1, c2] of cuts) {
      if (c1 - t > .1) spans.push([t, c1]);
      t = Math.max(t, c2);
    }
    if (length - t > .1) spans.push([t, length]);
    return spans.map(([s, e]) => [[a[0] + ux * s, a[1] + uz * s], [a[0] + ux * e, a[1] + uz * e]]);
  }

  // Which bbox side the stair climbs toward (its "to" end). stairs[].bottom wins;
  // otherwise the side touching a room on the target floor; otherwise the long axis.
  function stairSide(stair, box, roomsByFloor, elevationOf) {
    const cx = (box.minX + box.maxX) / 2, cz = (box.minZ + box.maxZ) / 2;
    const sides = {
      E: { axis: 'x', sign: 1, probe: [box.maxX + .6, cz] },
      W: { axis: 'x', sign: -1, probe: [box.minX - .6, cz] },
      N: { axis: 'z', sign: 1, probe: [cx, box.maxZ + .6] },
      S: { axis: 'z', sign: -1, probe: [cx, box.minZ - .6] },
    };
    if (sides[stair.bottom]) {
      const climbsUp = elevationOf(stair.toFloorId) >= elevationOf(stair.fromFloorId);
      return sides[climbsUp ? OPPOSITE[stair.bottom] : stair.bottom];
    }
    const touches = (floorId, p) => (roomsByFloor.get(floorId) || []).some(room => pointInPolygon(p, room.points));
    let best = null, bestScore = 0;
    for (const side of Object.values(sides)) {
      const score = (touches(stair.toFloorId, side.probe) ? 2 : 0) - (touches(stair.fromFloorId, side.probe) ? 1 : 0);
      if (score > bestScore) { best = side; bestScore = score; }
    }
    return best || { axis: box.maxX - box.minX >= box.maxZ - box.minZ ? 'x' : 'z', sign: 1 };
  }

  /* Walking distance to the nearest source over a grid of the floor.
     Walkable = inside a room and not inside a solid object. Moving between two
     different rooms is only allowed where a door is; inside a room you move freely
     (8-neighbour Dijkstra). Result rows run north→south (row 0 = bounds.maxZ).
     dist: -1 = not walkable, Infinity = walkable but no path to any source. */
  function distanceField({ rooms, doors = [], solids = [], sources = [], bounds, cell }) {
    const nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
    const nz = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell));
    const roomBoxes = rooms.map(room => ({ points: room.points, box: boxOf(room.points) }));
    const solidBoxes = solids.map(solid => ({ points: solid.points, box: boxOf(solid.points) }));
    const inside = (list, x, z) => list.findIndex(item => x >= item.box.minX && x <= item.box.maxX && z >= item.box.minZ && z <= item.box.maxZ && pointInPolygon([x, z], item.points));
    const centre = (i, j) => [bounds.minX + (i + .5) * cell, bounds.maxZ - (j + .5) * cell];
    const roomAt = new Int32Array(nx * nz).fill(-1);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const [x, z] = centre(i, j);
        const room = inside(roomBoxes, x, z);
        if (room >= 0 && inside(solidBoxes, x, z) < 0) roomAt[j * nx + i] = room;
      }
    }
    const reach = Math.max(cell * .8, .35);
    const viaDoor = (p, q) => {
      const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      return doors.some(door => door.points?.length === 2 && segmentDistance(mid, door.points[0], door.points[1]) <= reach);
    };
    const dist = new Float64Array(nx * nz).fill(Infinity);
    for (let k = 0; k < dist.length; k++) if (roomAt[k] < 0) dist[k] = -1;

    // Binary heap of [distance, index].
    const heap = [];
    const push = (d, k) => {
      heap.push([d, k]);
      for (let n = heap.length - 1; n > 0;) {
        const parent = (n - 1) >> 1;
        if (heap[parent][0] <= heap[n][0]) break;
        [heap[parent], heap[n]] = [heap[n], heap[parent]];
        n = parent;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let n = 0; ;) {
          const l = n * 2 + 1, r = l + 1;
          let m = n;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === n) break;
          [heap[m], heap[n]] = [heap[n], heap[m]];
          n = m;
        }
      }
      return top;
    };

    // Seed: every walkable cell inside a source polygon, else the nearest walkable cell.
    // A source may carry a starting distance `d` (e.g. a stair coming from another floor).
    const seeded = [];
    let start = 0;
    const seed = k => { if (start < dist[k]) { dist[k] = start; push(start, k); } };
    for (const source of sources) {
      let any = false;
      start = source.d || 0;
      if (source.points?.length >= 3) {
        const box = boxOf(source.points);
        for (let j = 0; j < nz; j++) {
          for (let i = 0; i < nx; i++) {
            const [x, z] = centre(i, j);
            if (roomAt[j * nx + i] < 0 || x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
            if (pointInPolygon([x, z], source.points)) { seed(j * nx + i); any = true; }
          }
        }
      }
      if (!any) {
        const target = source.point || (source.points?.length ? [
          source.points.reduce((sum, p) => sum + p[0], 0) / source.points.length,
          source.points.reduce((sum, p) => sum + p[1], 0) / source.points.length,
        ] : null);
        if (!target) continue;
        let best = -1, bestD = cell * 4;
        for (let k = 0; k < dist.length; k++) {
          if (roomAt[k] < 0) continue;
          const [x, z] = centre(k % nx, Math.floor(k / nx));
          const d = Math.hypot(x - target[0], z - target[1]);
          if (d < bestD) { bestD = d; best = k; }
        }
        if (best >= 0) { seed(best); any = true; }
      }
      seeded.push(any);
    }

    const steps = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    while (heap.length) {
      const [d, k] = pop();
      if (d > dist[k]) continue;
      const i = k % nx, j = Math.floor(k / nx);
      for (const [di, dj, cost] of steps) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
        const n = nj * nx + ni;
        if (roomAt[n] < 0) continue;
        if (di && dj && (roomAt[j * nx + ni] < 0 || roomAt[nj * nx + i] < 0)) continue; // no corner cutting
        if (roomAt[n] !== roomAt[k] && !viaDoor(centre(i, j), centre(ni, nj))) continue;
        const next = d + cost * cell;
        if (next < dist[n]) { dist[n] = next; push(next, n); }
      }
    }
    let max = 0, unreachable = 0, walkable = 0;
    for (const d of dist) {
      if (d < 0) continue;
      walkable += 1;
      if (d === Infinity) unreachable += 1;
      else if (d > max) max = d;
    }
    return { nx, nz, cell, bounds: { minX: bounds.minX, maxX: bounds.minX + nx * cell, minZ: bounds.maxZ - nz * cell, maxZ: bounds.maxZ }, dist, max, walkable, unreachable, seeded };
  }

  // Smallest reachable distance inside a polygon (else at the cell nearest its centroid).
  function minInPolygon(field, polygon) {
    const box = boxOf(polygon);
    let best = Infinity;
    for (let j = 0; j < field.nz; j++) {
      const z = field.bounds.maxZ - (j + .5) * field.cell;
      if (z < box.minZ || z > box.maxZ) continue;
      for (let i = 0; i < field.nx; i++) {
        const x = field.bounds.minX + (i + .5) * field.cell;
        if (x < box.minX || x > box.maxX || !pointInPolygon([x, z], polygon)) continue;
        const d = field.dist[j * field.nx + i];
        if (d >= 0 && d < best) best = d;
      }
    }
    if (best < Infinity) return best;
    const cx = polygon.reduce((sum, p) => sum + p[0], 0) / polygon.length, cz = polygon.reduce((sum, p) => sum + p[1], 0) / polygon.length;
    for (let ring = 0; ring <= 4 && best === Infinity; ring++) {
      for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const d = sampleField(field, cx + ox * ring * field.cell, cz + oz * ring * field.cell);
        if (d !== null && d < best) best = d;
      }
    }
    return best;
  }

  // Distance at a plan point (nearest cell), or null outside the grid / not walkable.
  function sampleField(field, x, z) {
    const i = Math.floor((x - field.bounds.minX) / field.cell), j = Math.floor((field.bounds.maxZ - z) / field.cell);
    if (i < 0 || j < 0 || i >= field.nx || j >= field.nz) return null;
    const d = field.dist[j * field.nx + i];
    return d < 0 ? null : d;
  }

  /* meta.proximity: which nodes of each rule are connected (same rules as the spec's
     "邻近规则" section and its Python reference implementation):
     anchor = footprint centroid at floor elevation + baseHeight + height / 2 (enemies:
     centre at floor elevation + player height / 2); connected when the 3D distance is
     ≤ radius and, with lineOfSight, the plan segment crosses no wall of either end's
     floor (per room edge; open doors cut, closed doors count as wall) and no solid,
     present non-node object whose vertical range overlaps the anchors' height range.
     near = pairs within radius × 1.25 that are not connected ('gap' or 'blocked').
     overrides maps object id → state id and door id → 'open' / 'closed'. */
  const strictCross = (a, b, c, d) => {
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
  };

  function insidePolygon(p, pts) {
    let inside = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  const segmentHitsPolygon = (a, b, pts) =>
    pts.some((p, i) => strictCross(a, b, p, pts[(i + 1) % pts.length])) || insidePolygon(a, pts) || insidePolygon(b, pts);

  function proximityWalls(data, overrides) {
    const floorHeight = new Map((data.floors || []).map(floor => [floor.id, floor.height]));
    const out = new Map();
    const add = (floorId, segment) => {
      if (!out.has(floorId)) out.set(floorId, []);
      out.get(floorId).push(segment);
    };
    for (const room of data.rooms || []) {
      const floorId = room.floorId;
      if ((room.wallHeight ?? floorHeight.get(floorId)) <= 0) continue;
      const pts = room.points || [], skip = new Set(room.openEdges || []);
      for (let i = 0; i < pts.length; i++) {
        if (skip.has(i)) continue;
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length < .15) continue;
        const ux = (b[0] - a[0]) / length, uz = (b[1] - a[1]) / length;
        const cuts = [];
        for (const door of data.doors || []) {
          if (door.floorId !== floorId || (overrides[door.id] ?? door.initial ?? 'open') !== 'open') continue;
          const [p, q] = door.points;
          if ([p, q].some(pt => Math.abs((pt[0] - a[0]) * uz - (pt[1] - a[1]) * ux) > .35)) continue;
          let [t1, t2] = [p, q].map(pt => (pt[0] - a[0]) * ux + (pt[1] - a[1]) * uz).sort((m, n) => m - n);
          if (t2 - t1 < (door.width ?? 0)) {
            const mid = (t1 + t2) / 2;
            t1 = mid - door.width / 2;
            t2 = mid + door.width / 2;
          }
          if (t2 > 0 && t1 < length) cuts.push([Math.max(0, t1), Math.min(length, t2)]);
        }
        let t = 0;
        for (const [c1, c2] of cuts.sort((m, n) => m[0] - n[0] || m[1] - n[1])) {
          if (c1 - t > .1) add(floorId, [[a[0] + ux * t, a[1] + uz * t], [a[0] + ux * c1, a[1] + uz * c1]]);
          t = Math.max(t, c2);
        }
        if (length - t > .1) add(floorId, [[a[0] + ux * t, a[1] + uz * t], [b[0], b[1]]]);
      }
    }
    return out;
  }

  function proximityGraph(data, overrides = {}) {
    const elevation = new Map((data.floors || []).map(floor => [floor.id, floor.elevation]));
    const playerHeight = data.meta?.player?.height;
    const walls = proximityWalls(data, overrides);
    const round2 = value => Number(value.toFixed(2));
    return (data.meta?.proximity || []).map(rule => {
      const kinds = new Set(rule.kinds || []), enemyTypes = new Set(rule.enemyTypes || []);
      const lineOfSight = rule.lineOfSight ?? true;
      const nodes = new Map(), blockers = [];
      for (const object of data.objects || []) {
        const current = resolveObject(object, overrides);
        if (current.present === false) continue;
        const base = elevation.get(object.floorId) + current.baseHeight;
        const height = current.height || defaultHeight(object.kind);
        const pts = current.points;
        if (kinds.has(object.kind)) {
          const anchor = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length, base + height / 2];
          nodes.set(object.id, { id: object.id, type: 'object', floorId: object.floorId, anchor });
        } else if (current.solid === true) {
          blockers.push({ id: object.id, pts, bottom: base, top: base + height });
        }
      }
      for (const enemy of data.enemies || []) {
        if (!enemyTypes.has(enemy.enemyType)) continue;
        nodes.set(enemy.id, { id: enemy.id, type: 'enemy', floorId: enemy.floorId, anchor: [enemy.center[0], enemy.center[1], elevation.get(enemy.floorId) + playerHeight / 2] });
      }
      const ids = [...nodes.keys()].sort();
      const links = [], near = [];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const A = nodes.get(ids[i]), B = nodes.get(ids[j]);
          const [pa, pb] = [A.anchor, B.anchor];
          const distance = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
          if (distance > rule.radius * NEAR_FACTOR) continue;
          const blockedBy = [];
          if (lineOfSight) {
            const floors = [...new Set([A.floorId, B.floorId])].sort();
            if (floors.some(floorId => (walls.get(floorId) || []).some(([s, e]) => strictCross(pa, pb, s, e)))) blockedBy.push('wall');
            const low = Math.min(pa[2], pb[2]), high = Math.max(pa[2], pb[2]);
            for (const blocker of blockers) {
              if (blocker.top > low && blocker.bottom < high && segmentHitsPolygon(pa, pb, blocker.pts)) blockedBy.push(blocker.id);
            }
          }
          const entry = { a: ids[i], b: ids[j], distance: round2(distance) };
          if (distance <= rule.radius && !blockedBy.length) links.push(entry);
          else near.push({ ...entry, reason: distance > rule.radius ? 'gap' : 'blocked', blockers: blockedBy });
        }
      }
      return { id: rule.id, name: rule.name, radius: rule.radius, nodes: ids.map(id => nodes.get(id)), links, near };
    });
  }

  const round2 = value => Number(value.toFixed(2));
  const cloneJson = value => JSON.parse(JSON.stringify(value));
  const polyCenter = pts => [
    pts.reduce((s, p) => s + p[0], 0) / pts.length,
    pts.reduce((s, p) => s + p[1], 0) / pts.length,
  ];
  const rectPoints = (cx, cz, w, d) => {
    const x0 = round2(cx - w / 2), x1 = round2(cx + w / 2);
    const z0 = round2(cz - d / 2), z1 = round2(cz + d / 2);
    return [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  };
  const isAxisRect = pts => {
    if (!Array.isArray(pts) || pts.length !== 4) return false;
    const xs = new Set(pts.map(p => round2(p[0])));
    const zs = new Set(pts.map(p => round2(p[1])));
    return xs.size === 2 && zs.size === 2;
  };

  function nearestPointOnSegment(p, a, b) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const lenSq = dx * dx + dz * dz;
    const t = lenSq ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / lenSq)) : 0;
    const proj = [a[0] + t * dx, a[1] + t * dz];
    return { t, point: proj, dist: Math.hypot(p[0] - proj[0], p[1] - proj[1]), len: Math.sqrt(lenSq) };
  }

  function segmentPolygonDist(a, b, polygon) {
    if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) return 0;
    let best = Infinity;
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length];
      if (strictCross(a, b, p, q)) return 0;
      best = Math.min(best, segmentDistance(a, p, q), segmentDistance(b, p, q), segmentDistance(p, a, b), segmentDistance(q, a, b));
    }
    return best;
  }

  function sharedRoomEdge(ptsA, ptsB, maxGap = .65) {
    let best = null;
    for (let i = 0; i < ptsA.length; i++) {
      const a1 = ptsA[i], a2 = ptsA[(i + 1) % ptsA.length];
      const lenA = Math.hypot(a2[0] - a1[0], a2[1] - a1[1]);
      if (lenA < .2) continue;
      const ux = (a2[0] - a1[0]) / lenA, uz = (a2[1] - a1[1]) / lenA;
      for (let j = 0; j < ptsB.length; j++) {
        const b1 = ptsB[j], b2 = ptsB[(j + 1) % ptsB.length];
        const lenB = Math.hypot(b2[0] - b1[0], b2[1] - b1[1]);
        if (lenB < .2) continue;
        const vx = (b2[0] - b1[0]) / lenB, vz = (b2[1] - b1[1]) / lenB;
        if (Math.abs(ux * vx + uz * vz) < .98) continue; // not collinear
        const perp1 = Math.abs((b1[0] - a1[0]) * uz - (b1[1] - a1[1]) * ux);
        const perp2 = Math.abs((b2[0] - a1[0]) * uz - (b2[1] - a1[1]) * ux);
        if (Math.max(perp1, perp2) > maxGap) continue;
        const proj = p => (p[0] - a1[0]) * ux + (p[1] - a1[1]) * uz;
        const s0 = Math.max(0, Math.min(proj(b1), proj(b2)));
        const s1 = Math.min(lenA, Math.max(proj(b1), proj(b2)));
        const span = s1 - s0;
        if (span >= .35 && (!best || span > best.span)) {
          // Place along the midpoint line between the two parallel edges.
          const offset = ((b1[0] - a1[0]) * (-uz) + (b1[1] - a1[1]) * ux) * .5;
          const ptAt = s => [round2(a1[0] + ux * s - uz * offset), round2(a1[1] + uz * s + ux * offset)];
          best = { span, s0, s1, ux, uz, ptAt };
        }
      }
    }
    return best;
  }

  function parseAttach(attach) {
    if (!attach) return null;
    if (typeof attach === 'string') {
      const m = attach.trim().match(/^(northOf|southOf|eastOf|westOf|north|south|east|west|[NSEW])\s*:\s*(.+)$/i);
      if (!m) return null;
      const side = m[1][0].toUpperCase();
      return { to: m[2].trim(), side, align: 'center', gap: 0 };
    }
    if (typeof attach === 'object') {
      const rawSide = String(attach.side || attach.dir || 'E').trim().toUpperCase();
      const side = ['N', 'S', 'E', 'W'].includes(rawSide[0]) ? rawSide[0] : 'E';
      return {
        to: attach.to,
        side,
        align: attach.align || 'center',
        gap: Number.isFinite(attach.gap) ? attach.gap : 0,
        at: Array.isArray(attach.at) && attach.at.length === 2 ? attach.at : null,
      };
    }
    return null;
  }

  // Expands relative room definitions (size + attach) and shared-edge doors (between: [a, b])
  // into standard AI_MAP_SPEC v1 polygons/segments. Standard rooms/doors pass through unchanged.
  function expandRelativeLayout(input) {
    if (!input || typeof input !== 'object') return input;
    const data = cloneJson(input);
    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    const doors = Array.isArray(data.doors) ? data.doors : [];
    const defaultFloor = data.floors?.[0]?.id;
    let expandedAny = false;

    const roomById = new Map(rooms.map(r => [r.id, r]));
    const resolved = new Set(rooms.filter(r => Array.isArray(r.points) && r.points.length >= 3).map(r => r.id));

    for (const room of rooms) {
      if (!room.floorId && defaultFloor) room.floorId = defaultFloor;
      if (resolved.has(room.id)) continue;
      if (!room.status) room.status = 'planned';
      const w = Number(Array.isArray(room.size) ? room.size[0] : (room.w ?? room.width));
      const d = Number(Array.isArray(room.size) ? room.size[1] : (room.d ?? room.depth ?? room.height));
      if (!(w > 0 && d > 0)) continue;
      const spec = parseAttach(room.attach);
      if (spec?.at) {
        room.points = rectPoints(spec.at[0], spec.at[1], w, d);
        resolved.add(room.id);
        expandedAny = true;
      } else if (!spec || !spec.to) {
        const at = Array.isArray(room.at) && room.at.length === 2 ? room.at : [0, 0];
        room.points = rectPoints(at[0], at[1], w, d);
        resolved.add(room.id);
        expandedAny = true;
      }
    }

    const boxOverlap = (A, B) => Math.max(0, Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX)) * Math.max(0, Math.min(A.maxZ, B.maxZ) - Math.max(A.minZ, B.minZ));
    for (let pass = 0; pass < rooms.length; pass++) {
      let progress = false;
      for (const room of rooms) {
        if (resolved.has(room.id)) continue;
        const w = Number(Array.isArray(room.size) ? room.size[0] : (room.w ?? room.width));
        const d = Number(Array.isArray(room.size) ? room.size[1] : (room.d ?? room.depth ?? room.height));
        const spec = parseAttach(room.attach);
        if (!(w > 0 && d > 0) || !spec?.to) continue;
        const anchor = roomById.get(spec.to);
        if (!anchor || !Array.isArray(anchor.points) || anchor.points.length < 3) continue;
        const b = boxOf(anchor.points);
        const acx = (b.minX + b.maxX) / 2, acz = (b.minZ + b.maxZ) / 2;
        let cx = acx, cz = acz;
        const alignOffset = (span, anchorSpan, mode) => {
          if (mode === 'start') return -(anchorSpan - span) / 2;
          if (mode === 'end') return (anchorSpan - span) / 2;
          return 0;
        };
        if (spec.side === 'E') {
          cx = b.maxX + spec.gap + w / 2;
          cz = acz + alignOffset(d, b.maxZ - b.minZ, spec.align);
        } else if (spec.side === 'W') {
          cx = b.minX - spec.gap - w / 2;
          cz = acz + alignOffset(d, b.maxZ - b.minZ, spec.align);
        } else if (spec.side === 'N') {
          cz = b.maxZ + spec.gap + d / 2;
          cx = acx + alignOffset(w, b.maxX - b.minX, spec.align);
        } else {
          cz = b.minZ - spec.gap - d / 2;
          cx = acx + alignOffset(w, b.maxX - b.minX, spec.align);
        }
        // Push outward along attachment axis if touching an already-placed same-floor room.
        const dirX = spec.side === 'E' ? 1 : (spec.side === 'W' ? -1 : 0);
        const dirZ = spec.side === 'N' ? 1 : (spec.side === 'S' ? -1 : 0);
        for (let step = 0; step < 12; step++) {
          const candBox = { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 };
          const hit = rooms.find(other => other.id !== room.id && other.floorId === room.floorId && Array.isArray(other.points) && other.points.length >= 3 && boxOverlap(candBox, boxOf(other.points)) > .5);
          if (!hit) break;
          const hb = boxOf(hit.points);
          if (dirX > 0) cx = hb.maxX + w / 2;
          else if (dirX < 0) cx = hb.minX - w / 2;
          else if (dirZ > 0) cz = hb.maxZ + d / 2;
          else cz = hb.minZ - d / 2;
        }
        room.points = rectPoints(cx, cz, w, d);
        delete room.size;
        delete room.attach;
        resolved.add(room.id);
        expandedAny = true;
        progress = true;
      }
      if (!progress) break;
    }

    for (const door of doors) {
      if (!door.floorId && Array.isArray(door.between) && door.between[0]) door.floorId = roomById.get(door.between[0])?.floorId || defaultFloor;
      if (!door.floorId && defaultFloor) door.floorId = defaultFloor;
      if (Array.isArray(door.points) && door.points.length === 2) continue;
      if (!Array.isArray(door.between) || door.between.length < 2) continue;
      const roomA = roomById.get(door.between[0]), roomB = roomById.get(door.between[1]);
      if (!roomA?.points || !roomB?.points) continue;
      const edge = sharedRoomEdge(roomA.points, roomB.points);
      if (!edge) continue;
      const width = Number(door.width) > 0 ? Number(door.width) : 2;
      door.width = width;
      const at = Number.isFinite(door.at) ? Math.max(0, Math.min(1, door.at)) : .5;
      const half = Math.min(width, edge.span) / 2;
      const midS = Math.max(edge.s0 + half, Math.min(edge.s1 - half, edge.s0 + edge.span * at));
      door.points = [edge.ptAt(midS - half), edge.ptAt(midS + half)];
      delete door.between;
      delete door.at;
      expandedAny = true;
    }

    if (expandedAny && rooms.some(r => Array.isArray(r.points) && r.points.length >= 3)) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const room of rooms) {
        for (const p of room.points || []) {
          minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
          minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
        }
      }
      if (Number.isFinite(minX)) {
        if (data.schemaVersion === undefined) data.schemaVersion = 1;
        data.meta = data.meta || {};
        if (!data.meta.units) data.meta.units = 'm';
        const b = data.meta.bounds;
        if (!b) data.meta.bounds = { minX: round2(minX - 4), maxX: round2(maxX + 4), minZ: round2(minZ - 4), maxZ: round2(maxZ + 4) };
        else {
          b.minX = round2(Math.min(b.minX, minX - 2));
          b.maxX = round2(Math.max(b.maxX, maxX + 2));
          b.minZ = round2(Math.min(b.minZ, minZ - 2));
          b.maxZ = round2(Math.max(b.maxZ, maxZ + 2));
        }
      }
    }
    return data;
  }

  // Deterministic geometric cleanup for AI-generated drafts:
  // 1) separates slight accidental axis-aligned room overlaps,
  // 2) snaps slightly detached doors onto the nearest same-floor room edge,
  // 3) nudges stateless blocking solid props clear of routes where space allows.
  function snapAndClearGeometry(input, opts = {}) {
    const data = cloneJson(input);
    const fixes = [];
    const maxNudge = opts.maxNudge ?? 2.5;
    const doorSnapMax = opts.doorSnapMax ?? 1.25;
    const rooms = data.rooms || [];
    const objects = data.objects || [];
    const enemies = data.enemies || [];
    const doors = data.doors || [];
    const routes = data.routes || [];
    const bounds = data.meta?.bounds;

    // 1. Resolve small accidental overlaps between axis-aligned rectangular rooms.
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i], b = rooms[j];
        if (a.floorId !== b.floorId || !isAxisRect(a.points) || !isAxisRect(b.points)) continue;
        const A = boxOf(a.points), B = boxOf(b.points);
        const ox = Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX);
        const oz = Math.min(A.maxZ, B.maxZ) - Math.max(A.minZ, B.minZ);
        if (ox <= 0 || oz <= 0 || ox * oz <= .5) continue;
        const areaA = (A.maxX - A.minX) * (A.maxZ - A.minZ), areaB = (B.maxX - B.minX) * (B.maxZ - B.minZ);
        if (ox * oz > Math.min(areaA, areaB) * .85) continue; // skip intentional nested courtyards
        const minPen = Math.min(ox, oz);
        if (minPen > maxNudge) continue;
        let dx = 0, dz = 0;
        if (ox <= oz) dx = ((B.minX + B.maxX) >= (A.minX + A.maxX) ? (A.maxX - B.minX) : (A.minX - B.maxX));
        else dz = ((B.minZ + B.maxZ) >= (A.minZ + A.maxZ) ? (A.maxZ - B.minZ) : (A.minZ - B.maxZ));
        dx = round2(dx); dz = round2(dz);
        if (!dx && !dz) continue;
        const insideOldB = p => p[0] >= B.minX - .05 && p[0] <= B.maxX + .05 && p[1] >= B.minZ - .05 && p[1] <= B.maxZ + .05;
        b.points = b.points.map(([x, z]) => [round2(x + dx), round2(z + dz)]);
        for (const obj of objects) {
          if (obj.floorId === b.floorId && Array.isArray(obj.points) && obj.points.length && insideOldB(polyCenter(obj.points))) {
            obj.points = obj.points.map(([x, z]) => [round2(x + dx), round2(z + dz)]);
          }
        }
        for (const enemy of enemies) {
          if (enemy.floorId === b.floorId && (enemy.roomId === b.id || (Array.isArray(enemy.center) && insideOldB(enemy.center)))) {
            enemy.center = [round2(enemy.center[0] + dx), round2(enemy.center[1] + dz)];
          }
        }
        fixes.push({ kind: 'room-unoverlap', id: b.id, dx, dz });
      }
    }

    // 2. Snap detached doors back onto the nearest room boundary edge on the same floor.
    for (const door of doors) {
      if (!Array.isArray(door.points) || door.points.length !== 2) continue;
      const mid = [(door.points[0][0] + door.points[1][0]) / 2, (door.points[0][1] + door.points[1][1]) / 2];
      let best = null;
      for (const room of rooms) {
        if (room.floorId !== door.floorId || !Array.isArray(room.points) || room.points.length < 3) continue;
        for (let i = 0; i < room.points.length; i++) {
          const a = room.points[i], b = room.points[(i + 1) % room.points.length];
          const hit = nearestPointOnSegment(mid, a, b);
          if (hit.len < .2) continue;
          if (!best || hit.dist < best.dist) best = { ...hit, a, b };
        }
      }
      if (!best || best.dist <= .02 || best.dist > doorSnapMax) continue;
      const ux = (best.b[0] - best.a[0]) / best.len, uz = (best.b[1] - best.a[1]) / best.len;
      const half = Math.min(door.width || 1.2, best.len) / 2;
      const centerS = Math.max(half, Math.min(best.len - half, best.t * best.len));
      door.points = [
        [round2(best.a[0] + ux * (centerS - half)), round2(best.a[1] + uz * (centerS - half))],
        [round2(best.a[0] + ux * (centerS + half)), round2(best.a[1] + uz * (centerS + half))],
      ];
      fixes.push({ kind: 'door-snap', id: door.id, dist: round2(best.dist) });
    }

    // 3. Push stateless solid blocking objects just clear of routes inside their room.
    const radius = Number(data.meta?.player?.radius) || 0;
    const playerHeight = Number(data.meta?.player?.height) || 0;
    if (radius > 0) {
      const floorElev = new Map((data.floors || []).map(f => [f.id, Number(f.elevation) || 0]));
      const inBounds = ([x, z]) => !bounds || (x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ);
      for (const object of objects) {
        if (object.solid !== true || (Array.isArray(object.states) && object.states.length) || !Array.isArray(object.points) || object.points.length < 3) continue;
        if (playerHeight > 0 && Number(object.baseHeight) >= playerHeight) continue;
        const objLow = (floorElev.get(object.floorId) || 0) + (Number(object.baseHeight) || 0);
        const objHigh = Number(object.height) > 0 ? objLow + Number(object.height) : Infinity;
        const hostRoom = rooms.find(r => r.floorId === object.floorId && Array.isArray(r.points) && pointInPolygon(polyCenter(object.points), r.points));
        const collidingSegs = pts => {
          const hits = [];
          for (const route of routes) {
            if (route.floorId !== object.floorId || !Array.isArray(route.points) || route.points.length < 2) continue;
            const rLevel = floorElev.get(route.floorId) || 0;
            const heights = route.points.map(p => (p.length === 3 ? p[2] : rLevel));
            for (let i = 1; i < route.points.length; i++) {
              const segLow = Math.min(heights[i - 1], heights[i]);
              const segHigh = Math.max(heights[i - 1], heights[i]) + playerHeight;
              if (segHigh <= objLow || segLow >= objHigh) continue;
              const d = segmentPolygonDist(route.points[i - 1], route.points[i], pts);
              if (d < radius - 1e-6) hits.push({ routeId: route.id, a: route.points[i - 1], b: route.points[i], d });
            }
          }
          return hits;
        };
        const isLegalPos = pts => pts.every(inBounds) && (!hostRoom || pts.every(p => pointInPolygon(p, hostRoom.points)));
        const initialHits = collidingSegs(object.points);
        if (initialHits.length) {
          const hit = initialHits[0];
          const rx = hit.b[0] - hit.a[0], rz = hit.b[1] - hit.a[1];
          const rl = Math.hypot(rx, rz) || 1;
          const px = -rz / rl, pz = rx / rl;
          const targetClear = radius + .16;
          const projs = object.points.map(([x, z]) => (x - hit.a[0]) * px + (z - hit.a[1]) * pz);
          const minS = Math.min(...projs), maxS = Math.max(...projs);
          const pushPos = targetClear - minS;
          const pushNeg = targetClear + maxS;
          const cands = [
            { dx: round2(px * pushPos), dz: round2(pz * pushPos) },
            { dx: round2(-px * pushNeg), dz: round2(-pz * pushNeg) },
          ];
          let chosen = cands
            .map(c => ({ ...c, dist: Math.hypot(c.dx, c.dz), moved: object.points.map(([x, z]) => [round2(x + c.dx), round2(z + c.dz)]) }))
            .filter(c => isLegalPos(c.moved) && collidingSegs(c.moved).length === 0)
            .sort((a, b) => a.dist - b.dist)[0] || null;
          if (!chosen) {
            // Fall back to a deterministic minimum-displacement grid search when multiple route segments corner the object.
            const maxR = Math.max(maxNudge, 3.0);
            const grid = [];
            for (let gdx = -maxR; gdx <= maxR + 1e-6; gdx += 0.4) {
              for (let gdz = -maxR; gdz <= maxR + 1e-6; gdz += 0.4) {
                const dist = Math.hypot(gdx, gdz);
                if (dist > 0.1 && dist <= maxR) grid.push({ dx: round2(gdx), dz: round2(gdz), dist });
              }
            }
            grid.sort((a, b) => a.dist - b.dist);
            for (const g of grid) {
              const moved = object.points.map(([x, z]) => [round2(x + g.dx), round2(z + g.dz)]);
              if (isLegalPos(moved) && collidingSegs(moved).length === 0) {
                chosen = { ...g, moved };
                break;
              }
            }
          }
          if (chosen) {
            object.points = chosen.moved;
            fixes.push({ kind: 'route-clear', id: object.id, routeId: hit.routeId, dx: chosen.dx, dz: chosen.dz });
          } else {
            // Partial fallback along a single normal if full clearance doesn't exist within maxNudge.
            const partial = cands
              .map(c => ({ ...c, dist: Math.hypot(c.dx, c.dz), moved: object.points.map(([x, z]) => [round2(x + c.dx), round2(z + c.dz)]) }))
              .filter(c => isLegalPos(c.moved) && segmentPolygonDist(hit.a, hit.b, c.moved) >= radius)
              .sort((a, b) => collidingSegs(a.moved).length - collidingSegs(b.moved).length || a.dist - b.dist)[0];
            if (partial) {
              object.points = partial.moved;
              fixes.push({ kind: 'route-clear', id: object.id, routeId: hit.routeId, dx: partial.dx, dz: partial.dz });
            }
          }
        }
      }
    }
    return { data, fixes };
  }

  // Ensures meta.bounds encloses all geometric coordinates in data with optional padding.
  function ensureBoundsCover(data, pad = 2) {
    if (!data?.meta?.bounds) return data;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const visitPt = p => {
      if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    };
    for (const key of ['rooms', 'objects', 'doors', 'routes', 'stairs', 'water']) {
      for (const item of data[key] || []) (item.points || []).forEach(visitPt);
    }
    for (const enemy of data.enemies || []) visitPt(enemy.center);
    for (const note of data.reviewNotes || []) visitPt(note.at);
    if (!Number.isFinite(minX)) return data;
    const b = data.meta.bounds;
    if (minX < b.minX) b.minX = round2(minX - pad);
    if (maxX > b.maxX) b.maxX = round2(maxX + pad);
    if (minZ < b.minZ) b.minZ = round2(minZ - pad);
    if (maxZ > b.maxZ) b.maxZ = round2(maxZ + pad);
    return data;
  }

  // Applies a partial AI patch ({ patch: {...} } or bare { upsertRooms, ... }) onto baseData.
  function applyAiPatch(baseData, payload, opts = {}) {
    const patch = payload?.patch && typeof payload.patch === 'object' ? payload.patch : payload;
    const next = cloneJson(baseData);
    if (patch.meta && typeof patch.meta === 'object') next.meta = { ...(next.meta || {}), ...patch.meta };
    if (Array.isArray(patch.floors)) next.floors = patch.floors;
    const remove = new Set(Array.isArray(patch.removeIds) ? patch.removeIds : []);
    const collections = [
      ['rooms', patch.upsertRooms || patch.rooms],
      ['objects', patch.upsertObjects || patch.objects],
      ['enemies', patch.upsertEnemies || patch.enemies],
      ['doors', patch.upsertDoors || patch.doors],
      ['routes', patch.upsertRoutes || patch.routes],
      ['stairs', patch.upsertStairs || patch.stairs],
      ['water', patch.upsertWater || patch.water],
    ];
    for (const [key, updates] of collections) {
      const hadKey = Array.isArray(next[key]) || Array.isArray(updates);
      if (!hadKey) continue;
      const list = Array.isArray(next[key]) ? next[key].filter(item => !remove.has(item.id)) : [];
      if (Array.isArray(updates)) {
        const byId = new Map(list.map((item, idx) => [item.id, idx]));
        for (const item of updates) {
          if (item?.id && byId.has(item.id)) list[byId.get(item.id)] = item;
          else if (item) list.push(item);
        }
      }
      next[key] = list;
    }
    // Keep links & reviewNotes referentially intact after removeIds deletions.
    if (remove.size && Array.isArray(next.links)) {
      next.links = next.links
        .filter(link => !remove.has(link.id))
        .map(link => ({
          ...link,
          from: Array.isArray(link.from) ? link.from.filter(id => !remove.has(id)) : [],
          to: Array.isArray(link.to) ? link.to.filter(t => t && !remove.has(t.id)) : [],
        }))
        .filter(link => link.from.length && link.to.length);
    }
    if (remove.size && Array.isArray(next.reviewNotes)) {
      next.reviewNotes = next.reviewNotes.filter(note => !remove.has(note.id) && (!note.targetId || !remove.has(note.targetId)));
    }
    const expanded = ensureBoundsCover(expandRelativeLayout(next));
    return opts.autoSnap === false ? { data: expanded, fixes: [] } : snapAndClearGeometry(expanded, opts);
  }

  // Builds a minimal neighborhood slice + issues + reviewNotes for focused AI edits.
  function buildAiEditContext(data, { selectedId = null, notes = [], validation = null, hops = 2 } = {}) {
    const rooms = data?.rooms || [];
    const roomById = new Map(rooms.map(r => [r.id, r]));
    const adj = new Map(rooms.map(r => [r.id, new Set()]));
    const boxes = new Map(rooms.filter(r => r.points?.length >= 3).map(r => [r.id, boxOf(r.points)]));
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i], b = rooms[j];
        if (a.floorId !== b.floorId) continue;
        const A = boxes.get(a.id), B = boxes.get(b.id);
        if (!A || !B) continue;
        const near = Math.min(A.maxX, B.maxX) >= Math.max(A.minX, B.minX) - 1.2 && Math.min(A.maxZ, B.maxZ) >= Math.max(A.minZ, B.minZ) - 1.2;
        if (near) { adj.get(a.id).add(b.id); adj.get(b.id).add(a.id); }
      }
    }
    const roomContaining = (floorId, pt) => rooms.find(r => (!floorId || r.floorId === floorId) && Array.isArray(r.points) && pointInPolygon(pt, r.points))?.id || null;
    const seeds = new Set();
    const resolveToRoom = id => {
      if (!id) return;
      if (roomById.has(id)) { seeds.add(id); return; }
      const obj = (data.objects || []).find(o => o.id === id);
      if (obj?.points?.length) { const r = roomContaining(obj.floorId, polyCenter(obj.points)); if (r) seeds.add(r); return; }
      const enemy = (data.enemies || []).find(e => e.id === id);
      if (enemy?.roomId) { seeds.add(enemy.roomId); return; }
      const door = (data.doors || []).find(d => d.id === id);
      if (door?.points?.length === 2) {
        const mid = [(door.points[0][0] + door.points[1][0]) / 2, (door.points[0][1] + door.points[1][1]) / 2];
        for (const r of rooms) {
          if (r.floorId !== door.floorId || !r.points?.length) continue;
          if (r.points.some((p, i) => segmentDistance(mid, p, r.points[(i + 1) % r.points.length]) <= .8)) seeds.add(r.id);
        }
      }
    };
    resolveToRoom(selectedId);
    for (const note of notes) {
      if (note.targetId) resolveToRoom(note.targetId);
      else if (Array.isArray(note.at)) { const r = roomContaining(note.floorId, note.at); if (r) seeds.add(r); }
    }
    const spatialWarnCodes = new Set(['door-off-boundary', 'room-overlap', 'route-clearance', 'door-narrow']);
    const issues = [
      ...(validation?.errors || []).map(e => ({ level: 'error', code: e.code, id: e.id || null, msg: e.msg })),
      ...(validation?.warnings || []).filter(w => spatialWarnCodes.has(w.code) || (selectedId && w.id === selectedId)).map(w => ({ level: 'warning', code: w.code, id: w.id || null, msg: w.msg })),
    ];
    for (const issue of issues) resolveToRoom(issue.id);
    if (!seeds.size && rooms[0]) seeds.add(rooms[0].id);

    const keep = new Set(seeds);
    let frontier = [...seeds];
    for (let h = 0; h < hops && frontier.length; h++) {
      const next = [];
      for (const id of frontier) {
        for (const nb of adj.get(id) || []) if (!keep.has(nb)) { keep.add(nb); next.push(nb); }
      }
      frontier = next;
    }
    const keptRooms = rooms.filter(r => keep.has(r.id));
    const keptBoxes = keptRooms.map(r => ({ id: r.id, floorId: r.floorId, box: boxes.get(r.id) }));
    const nearKept = (floorId, pt) => keptBoxes.some(k => (!floorId || k.floorId === floorId) && k.box && pt[0] >= k.box.minX - 1 && pt[0] <= k.box.maxX + 1 && pt[1] >= k.box.minZ - 1 && pt[1] <= k.box.maxZ + 1);
    return {
      focusRoomIds: [...seeds],
      neighborRoomIds: [...keep].filter(id => !seeds.has(id)),
      issues,
      notes,
      contextData: {
        schemaVersion: data.schemaVersion,
        meta: { title: data.meta?.title, bounds: data.meta?.bounds, player: data.meta?.player },
        floors: data.floors || [],
        rooms: keptRooms,
        doors: (data.doors || []).filter(d => d.points?.length === 2 && nearKept(d.floorId, [(d.points[0][0] + d.points[1][0]) / 2, (d.points[0][1] + d.points[1][1]) / 2])),
        objects: (data.objects || []).filter(o => o.points?.length && nearKept(o.floorId, polyCenter(o.points))),
        enemies: (data.enemies || []).filter(e => keep.has(e.roomId)),
        routes: (data.routes || []).filter(rt => rt.points?.some(p => nearKept(rt.floorId, p))),
        stairs: (data.stairs || []).filter(st => st.points?.length && nearKept(st.fromFloorId, polyCenter(st.points))),
      },
      proximity: proximityGraph(data),
    };
  }

  /* Deterministic UE5 whitebox build package derived from AI_MAP_SPEC v1 data
     and AI_GUIDE.md Section 12 conventions (cm, X=z*100 North, Y=x*100 East,
     Z=elevation*100 Up, North=+X=Yaw 0 deg, East=+Y=Yaw 90 deg). Keeps UE scripts
     free of geometry recomputation so in-engine layout hallucinations cannot occur. */
  function buildUeWhiteboxSpec(data) {
    const clean = cloneJson(data || {});
    const floors = clean.floors || [];
    const floorMap = new Map(floors.map(f => [f.id, f]));
    const elevationOf = id => (Number.isFinite(floorMap.get(id)?.elevation) ? floorMap.get(id).elevation : 0);
    const fullWallHeightOf = room => {
      if (Number.isFinite(room.wallHeight)) return room.wallHeight;
      const fh = floorMap.get(room.floorId)?.height;
      return fh > 0 ? fh : 3;
    };
    const toCm = v => round2(v * 100);
    const toUePlan = p => [toCm(p[1]), toCm(p[0])];
    const toUePos = (x, z, y = 0) => [toCm(z), toCm(x), toCm(y)];
    const toUeYaw = (dx, dz) => Number((Math.atan2(dx, dz) * 180 / Math.PI).toFixed(2));
    const ueBox = (box, bottomM, heightM) => ({
      centerCm: [toCm((box.minZ + box.maxZ) / 2), toCm((box.minX + box.maxX) / 2), toCm(bottomM + heightM / 2)],
      sizeCm: [toCm(box.maxZ - box.minZ), toCm(box.maxX - box.minX), toCm(heightM)],
    });

    const rooms = (clean.rooms || []).filter(r => r.points?.length >= 3);
    const roomsByFloor = new Map();
    for (const room of rooms) {
      if (!roomsByFloor.has(room.floorId)) roomsByFloor.set(room.floorId, []);
      roomsByFloor.get(room.floorId).push(room);
    }

    const stairs = [];
    const stairHoles = [];
    const missingStairBottom = [];
    for (const stair of clean.stairs || []) {
      const box = stair.points?.length ? boxOf(stair.points) : null;
      if (!box) continue;
      const hasBottom = ['N', 'S', 'E', 'W'].includes(stair.bottom);
      if (!hasBottom) missingStairBottom.push(stair.id);
      const fromElev = elevationOf(stair.fromFloorId);
      const toElev = elevationOf(stair.toFloorId);
      const upperFloorId = toElev >= fromElev ? stair.toFloorId : stair.fromFloorId;
      const lowFloorId = toElev >= fromElev ? stair.fromFloorId : stair.toFloorId;
      const stairMid = [(box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2];
      for (const room of roomsByFloor.get(upperFloorId) || []) {
        if (pointInPolygon(stairMid, room.points)) {
          stairHoles.push({
            stairId: stair.id,
            roomId: room.id,
            floorId: upperFloorId,
            polygonCm: stair.points.map(toUePlan),
            boxCm: ueBox(box, elevationOf(upperFloorId) - .2, .2),
          });
        }
      }
      const side = stairSide(stair, box, roomsByFloor, elevationOf);
      const steps = Math.max(3, Math.min(20, Math.round(Math.abs(toElev - fromElev) / .18)));
      const [lo, hi] = side.axis === 'x' ? [box.minX, box.maxX] : [box.minZ, box.maxZ];
      const [acrossLo, acrossHi] = side.axis === 'x' ? [box.minZ, box.maxZ] : [box.minX, box.maxX];
      const depth = (hi - lo) / steps, across = acrossHi - acrossLo, base = Math.min(fromElev, toElev);
      const acrossMid = (acrossLo + acrossHi) / 2;
      const stepItems = [];
      for (let idx = 0; idx < steps; idx++) {
        const top = fromElev + (toElev - fromElev) * (idx + 1) / steps;
        const h = Math.max(.05, top - base);
        const s = side.sign > 0 ? lo + (idx + .5) * depth : hi - (idx + .5) * depth;
        const planX = side.axis === 'x' ? s : acrossMid;
        const planZ = side.axis === 'x' ? acrossMid : s;
        // Local UE X corresponds to plan Z, local UE Y corresponds to plan X.
        const sizeXCm = toCm(side.axis === 'x' ? across : depth);
        const sizeYCm = toCm(side.axis === 'x' ? depth : across);
        const stepId = `${stair.id}__${String(idx + 1).padStart(2, '0')}`;
        stepItems.push({
          actorName: stepId,
          folder: `Map/${lowFloorId}/Stairs`,
          centerCm: [toCm(planZ), toCm(planX), toCm(base + h / 2)],
          sizeCm: [sizeXCm, sizeYCm, toCm(h)],
          collision: true,
          tags: [`id:${stair.id}`, 'type:stairs', `floor:${lowFloorId}`, `step:${idx + 1}`],
        });
      }
      stairs.push({
        id: stair.id,
        fromFloorId: stair.fromFloorId,
        toFloorId: stair.toFloorId,
        bottom: stair.bottom || null,
        missingBottom: !hasBottom,
        steps: stepItems,
      });
    }

    const nonRectRooms = [];
    const floorSlabs = rooms.map(room => {
      const elev = elevationOf(room.floorId);
      const rect = isAxisRect(room.points);
      if (!rect) nonRectRooms.push(room.id);
      const box = boxOf(room.points);
      return {
        id: room.id,
        name: room.name || room.id,
        actorName: `${room.id}__floor`,
        folder: `Map/${room.floorId}/Rooms`,
        floorId: room.floorId,
        kind: room.kind || 'room',
        color: room.color || '#e7dcc5',
        isRect: rect,
        topZCm: toCm(elev),
        thicknessCm: 20,
        polygonCm: room.points.map(toUePlan),
        boxCm: ueBox(box, elev - .2, .2),
        tags: [`id:${room.id}`, 'type:room', `floor:${room.floorId}`],
      };
    });

    const walls = [];
    const lintels = [];
    const doors = [];
    const doorDone = new Set();
    for (const floor of floors) {
      const floorId = floor.id;
      const elev = elevationOf(floorId);
      const floorDoors = (clean.doors || []).filter(d => d.floorId === floorId && d.points?.length === 2);
      const runs = wallRuns(roomsByFloor.get(floorId) || [], fullWallHeightOf);
      const floorSegments = [];
      for (const run of runs) {
        let angle = Math.atan2(run.b[1] - run.a[1], run.b[0] - run.a[0]);
        if (angle < 0) angle += Math.PI;
        const ux = Math.cos(angle), uz = Math.sin(angle);
        const offset = -run.a[0] * uz + run.a[1] * ux;
        for (const [p, q] of wallSpans(run.a, run.b, floorDoors)) {
          const tStart = Math.min(p[0] * ux + p[1] * uz, q[0] * ux + q[1] * uz);
          const dx = q[0] - p[0], dz = q[1] - p[1];
          floorSegments.push({
            angle, offset, tStart,
            p, q, dx, dz, height: run.height,
          });
        }
        const { length, cuts } = doorCuts(run.a, run.b, floorDoors);
        if (cuts.length && length >= .15) {
          const rux = (run.b[0] - run.a[0]) / length, ruz = (run.b[1] - run.a[1]) / length;
          const at = t => [run.a[0] + rux * t, run.a[1] + ruz * t];
          for (const [c1, c2, door] of cuts) {
            if (doorDone.has(door.id) || c2 - c1 <= .05) continue;
            doorDone.add(door.id);
            const p = at(c1), q = at(c2);
            const clearHeight = Number.isFinite(door.height) && door.height > 0 ? door.height : Math.min(2.4, run.height);
            if (clearHeight < run.height - .02) {
              const ldx = q[0] - p[0], ldz = q[1] - p[1];
              lintels.push({
                id: `${door.id}__lintel`,
                doorId: door.id,
                actorName: `${door.id}__lintel`,
                folder: `Map/${floorId}/Walls`,
                floorId,
                centerCm: toUePos((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, elev + clearHeight + (run.height - clearHeight) / 2),
                sizeCm: [toCm(Math.hypot(ldx, ldz)), 20, toCm(run.height - clearHeight)],
                yawDeg: toUeYaw(ldx, ldz),
                collision: true,
                tags: [`id:${door.id}`, 'type:door', `floor:${floorId}`, 'part:lintel'],
              });
            }
          }
        }
      }
      floorSegments.sort((a, b) => (a.angle - b.angle) || (a.offset - b.offset) || (a.tStart - b.tStart));
      floorSegments.forEach((seg, idx) => {
        const actorName = `wall__${floorId}__${String(idx + 1).padStart(3, '0')}`;
        walls.push({
          actorName,
          folder: `Map/${floorId}/Walls`,
          floorId,
          centerCm: toUePos((seg.p[0] + seg.q[0]) / 2, (seg.p[1] + seg.q[1]) / 2, elev + seg.height / 2),
          sizeCm: [toCm(Math.hypot(seg.dx, seg.dz)), 20, toCm(seg.height)],
          yawDeg: toUeYaw(seg.dx, seg.dz),
          collision: true,
          tags: [`id:${actorName}`, 'type:wall', `floor:${floorId}`],
        });
      });
      for (const door of floorDoors) {
        const [p, q] = door.points;
        const dx = q[0] - p[0], dz = q[1] - p[1];
        const width = Number.isFinite(door.width) && door.width > 0 ? door.width : Math.hypot(dx, dz);
        const wallH = floor.height > 0 ? floor.height : 3;
        const clearH = Number.isFinite(door.height) && door.height > 0 ? door.height : Math.min(2.4, wallH);
        const initial = door.initial || 'open';
        doors.push({
          id: door.id,
          actorName: door.id,
          closedLeafActorName: initial === 'closed' ? `${door.id}__closed` : null,
          folder: `Map/${floorId}/Doors`,
          floorId,
          initial,
          centerCm: toUePos((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, elev),
          leafCenterCm: toUePos((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, elev + clearH / 2),
          leafSizeCm: [toCm(width), 20, toCm(clearH)],
          yawDeg: toUeYaw(dx, dz),
          widthCm: toCm(width),
          clearHeightCm: toCm(clearH),
          tags: [`id:${door.id}`, 'type:door', `floor:${floorId}`],
        });
      }
    }

    const fallbackKindObjects = [];
    const objects = [];
    for (const obj of clean.objects || []) {
      if (!obj.points?.length) continue;
      const elev = elevationOf(obj.floorId);
      const floorH = floorMap.get(obj.floorId)?.height || 3;
      const kind = obj.kind || 'object';
      const states = Array.isArray(obj.states) && obj.states.length ? obj.states : [null];
      const activeId = obj.states?.length ? (obj.initialState ?? obj.states[0].id) : null;
      for (const st of states) {
        const pts = st?.points || obj.points;
        const baseH = st?.baseHeight ?? obj.baseHeight ?? 0;
        const rawH = st?.height ?? obj.height;
        const knownKind = Object.prototype.hasOwnProperty.call(OBJECT_HEIGHT, kind) || ['floor-finish', 'floor-inlay', 'roof', 'loot', 'interaction', 'combat-space', 'extract', 'other'].includes(kind);
        if (!Number.isFinite(rawH) && !knownKind && st === states[0]) fallbackKindObjects.push({ id: obj.id, kind });
        const heightM = ['floor-finish', 'floor-inlay'].includes(kind) ? .02
          : (Number.isFinite(rawH) && rawH > 0 ? (baseH === 0 ? Math.min(floorH, rawH) : rawH) : (baseH === 0 ? Math.min(floorH, defaultHeight(kind)) : defaultHeight(kind)));
        const present = st?.present !== false;
        const visible = st ? st.id === activeId : true;
        const solid = st?.solid ?? obj.solid ?? false;
        const walkable = Boolean(obj.walkable);
        const collision = present && visible && (Boolean(solid) || walkable) && !['floor-finish', 'floor-inlay', 'combat-space'].includes(kind);
        const box = boxOf(pts);
        const isRect = isAxisRect(pts);
        if (!isRect && st === states[0] && kind !== 'combat-space') nonRectRooms.push(`object:${obj.id}`);
        objects.push({
          id: obj.id,
          name: obj.name || obj.id,
          stateId: st?.id || null,
          actorName: st ? `${obj.id}__${st.id}` : obj.id,
          folder: `Map/${obj.floorId}/Objects`,
          floorId: obj.floorId,
          kind,
          present,
          visible,
          solid: Boolean(solid),
          walkable,
          collision,
          color: obj.color || '#a99a7e',
          isRect,
          polygonCm: pts.map(toUePlan),
          bottomZCm: toCm(elev + baseH),
          heightCm: toCm(heightM),
          boxCm: ueBox(box, elev + baseH, heightM),
          tags: [
            `id:${obj.id}`, 'type:object', `floor:${obj.floorId}`, `kind:${kind}`,
            ...(st ? [`state:${st.id}`] : []),
          ],
        });
      }
    }

    const water = (clean.water || []).filter(w => w.points?.length >= 3).map(w => {
      const elev = elevationOf(w.floorId);
      const box = boxOf(w.points);
      return {
        id: w.id,
        actorName: w.id,
        folder: `Map/${w.floorId}/Water`,
        floorId: w.floorId,
        isRect: isAxisRect(w.points),
        polygonCm: w.points.map(toUePlan),
        topZCm: toCm(elev - .05),
        boxCm: ueBox(box, elev - .05, 5),
        collision: false,
        tags: [`id:${w.id}`, 'type:water', `floor:${w.floorId}`],
      };
    });

    const enemies = (clean.enemies || []).filter(e => e.center?.length >= 2).map(e => {
      const elev = elevationOf(e.floorId);
      return {
        id: e.id,
        actorName: e.id,
        folder: `Map/${e.floorId}/Enemies`,
        floorId: e.floorId,
        enemyType: e.enemyType || e.tier || 'normal',
        tier: e.tier || 'normal',
        roomId: e.roomId || null,
        bottomCm: toUePos(e.center[0], e.center[1], elev),
        centerCm: toUePos(e.center[0], e.center[1], elev + .9),
        capsuleRadiusCm: 40,
        capsuleHeightCm: 180,
        collision: false,
        tags: [`id:${e.id}`, 'type:enemy', `floor:${e.floorId}`, `kind:${e.enemyType || e.tier || 'normal'}`],
      };
    });

    const routes = (clean.routes || []).filter(rt => rt.points?.length >= 2).map(rt => {
      const baseElev = elevationOf(rt.floorId);
      return {
        id: rt.id,
        actorName: rt.id,
        folder: 'Map/Routes',
        floorId: rt.floorId || null,
        kind: rt.kind || 'main',
        pointsCm: rt.points.map(p => toUePos(p[0], p[1], Number.isFinite(p[2]) ? p[2] : baseElev)),
        collision: false,
        tags: [`id:${rt.id}`, 'type:route', ...(rt.floorId ? [`floor:${rt.floorId}`] : [])],
      };
    });

    const posById = new Map();
    for (const r of rooms) posById.set(r.id, { floorId: r.floorId, pt: polyCenter(r.points), z: elevationOf(r.floorId) });
    for (const o of objects) if (o.visible && !posById.has(o.id)) posById.set(o.id, { floorId: o.floorId, pt: [o.boxCm.centerCm[1] / 100, o.boxCm.centerCm[0] / 100], z: o.bottomZCm / 100 });
    for (const d of doors) posById.set(d.id, { floorId: d.floorId, pt: [d.centerCm[1] / 100, d.centerCm[0] / 100], z: d.centerCm[2] / 100 });

    const links = (clean.links || []).map(lk => {
      const firstFrom = Array.isArray(lk.from) ? lk.from[0] : lk.from;
      const src = posById.get(firstFrom);
      return {
        id: lk.id,
        actorName: `link__${lk.id}`,
        folder: 'Map/Links',
        centerCm: src ? toUePos(src.pt[0], src.pt[1], src.z) : [0, 0, 0],
        from: lk.from || [],
        to: lk.to || [],
        require: lk.require || null,
        trigger: lk.trigger || null,
        tags: [
          `id:${lk.id}`, 'type:link',
          ...(src?.floorId ? [`floor:${src.floorId}`] : []),
          ...(lk.trigger ? [`trigger:${lk.trigger}`] : []),
        ],
      };
    });

    const b = clean.meta?.bounds || (() => {
      const pts = rooms.flatMap(r => r.points);
      return pts.length ? boxOf(pts) : { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
    })();
    const minElev = floors.length ? Math.min(...floors.map(f => f.elevation || 0)) : 0;
    const maxElev = floors.length ? Math.max(...floors.map(f => (f.elevation || 0) + (f.height || 3))) : 3;

    return {
      ueSpecVersion: 'AI_GUIDE_12_v1',
      schemaVersion: clean.schemaVersion || 1,
      title: clean.meta?.title || 'untitled-map',
      coordinateSystem: {
        units: 'cm',
        forwardAxis: '+X (North = plan +z * 100)',
        rightAxis: '+Y (East = plan +x * 100)',
        upAxis: '+Z (Elevation = y * 100)',
        yawConvention: 'North=0deg, East=90deg',
      },
      player: {
        radiusCm: toCm(clean.meta?.player?.radius ?? .4),
        heightCm: toCm(clean.meta?.player?.height ?? 1.8),
        walkSpeedCmS: toCm(clean.meta?.player?.walkSpeed ?? 4),
        interactionRangeCm: toCm(clean.meta?.player?.interactionRange ?? 2),
      },
      boundsCm: {
        minX: toCm(b.minZ), maxX: toCm(b.maxZ),
        minY: toCm(b.minX), maxY: toCm(b.maxX),
        minZ: toCm(minElev - .2), maxZ: toCm(maxElev),
        toleranceCm: 20,
      },
      expectedCounts: {
        rooms: floorSlabs.length,
        walls: walls.length,
        lintels: lintels.length,
        doors: doors.length,
        closedDoorLeaves: doors.filter(d => d.closedLeafActorName).length,
        objects: objects.length,
        stairs: stairs.length,
        stairSteps: stairs.reduce((s, st) => s + st.steps.length, 0),
        water: water.length,
        enemies: enemies.length,
        routes: routes.length,
        links: links.length,
      },
      preflight: {
        missingStairBottom,
        nonRectShapes: nonRectRooms,
        fallbackKindObjects,
        hasExplicitBounds: Boolean(clean.meta?.bounds),
      },
      floors,
      rooms: floorSlabs,
      stairHoles,
      walls,
      lintels,
      doors,
      objects,
      stairs,
      water,
      enemies,
      routes,
      links,
    };
  }

  function polySignedArea(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s * .5;
  }

  function pointInsideOrVertexInside(obj, roomPts) {
    if (!obj?.points?.length || !roomPts?.length) return false;
    return pointInPolygon(polyCenter(obj.points), roomPts) || obj.points.some(p => pointInPolygon(p, roomPts));
  }

  function analyzeRoutePacing(clean, floors) {
    const routes = clean.routes || [];
    const mainRoute = routes.find(rt => rt.kind === 'main') || routes[0];
    const exitRoute = routes.find(rt => rt.kind === 'exit');
    if (!mainRoute?.points?.length || mainRoute.points.length < 2) {
      return { mainLengthM: 0, peakPosition: null, warmupRatio: null, prePeakRestM: 0, hasPrePeakRest: true };
    }
    const floorElev = new Map((floors || []).map(f => [f.id, Number.isFinite(f.elevation) ? f.elevation : 0]));
    const elevOf = fid => floorElev.get(fid) ?? 0;
    const to3d = (pts, fallbackFloorId) => pts.map(p => [p[0], p[1], Number.isFinite(p[2]) ? p[2] : elevOf(fallbackFloorId)]);
    let pts3 = to3d(mainRoute.points, mainRoute.floorId);
    if (exitRoute?.points?.length >= 2) {
      const mEnd = pts3[pts3.length - 1], eStart = exitRoute.points[0];
      if (Math.hypot(mEnd[0] - eStart[0], mEnd[1] - eStart[1]) <= 4.5) {
        pts3 = pts3.concat(to3d(exitRoute.points.slice(1), exitRoute.floorId));
      }
    }
    const samples = [[0, pts3[0][0], pts3[0][1], pts3[0][2]]];
    let L = 0;
    for (let i = 0; i < pts3.length - 1; i++) {
      const a = pts3[i], b = pts3[i + 1];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] - a[2]) * 1.2);
      const count = Math.max(1, Math.ceil(seg));
      for (let k = 1; k <= count; k++) {
        const t = k / count;
        samples.push([L + seg * t, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      }
      L += seg;
    }
    const mainEnemies = (clean.enemies || []).filter(e => e.branch !== 'optional' && Array.isArray(e.center));
    if (mainEnemies.length < 2 || L < 8) {
      return { mainLengthM: round2(L), peakPosition: null, warmupRatio: null, prePeakRestM: 0, hasPrePeakRest: true };
    }
    const scored = samples.map(([s, x, z, y]) => {
      let p = 0;
      for (const e of mainEnemies) {
        const w = e.tier === 'boss' ? 6 : (e.tier === 'elite' ? 3 : 1);
        const ey = elevOf(e.floorId);
        const d = Math.hypot(x - e.center[0], z - e.center[1], (y - ey) * 1.5);
        p += w * Math.exp(-d / 5.5);
      }
      return { s, p };
    });
    let best = 0;
    for (let i = 1; i < scored.length; i++) if (scored[i].p > scored[best].p) best = i;
    const peak = scored[best];
    if (!(peak.p > 0)) {
      return { mainLengthM: round2(L), peakPosition: null, warmupRatio: null, prePeakRestM: 0, hasPrePeakRest: true };
    }
    const earlyMax = scored.filter(pt => pt.s <= L * .35).reduce((m, pt) => Math.max(m, pt.p), 0);
    const restThresh = peak.p * .22;
    let maxRest = 0, runStart = null;
    for (const pt of scored) {
      if (pt.s > peak.s) break;
      if (pt.p < restThresh) {
        if (runStart === null) runStart = pt.s;
        maxRest = Math.max(maxRest, pt.s - runStart);
      } else {
        runStart = null;
      }
    }
    return {
      mainLengthM: round2(L),
      peakPosition: round2(peak.s / L),
      warmupRatio: round2(earlyMax / peak.p),
      prePeakRestM: round2(maxRest),
      hasPrePeakRest: L < 25 || maxRest >= 4,
    };
  }

  function analyzeCourtyardsAndOverlooks(rooms, floors, clean, pointInPolyFn) {
    const floorElev = new Map((floors || []).map(f => [f.id, Number.isFinite(f.elevation) ? f.elevation : 0]));
    const elevOf = fid => floorElev.get(fid) ?? 0;
    const minElev = floors?.length ? Math.min(...floors.map(f => Number.isFinite(f.elevation) ? f.elevation : 0)) : 0;

    const coveredCourtyards = [];
    let maxCourtyardCoverRatio = 0;
    const courtyards = rooms.filter(r => ['courtyard', 'atrium'].includes(r.kind) || (r.wallHeight === 0 && /中庭|庭院|courtyard|atrium/i.test(r.name || '')));
    for (const cr of courtyards) {
      const box = boxOf(cr.points), crElev = elevOf(cr.floorId);
      const upperRooms = rooms.filter(other => elevOf(other.floorId) > crElev + .5 && !['bridge', 'platform'].includes(other.kind));
      const w = Math.max(1, box.maxX - box.minX), h = Math.max(1, box.maxZ - box.minZ);
      const step = Math.max(.6, Math.min(w, h) / 12);
      let insideCount = 0, coveredCount = 0;
      for (let x = box.minX + step * .5; x < box.maxX; x += step) {
        for (let z = box.minZ + step * .5; z < box.maxZ; z += step) {
          if (!pointInPolyFn([x, z], cr.points)) continue;
          insideCount += 1;
          if (upperRooms.some(u => pointInPolyFn([x, z], u.points))) coveredCount += 1;
        }
      }
      const ratio = insideCount ? round2(coveredCount / insideCount) : 0;
      maxCourtyardCoverRatio = Math.max(maxCourtyardCoverRatio, ratio);
      if (ratio > .65) coveredCourtyards.push({ id: cr.id, coveredRatio: ratio });
    }

    const badOverlookRooms = [];
    let validOverlookCount = 0;
    const hasOpenVoidBelowOrAround = (r, pIn, pOut) => {
      const rElev = elevOf(r.floorId);
      const sameFloorOther = rooms.find(other => other.id !== r.id && other.floorId === r.floorId && pointInPolyFn(pOut, other.points));
      if (sameFloorOther) {
        // Valid if stepping out enters a same-floor open/courtyard/void or shared open edge.
        if (sameFloorOther.wallHeight === 0 || (Array.isArray(sameFloorOther.openEdges) && sameFloorOther.openEdges.length > 0)) return true;
        return false;
      }
      const lowerRooms = rooms.filter(low => elevOf(low.floorId) < rElev - .5);
      for (const low of lowerRooms) {
        if (!pointInPolyFn(pOut, low.points)) continue;
        // Overlook is physically unobstructed if either the same lower hall spans beneath both balcony & drop zone,
        // or the lower space is explicitly an open-air courtyard/atrium/pit (wallHeight 0 or extra-tall pit).
        if (pointInPolyFn(pIn, low.points)) return true;
        if (low.wallHeight === 0 || ['courtyard', 'atrium', 'pit'].includes(low.kind)) return true;
      }
      return false;
    };

    for (const r of rooms) {
      if (!Array.isArray(r.openEdges) || !r.openEdges.length) continue;
      if (elevOf(r.floorId) <= minElev + .5) continue;
      const windSign = polySignedArea(r.points) >= 0 ? 1 : -1;
      let validHere = 0;
      for (const idx of r.openEdges) {
        if (idx < 0 || idx >= r.points.length) continue;
        const a = r.points[idx], b = r.points[(idx + 1) % r.points.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        if (len < .2) continue;
        let outX = (windSign * dz) / len, outZ = (-windSign * dx) / len;
        const mid = [(a[0] + b[0]) * .5, (a[1] + b[1]) * .5];
        if (pointInPolyFn([mid[0] + outX * .4, mid[1] + outZ * .4], r.points)) {
          outX = -outX; outZ = -outZ;
        }
        const pOut = [mid[0] + outX * 1.5, mid[1] + outZ * 1.5];
        const pIn = [mid[0] - outX * 1.0, mid[1] - outZ * 1.0];
        if (hasOpenVoidBelowOrAround(r, pIn, pOut)) validHere += 1;
      }
      validOverlookCount += validHere;
      if (validHere === 0) badOverlookRooms.push(r.id);
    }

    return { coveredCourtyards, maxCourtyardCoverRatio, badOverlookRooms, validOverlookCount };
  }

  /* Benchmark & telemetry metrics computed deterministically on AI_MAP_SPEC v1 data. */
  function evaluateMapMetrics(data, opts = {}) {
    const clean = data || {};
    const rooms = (clean.rooms || []).filter(r => Array.isArray(r.points) && r.points.length >= 3);
    const roomById = new Map(rooms.map(r => [r.id, r]));
    const boxes = new Map(rooms.map(r => [r.id, boxOf(r.points)]));
    const polyAreaAbs = pts => {
      let s = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        s += a[0] * b[1] - b[0] * a[1];
      }
      return Math.abs(s) * .5;
    };
    const roomContaining = (floorId, pt) => rooms.find(r => (!floorId || r.floorId === floorId) && pointInPolygon(pt, r.points))?.id || null;
    const polyNearPoly = (ptsA, ptsB, margin = .8) => {
      if (!ptsA?.length || !ptsB?.length) return false;
      const A = boxOf(ptsA), B = boxOf(ptsB);
      if (Math.min(A.maxX, B.maxX) < Math.max(A.minX, B.minX) - margin || Math.min(A.maxZ, B.maxZ) < Math.max(A.minZ, B.minZ) - margin) return false;
      for (const p of ptsA) if (pointInPolygon(p, ptsB)) return true;
      for (const p of ptsB) if (pointInPolygon(p, ptsA)) return true;
      for (let i = 0; i < ptsA.length; i++) {
        if (segmentPolygonDist(ptsA[i], ptsA[(i + 1) % ptsA.length], ptsB) <= margin) return true;
      }
      return false;
    };

    // Build room connectivity graph (V rooms, E deduplicated edges with optional lock metadata).
    const adj = new Map(rooms.map(r => [r.id, []]));
    const edgeMeta = new Map();
    const addEdge = (idA, idB, meta = {}) => {
      if (!idA || !idB || idA === idB) return;
      const key = idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
      if (!edgeMeta.has(key)) {
        const rec = { a: idA < idB ? idA : idB, b: idA < idB ? idB : idA, locks: [] };
        edgeMeta.set(key, rec);
        adj.get(idA).push({ to: idB, key });
        adj.get(idB).push({ to: idA, key });
      }
      if (meta.doorId || meta.objId) edgeMeta.get(key).locks.push(meta);
    };

    // Identify blocking / appearance-gated objects that can toggle passability.
    const gateObjs = [];
    for (const obj of clean.objects || []) {
      if (!Array.isArray(obj.states) || !obj.states.length || !obj.points?.length) continue;
      const initId = obj.initialState ?? obj.states[0].id;
      const initSt = obj.states.find(s => s.id === initId) || obj.states[0];
      const initSolid = (initSt.solid ?? obj.solid) === true && initSt.present !== false;
      const initAbsent = initSt.present === false;
      const hasPassable = obj.states.some(s => (s.solid ?? obj.solid) === false || s.present === false);
      const hasPresent = obj.states.some(s => s.present !== false);
      if (initSolid && hasPassable) gateObjs.push({ id: obj.id, floorId: obj.floorId, points: obj.points, kind: 'blocker' });
      else if (initAbsent && hasPresent) {
        const presentPts = obj.states.find(s => s.present !== false && s.points?.length)?.points || obj.points;
        gateObjs.push({ id: obj.id, floorId: obj.floorId, points: presentPts, kind: 'bridge' });
      }
    }

    const doorRooms = new Map();
    for (const door of clean.doors || []) {
      if (!Array.isArray(door.points) || door.points.length !== 2) continue;
      const mid = [(door.points[0][0] + door.points[1][0]) / 2, (door.points[0][1] + door.points[1][1]) / 2];
      const matched = [];
      for (const r of rooms) {
        if (r.floorId !== door.floorId) continue;
        const hit = r.points.some((p, i) => segmentDistance(mid, p, r.points[(i + 1) % r.points.length]) <= .45);
        if (hit) matched.push(r.id);
      }
      doorRooms.set(door.id, matched);
      const blocker = gateObjs.find(g => g.kind === 'blocker' && g.floorId === door.floorId && segmentPolygonDist(door.points[0], door.points[1], g.points) <= .8);
      const lockInfo = {};
      if (door.initial === 'closed') lockInfo.doorId = door.id;
      if (blocker) lockInfo.objId = blocker.id;
      for (let i = 0; i < matched.length; i++) {
        for (let j = i + 1; j < matched.length; j++) addEdge(matched[i], matched[j], lockInfo);
      }
    }

    // Open shared room edges / open wallHeight:0 rooms connect directly on the same floor.
    const edgeOnOpenSide = (room, otherPts) => {
      const openSet = new Set(Array.isArray(room.openEdges) ? room.openEdges : []);
      if (room.wallHeight === 0) return true;
      if (!openSet.size) return false;
      for (const idx of openSet) {
        if (idx < 0 || idx >= room.points.length) continue;
        const p = room.points[idx], q = room.points[(idx + 1) % room.points.length];
        const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (otherPts.some((a, j) => segmentDistance(mid, a, otherPts[(j + 1) % otherPts.length]) <= .35)) return true;
      }
      return false;
    };
    let hasOpenCourtyardOrEdge = rooms.some(r => r.wallHeight === 0 || (Array.isArray(r.openEdges) && r.openEdges.length > 0));
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const r1 = rooms[i], r2 = rooms[j];
        if (r1.floorId !== r2.floorId) continue;
        if (!sharedRoomEdge(r1.points, r2.points, .25)) continue;
        if (edgeOnOpenSide(r1, r2.points) || edgeOnOpenSide(r2, r1.points)) {
          hasOpenCourtyardOrEdge = true;
          const blocker = gateObjs.find(g => g.floorId === r1.floorId && polyNearPoly(r1.points, g.points, .35) && polyNearPoly(r2.points, g.points, .35));
          addEdge(r1.id, r2.id, blocker ? { objId: blocker.id } : {});
        }
      }
    }

    // Cross-floor stairs connectivity.
    for (const stair of clean.stairs || []) {
      if (!stair.points?.length) continue;
      const fromRooms = rooms.filter(r => r.floorId === stair.fromFloorId && polyNearPoly(stair.points, r.points, .8)).map(r => r.id);
      const toRooms = rooms.filter(r => r.floorId === stair.toFloorId && polyNearPoly(stair.points, r.points, .8)).map(r => r.id);
      for (const a of fromRooms) for (const b of toRooms) addEdge(a, b, {});
    }

    // Connected components & cyclomatic loop count.
    const V = rooms.length;
    const E = edgeMeta.size;
    let C = 0;
    const compVisited = new Set();
    for (const r of rooms) {
      if (compVisited.has(r.id)) continue;
      C += 1;
      const q = [r.id];
      compVisited.add(r.id);
      while (q.length) {
        const cur = q.shift();
        for (const e of adj.get(cur) || []) {
          if (!compVisited.has(e.to)) { compVisited.add(e.to); q.push(e.to); }
        }
      }
    }
    const loopCount = Math.max(0, E - V + C);

    const routes = clean.routes || [];
    const mainRoute = routes.find(rt => rt.kind === 'main') || routes[0];
    const startRoomId = (mainRoute?.points?.length ? roomContaining(mainRoute.floorId, mainRoute.points[0]) : null) || rooms[0]?.id || null;
    const endRoomIds = new Set();
    for (const rt of routes) {
      if (!['main', 'exit'].includes(rt.kind) || !rt.points?.length) continue;
      const last = rt.points[rt.points.length - 1];
      const rid = roomContaining(null, last) || roomContaining(rt.floorId, last);
      if (rid) endRoomIds.add(rid);
    }

    // Unconstrained BFS reachability from startRoomId.
    const reachableFromStart = new Set();
    if (startRoomId && adj.has(startRoomId)) {
      const q = [startRoomId];
      reachableFromStart.add(startRoomId);
      while (q.length) {
        const cur = q.shift();
        for (const e of adj.get(cur) || []) {
          if (!reachableFromStart.has(e.to)) { reachableFromStart.add(e.to); q.push(e.to); }
        }
      }
    }
    const unreachableRooms = rooms.filter(r => !reachableFromStart.has(r.id)).map(r => r.id);
    const doorlessRooms = rooms.filter(r => !(adj.get(r.id)?.length)).map(r => r.id);

    const unrewardedDeadEnds = [];
    for (const r of rooms) {
      const deg = (adj.get(r.id) || []).length;
      if (deg > 1 || r.id === startRoomId || endRoomIds.has(r.id)) continue;
      const hasObj = (clean.objects || []).some(o => o.floorId === r.floorId && !['floor-finish', 'floor-inlay'].includes(o.kind) && o.points?.length && pointInPolygon(polyCenter(o.points), r.points));
      const hasRewardEnemy = (clean.enemies || []).some(e => (e.roomId === r.id || (e.floorId === r.floorId && e.center && pointInPolygon(e.center, r.points))) && (e.tier !== 'normal' || e.branch === 'optional'));
      if (!hasObj && !hasRewardEnemy) unrewardedDeadEnds.push(r.id);
    }
    const deadEndRatio = V ? round2(unrewardedDeadEnds.length / V) : 0;

    let verticalOverlapPairs = 0;
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        if (rooms[i].floorId === rooms[j].floorId) continue;
        const A = boxes.get(rooms[i].id), B = boxes.get(rooms[j].id);
        const ox = Math.max(0, Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX));
        const oz = Math.max(0, Math.min(A.maxZ, B.maxZ) - Math.max(A.minZ, B.minZ));
        if (ox * oz > 1) verticalOverlapPairs += 1;
      }
    }

    // Progression deadlock check across doors, stateful blockers, and links[].
    const entityHostRoom = id => {
      if (!id) return null;
      if (roomById.has(id)) return id;
      const enemy = (clean.enemies || []).find(e => e.id === id);
      if (enemy) return enemy.roomId || (enemy.center ? roomContaining(enemy.floorId, enemy.center) : null);
      const obj = (clean.objects || []).find(o => o.id === id);
      if (obj?.points?.length) return roomContaining(obj.floorId, polyCenter(obj.points));
      const dr = doorRooms.get(id);
      return dr?.length ? dr[0] : null;
    };
    const unlockedDoors = new Set();
    const unlockedObjs = new Set();
    const triggeredLinks = new Set();
    let reachedProg = new Set();
    for (let pass = 0; pass < 32; pass++) {
      reachedProg = new Set();
      if (startRoomId && adj.has(startRoomId)) {
        const q = [startRoomId];
        reachedProg.add(startRoomId);
        while (q.length) {
          const cur = q.shift();
          for (const e of adj.get(cur) || []) {
            if (reachedProg.has(e.to)) continue;
            const rec = edgeMeta.get(e.key);
            const blocked = rec.locks.some(lk => (lk.doorId && !unlockedDoors.has(lk.doorId)) || (lk.objId && !unlockedObjs.has(lk.objId)));
            if (!blocked) { reachedProg.add(e.to); q.push(e.to); }
          }
        }
      }
      let progressed = false;
      for (const lk of clean.links || []) {
        if (triggeredLinks.has(lk.id)) continue;
        const fromList = Array.isArray(lk.from) ? lk.from : [lk.from];
        const fromRooms = fromList.map(entityHostRoom);
        const ready = lk.require === 'all'
          ? fromRooms.length > 0 && fromRooms.every(rid => rid && reachedProg.has(rid))
          : fromRooms.some(rid => rid && reachedProg.has(rid));
        if (!ready) continue;
        triggeredLinks.add(lk.id);
        progressed = true;
        for (const t of Array.isArray(lk.to) ? lk.to : [lk.to]) {
          const tid = typeof t === 'object' ? t.id : t;
          const tstate = typeof t === 'object' ? t.state : 'open';
          if (doorRooms.has(tid) && tstate === 'open') unlockedDoors.add(tid);
          const gate = gateObjs.find(g => g.id === tid);
          if (gate) {
            const targetObj = (clean.objects || []).find(o => o.id === tid);
            const st = targetObj?.states?.find(s => s.id === tstate);
            if (!st || (st.solid ?? targetObj.solid) === false || st.present === false || (gate.kind === 'bridge' && st.present !== false)) {
              unlockedObjs.add(tid);
            }
          }
        }
      }
      if (!progressed) break;
    }
    const deadlockedLinks = (clean.links || []).filter(lk => !triggeredLinks.has(lk.id)).map(lk => lk.id);
    const lockedOffRooms = [...reachableFromStart].filter(rid => !reachedProg.has(rid));

    // Pacing, combat readability, & obstacle reachability.
    const densities = [];
    const emptyCombatRooms = [];
    const blockedRooms = [];
    let maxRoomUnreachableRatio = 0;
    let combatRooms = 0, coverTotal = 0;
    const nonCoverKinds = new Set(['floor-finish', 'floor-inlay', 'roof', 'combat-space', 'extract', 'spawn']);
    const staticSolidObjects = (clean.objects || []).filter(o => o.solid === true && !o.states?.length && !nonCoverKinds.has(o.kind) && o.points?.length >= 3);
    for (const r of rooms) {
      const area = Math.max(1, r.area || polyAreaAbs(r.points));
      const enemyCount = (clean.enemies || []).filter(e => e.roomId === r.id || (e.floorId === r.floorId && e.center && pointInPolygon(e.center, r.points))).length;
      densities.push(enemyCount / area * 100);
      const roomCovers = (clean.objects || []).filter(o => o.floorId === r.floorId && o.solid === true && !nonCoverKinds.has(o.kind) && pointInsideOrVertexInside(o, r.points));
      if (enemyCount > 0) {
        combatRooms += 1;
        coverTotal += roomCovers.length;
        if (area >= 36 && roomCovers.length === 0) emptyCombatRooms.push(r.id);
      }
      const roomStatics = staticSolidObjects.filter(o => o.floorId === r.floorId && pointInsideOrVertexInside(o, r.points));
      if (roomStatics.length >= 2) {
        const sources = [];
        for (const d of clean.doors || []) {
          if (d.floorId !== r.floorId || d.points?.length !== 2) continue;
          const mid = [(d.points[0][0] + d.points[1][0]) * .5, (d.points[0][1] + d.points[1][1]) * .5];
          if ((doorRooms.get(d.id) || []).includes(r.id) || r.points.some((p, i) => segmentDistance(mid, p, r.points[(i + 1) % r.points.length]) <= .55)) {
            sources.push({ point: mid });
          }
        }
        for (const st of clean.stairs || []) {
          if ((st.fromFloorId === r.floorId || st.toFloorId === r.floorId) && st.points?.length && polyNearPoly(st.points, r.points, .6)) {
            sources.push({ point: polyCenter(st.points) });
          }
        }
        for (const rt of routes) {
          for (const p of rt.points || []) {
            if (pointInPolygon(p, r.points)) sources.push({ point: [p[0], p[1]] });
          }
        }
        if (sources.length) {
          const rb = boxes.get(r.id);
          const df = distanceField({
            rooms: [r],
            doors: [],
            solids: roomStatics,
            sources,
            bounds: { minX: rb.minX - .5, maxX: rb.maxX + .5, minZ: rb.minZ - .5, maxZ: rb.maxZ + .5 },
            cell: .45,
          });
          if (df.walkable > 0) {
            const ratio = round2(df.unreachable / df.walkable);
            maxRoomUnreachableRatio = Math.max(maxRoomUnreachableRatio, ratio);
            if (ratio > .15) blockedRooms.push(r.id);
          }
        }
      }
    }
    const meanDen = densities.length ? densities.reduce((a, b) => a + b, 0) / densities.length : 0;
    const densityStdDev = densities.length ? round2(Math.sqrt(densities.reduce((s, d) => s + (d - meanDen) ** 2, 0) / densities.length)) : 0;
    const coverPerCombatRoom = combatRooms ? round2(coverTotal / combatRooms) : 0;
    let minDoorEnemyDistM = null;
    const campedDoorEnemies = [];
    for (const d of clean.doors || []) {
      if (d.points?.length !== 2) continue;
      const hostIds = doorRooms.get(d.id) || [];
      for (const e of clean.enemies || []) {
        if (e.floorId !== d.floorId || !Array.isArray(e.center)) continue;
        const dist = segmentDistance(e.center, d.points[0], d.points[1]);
        if (minDoorEnemyDistM === null || dist < minDoorEnemyDistM) minDoorEnemyDistM = round2(dist);
        const erId = e.roomId || roomContaining(e.floorId, e.center);
        const er = erId ? roomById.get(erId) : null;
        if (er && hostIds.includes(er.id) && Math.max(1, er.area || polyAreaAbs(er.points)) >= 20 && dist < 2.3) {
          campedDoorEnemies.push({ enemyId: e.id, doorId: d.id, roomId: er.id, distM: round2(dist) });
        }
      }
    }

    const rewardObjKinds = new Set(['loot', 'chest', 'artifact', 'interaction', 'altar', 'display', 'supply', 'fountain', 'extract', 'bench']);
    const unrewardedOptionalRoutes = [];
    const mainPts = (mainRoute?.points || []).map(p => [p[0], p[1]]);
    for (const rt of routes) {
      if (!['optional', 'secret'].includes(rt.kind) || !rt.points?.length) continue;
      const last = rt.points[rt.points.length - 1];
      const endPt = [last[0], last[1]];
      const endRoomId = roomContaining(null, endPt) || roomContaining(rt.floorId, endPt);
      const endRoom = endRoomId ? roomById.get(endRoomId) : null;
      const loopsBackToMain = loopCount >= 1 && mainPts.some(mp => Math.hypot(mp[0] - endPt[0], mp[1] - endPt[1]) <= 4.5);
      const nearRewardObj = (clean.objects || []).some(o =>
        (rewardObjKinds.has(o.kind) || (Array.isArray(o.states) && o.states.length >= 2)) &&
        o.points?.length &&
        (Math.hypot(polyCenter(o.points)[0] - endPt[0], polyCenter(o.points)[1] - endPt[1]) <= 4.5 ||
          (endRoom && o.floorId === endRoom.floorId && pointInsideOrVertexInside(o, endRoom.points)))
      );
      const nearRewardEnemy = (clean.enemies || []).some(e =>
        (e.branch === 'optional' || e.tier === 'elite' || e.tier === 'boss') &&
        Array.isArray(e.center) &&
        (Math.hypot(e.center[0] - endPt[0], e.center[1] - endPt[1]) <= 5.0 ||
          (endRoom && (e.roomId === endRoom.id || (e.floorId === endRoom.floorId && pointInPolygon(e.center, endRoom.points)))))
      );
      if (!loopsBackToMain && !nearRewardObj && !nearRewardEnemy) {
        unrewardedOptionalRoutes.push(rt.id);
      }
    }

    const routePacing = analyzeRoutePacing(clean, clean.floors || []);
    const spatial = analyzeCourtyardsAndOverlooks(rooms, clean.floors || [], clean, pointInPolygon);
    const ue = buildUeWhiteboxSpec(clean);
    const solidCoverCount = (clean.objects || []).filter(o => o.solid === true && !nonCoverKinds.has(o.kind)).length;
    const statefulObjectCount = (clean.objects || []).filter(o => Array.isArray(o.states) && o.states.length >= 2).length;
    const nonRectRoomIds = rooms.filter(r => !isAxisRect(r.points)).map(r => r.id);

    let patchFidelity = null;
    if (opts.baseData && ((Array.isArray(opts.preserveIds) && opts.preserveIds.length) || Array.isArray(opts.allowedEditIds))) {
      const indexOf = doc => {
        const m = new Map();
        for (const k of ['rooms', 'doors', 'objects', 'enemies', 'stairs', 'water', 'routes', 'links']) {
          for (const item of doc[k] || []) if (item?.id) m.set(item.id, item);
        }
        return m;
      };
      const baseIdx = indexOf(opts.baseData), curIdx = indexOf(clean);
      const missingIds = [], driftedIds = [];
      for (const pid of opts.preserveIds || []) {
        const a = baseIdx.get(pid), b = curIdx.get(pid);
        if (!b) { missingIds.push(pid); continue; }
        if (a && JSON.stringify(a.points || a.center) !== JSON.stringify(b.points || b.center)) driftedIds.push(pid);
      }
      const collateralIds = [];
      if (Array.isArray(opts.allowedEditIds)) {
        const allowed = new Set(opts.allowedEditIds);
        for (const [bid, baseItem] of baseIdx.entries()) {
          if (allowed.has(bid)) continue;
          const curItem = curIdx.get(bid);
          if (!curItem || JSON.stringify(baseItem) !== JSON.stringify(curItem)) collateralIds.push(bid);
        }
      }
      patchFidelity = { missingIds, driftedIds, collateralIds, intact: !missingIds.length && !driftedIds.length && !collateralIds.length };
    }

    return {
      counts: {
        floors: (clean.floors || []).length,
        rooms: V,
        nonRectRooms: nonRectRoomIds.length,
        doors: (clean.doors || []).length,
        stairs: (clean.stairs || []).length,
        objects: (clean.objects || []).length,
        statefulObjects: statefulObjectCount,
        solidCoverCount,
        enemies: (clean.enemies || []).length,
        routes: routes.length,
        routeKinds: [...new Set(routes.map(rt => rt.kind))],
        links: (clean.links || []).length,
      },
      topology: {
        nodes: V, edges: E, components: C, loopCount,
        nonRectRoomIds, nonRectRoomCount: nonRectRoomIds.length,
        startRoomId, endRoomIds: [...endRoomIds],
        unreachableRooms, doorlessRooms, unrewardedDeadEnds, deadEndRatio,
        verticalOverlapPairs, hasOpenCourtyardOrEdge,
      },
      spatial,
      navigation: { blockedRooms, maxRoomUnreachableRatio },
      progression: { deadlockedLinks, lockedOffRooms, noDeadlock: !deadlockedLinks.length && !lockedOffRooms.length },
      pacing: {
        densityStdDev, coverPerCombatRoom, minDoorEnemyDistM,
        emptyCombatRooms, doorSpawnCampCount: campedDoorEnemies.length, campedDoorEnemies,
        unrewardedOptionalRoutes, ...routePacing,
      },
      ue: { preflight: ue.preflight, expectedCounts: ue.expectedCounts },
      patchFidelity,
    };
  }

  function gradeBenchmarkCase(rawInput, caseSpec = {}, opts = {}) {
    const validator = opts.validator || root.WorkbenchValidate;
    const isPatch = Boolean(rawInput && (rawInput.patch || rawInput.upsertRooms || rawInput.upsertDoors || rawInput.upsertObjects) && opts.baseData);
    const expanded = isPatch
      ? applyAiPatch(opts.baseData, rawInput, { autoSnap: false }).data
      : expandRelativeLayout(rawInput);

    const preVal = validator ? validator.validate(expanded) : { errors: [], warnings: [] };
    const preSnapErrors = preVal.errors || [];
    const preSnapWarnings = preVal.warnings || [];

    let finalData = expanded, fixes = [];
    if (preSnapErrors.length === 0) {
      const snapped = snapAndClearGeometry(expanded);
      finalData = snapped.data;
      fixes = snapped.fixes;
    }
    const postVal = validator ? validator.validate(finalData) : { errors: [], warnings: [] };
    const postErrors = postVal.errors || [];
    const postWarnings = postVal.warnings || [];
    const totalSnapShiftM = round2(fixes.reduce((sum, fx) => sum + (Number.isFinite(fx.dist) ? fx.dist : Math.hypot(fx.dx || 0, fx.dz || 0)), 0));

    const checks = caseSpec.hardChecks || {};
    const metrics = evaluateMapMetrics(finalData, {
      baseData: opts.baseData,
      preserveIds: checks.preserveIds || [],
      allowedEditIds: checks.allowedEditIds || null,
    });
    const allIds = new Set();
    for (const k of ['floors', 'rooms', 'doors', 'objects', 'enemies', 'stairs', 'water', 'routes', 'links']) {
      for (const item of finalData[k] || []) if (item?.id) allIds.add(item.id);
    }

    const failedChecks = [];
    if (postErrors.length) failedChecks.push(`schema-errors:${postErrors.length}`);
    if (checks.requireZeroPreSnapErrors && preSnapErrors.length) failedChecks.push(`pre-snap-errors:${preSnapErrors.length}`);
    if (checks.requireZeroPostWarnings && postWarnings.length) failedChecks.push(`post-warnings:${postWarnings.map(w => w.code).join(',')}`);
    if (checks.maxPreSnapWarnings !== undefined && preSnapWarnings.length > checks.maxPreSnapWarnings) failedChecks.push(`pre-snap-warnings:${preSnapWarnings.length}>${checks.maxPreSnapWarnings}`);
    if (checks.maxSnapFixCount !== undefined && fixes.length > checks.maxSnapFixCount) failedChecks.push(`snap-fixes:${fixes.length}>${checks.maxSnapFixCount}`);
    if (checks.minFloors && metrics.counts.floors < checks.minFloors) failedChecks.push(`minFloors:${metrics.counts.floors}<${checks.minFloors}`);
    if (checks.minRooms && metrics.counts.rooms < checks.minRooms) failedChecks.push(`minRooms:${metrics.counts.rooms}<${checks.minRooms}`);
    if (checks.maxRooms && metrics.counts.rooms > checks.maxRooms) failedChecks.push(`maxRooms:${metrics.counts.rooms}>${checks.maxRooms}`);
    if (checks.minNonRectRooms && metrics.topology.nonRectRoomCount < checks.minNonRectRooms) failedChecks.push(`minNonRectRooms:${metrics.topology.nonRectRoomCount}<${checks.minNonRectRooms}`);
    if (checks.minObjects !== undefined && metrics.counts.objects < checks.minObjects) failedChecks.push(`minObjects:${metrics.counts.objects}<${checks.minObjects}`);
    if (checks.minStatefulObjects !== undefined && metrics.counts.statefulObjects < checks.minStatefulObjects) failedChecks.push(`minStatefulObjects:${metrics.counts.statefulObjects}<${checks.minStatefulObjects}`);
    if (checks.minEnemies !== undefined && metrics.counts.enemies < checks.minEnemies) failedChecks.push(`minEnemies:${metrics.counts.enemies}<${checks.minEnemies}`);
    if (checks.minLoopCount !== undefined && metrics.topology.loopCount < checks.minLoopCount) failedChecks.push(`minLoopCount:${metrics.topology.loopCount}<${checks.minLoopCount}`);
    if (checks.maxDeadEndRatio !== undefined && metrics.topology.deadEndRatio > checks.maxDeadEndRatio) failedChecks.push(`deadEndRatio:${metrics.topology.deadEndRatio}>${checks.maxDeadEndRatio}`);
    if (checks.zeroUnreachableRooms && metrics.topology.unreachableRooms.length) failedChecks.push(`unreachableRooms:${metrics.topology.unreachableRooms.join(',')}`);
    if (Array.isArray(checks.mustContainRouteKinds)) {
      for (const rk of checks.mustContainRouteKinds) {
        if (!metrics.counts.routeKinds.includes(rk)) failedChecks.push(`missingRouteKind:${rk}`);
      }
    }
    if (checks.minSolidCover && metrics.counts.solidCoverCount < checks.minSolidCover) failedChecks.push(`minSolidCover:${metrics.counts.solidCoverCount}<${checks.minSolidCover}`);
    if (checks.minStairs && metrics.counts.stairs < checks.minStairs) failedChecks.push(`minStairs:${metrics.counts.stairs}<${checks.minStairs}`);
    if (checks.requireStairBottom && metrics.ue.preflight.missingStairBottom.length) failedChecks.push(`missingStairBottom:${metrics.ue.preflight.missingStairBottom.join(',')}`);
    if (checks.minVerticalOverlapPairs && metrics.topology.verticalOverlapPairs < checks.minVerticalOverlapPairs) failedChecks.push(`verticalOverlap:${metrics.topology.verticalOverlapPairs}<${checks.minVerticalOverlapPairs}`);
    if (checks.requireOpenCourtyardOrEdge && !metrics.topology.hasOpenCourtyardOrEdge) failedChecks.push('missingOpenCourtyardOrEdge');
    if (checks.maxCourtyardCoverRatio !== undefined && metrics.spatial.maxCourtyardCoverRatio > checks.maxCourtyardCoverRatio) failedChecks.push(`courtyardCovered:${metrics.spatial.maxCourtyardCoverRatio}>${checks.maxCourtyardCoverRatio}`);
    if (checks.requireValidOverlook && (metrics.spatial.validOverlookCount < 1 || metrics.spatial.badOverlookRooms.length > 0)) failedChecks.push(`invalidOverlook:${metrics.spatial.badOverlookRooms.join(',') || 'none'}`);
    if (checks.minLinks && metrics.counts.links < checks.minLinks) failedChecks.push(`minLinks:${metrics.counts.links}<${checks.minLinks}`);
    if (checks.noDeadlock && !metrics.progression.noDeadlock) failedChecks.push(`deadlock:links=${metrics.progression.deadlockedLinks.join(',')};rooms=${metrics.progression.lockedOffRooms.join(',')}`);
    if (checks.minPeakPosition !== undefined && metrics.pacing.peakPosition !== null && metrics.pacing.peakPosition < checks.minPeakPosition) failedChecks.push(`peakPosition:${metrics.pacing.peakPosition}<${checks.minPeakPosition}`);
    if (checks.requirePrePeakRest && !metrics.pacing.hasPrePeakRest) failedChecks.push(`missingPrePeakRest:${metrics.pacing.prePeakRestM}m`);
    if (checks.minDoorEnemyDistM !== undefined && metrics.pacing.minDoorEnemyDistM !== null && metrics.pacing.minDoorEnemyDistM < checks.minDoorEnemyDistM) failedChecks.push(`doorEnemyTooClose:${metrics.pacing.minDoorEnemyDistM}<${checks.minDoorEnemyDistM}`);
    if (checks.maxEmptyCombatRooms !== undefined && metrics.pacing.emptyCombatRooms.length > checks.maxEmptyCombatRooms) failedChecks.push(`emptyCombatRooms:${metrics.pacing.emptyCombatRooms.join(',')}`);
    if (Array.isArray(checks.mustIncludeIds)) {
      for (const reqId of checks.mustIncludeIds) if (!allIds.has(reqId)) failedChecks.push(`missingId:${reqId}`);
    }
    if (metrics.patchFidelity && (metrics.patchFidelity.missingIds.length || metrics.patchFidelity.driftedIds.length)) {
      failedChecks.push(`patchDrift:missing=${metrics.patchFidelity.missingIds.join(',')};drifted=${metrics.patchFidelity.driftedIds.join(',')}`);
    }
    if (checks.zeroCollateralEdits && metrics.patchFidelity?.collateralIds?.length) {
      failedChecks.push(`collateralEdits:${metrics.patchFidelity.collateralIds.join(',')}`);
    }

    // Continuous design quality evaluation (deducts points even when hard gates pass).
    const qualityDeductions = [];
    const addQual = (code, points, detail) => { if (points > 0) qualityDeductions.push({ code, points, detail }); };
    if (metrics.topology.unrewardedDeadEnds.length) {
      addQual('unrewarded-dead-end', Math.min(12, metrics.topology.unrewardedDeadEnds.length * 4), metrics.topology.unrewardedDeadEnds.join(','));
    }
    if (metrics.pacing.emptyCombatRooms.length) {
      addQual('empty-combat-arena', Math.min(12, metrics.pacing.emptyCombatRooms.length * 4), metrics.pacing.emptyCombatRooms.join(','));
    }
    if (metrics.pacing.doorSpawnCampCount) {
      addQual('door-spawn-camp', Math.min(12, metrics.pacing.doorSpawnCampCount * 5), metrics.pacing.campedDoorEnemies.map(c => `${c.enemyId}@${c.doorId}(${c.distM}m)`).join(','));
    }
    if (metrics.spatial.coveredCourtyards.length) {
      const pts = Math.min(12, metrics.spatial.coveredCourtyards.reduce((s, c) => s + (c.coveredRatio >= .85 ? 8 : 4), 0));
      addQual('covered-courtyard', pts, metrics.spatial.coveredCourtyards.map(c => `${c.id}(${Math.round(c.coveredRatio * 100)}%)`).join(','));
    }
    if (metrics.spatial.badOverlookRooms.length) {
      addQual('bad-overlook-edge', Math.min(10, metrics.spatial.badOverlookRooms.length * 8), metrics.spatial.badOverlookRooms.join(','));
    }
    if (metrics.pacing.peakPosition !== null && metrics.pacing.peakPosition < .30 && metrics.pacing.mainLengthM >= 15) {
      addQual('inverted-pacing', 6, `peakPos=${metrics.pacing.peakPosition}`);
    }
    if (metrics.pacing.peakPosition !== null && !metrics.pacing.hasPrePeakRest && metrics.pacing.mainLengthM >= 25) {
      addQual('no-pre-peak-rest', 4, `rest=${metrics.pacing.prePeakRestM}m`);
    }
    if (metrics.pacing.unrewardedOptionalRoutes.length) {
      addQual('unrewarded-optional-route', Math.min(8, metrics.pacing.unrewardedOptionalRoutes.length * 4), metrics.pacing.unrewardedOptionalRoutes.join(','));
    }
    if (metrics.navigation.blockedRooms.length) {
      addQual('blocked-room-pocket', Math.min(10, metrics.navigation.blockedRooms.length * 5), metrics.navigation.blockedRooms.join(','));
    }
    if (metrics.ue.preflight.fallbackKindObjects.length) {
      addQual('ue-fallback-kind', Math.min(6, metrics.ue.preflight.fallbackKindObjects.length * 2), metrics.ue.preflight.fallbackKindObjects.map(o => `${o.id}:${o.kind}`).join(','));
    }

    const qualityPenalty = qualityDeductions.reduce((s, d) => s + d.points, 0);
    const qualityScore = postErrors.length ? 0 : Math.max(0, 100 - qualityPenalty);
    const totalGates = Math.max(1, Object.keys(checks).length + 1);
    const hardPenalty = failedChecks.length * Math.round(80 / Math.max(4, totalGates)) + Math.min(18, fixes.length * 4);
    const score = postErrors.length ? 0 : Math.max(0, Math.min(100, 100 - hardPenalty - qualityPenalty));

    return {
      caseId: caseSpec.id || null,
      passed: failedChecks.length === 0,
      score,
      qualityScore,
      qualityDeductions,
      preSnapErrors: preSnapErrors.length,
      preSnapWarnings: preSnapWarnings.map(w => w.code),
      snapFixCount: fixes.length,
      totalSnapShiftM,
      postErrors: postErrors.length,
      postWarnings: postWarnings.map(w => w.code),
      failedChecks,
      metrics,
    };
  }


  const api = {
    pointInPolygon, segmentDistance, boxOf, wallRuns, doorCuts, wallSpans, stairSide, distanceField, sampleField, minInPolygon,
    OBJECT_HEIGHT, resolveObject, proximityGraph,
    expandRelativeLayout, snapAndClearGeometry, applyAiPatch, buildAiEditContext, buildUeWhiteboxSpec,
    evaluateMapMetrics, gradeBenchmarkCase,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkbenchGeometry = api;
})(typeof window !== 'undefined' ? window : globalThis);
