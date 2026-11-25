/* AI_MAP_SPEC v1 structural validator — the browser twin of tools/validate_ai_map.py.
   Both emit the same issue codes; tools/check_validator_parity.cjs keeps them in step.
   Works as a browser global (window.WorkbenchValidate) and as a Node module. */
(root => {
  'use strict';

  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
  const STATUSES = ['existing', 'planned', 'adjusted', 'preview', 'annotation'];
  const TIERS = ['normal', 'elite', 'boss'];
  const BRANCHES = ['main', 'optional'];
  const ROUTE_KINDS = ['main', 'optional', 'exit', 'secret'];
  const NOTE_STATUSES = ['open', 'confirmed', 'resolved'];
  const SIDES = ['N', 'S', 'E', 'W'];
  const PLAYER_KEYS = ['radius', 'height', 'walkSpeed', 'rollDistance', 'rollDuration', 'interactionRange'];
  const DOOR_EDGE_TOLERANCE = 0.08;

  const isNum = value => typeof value === 'number' && Number.isFinite(value);
  const isPoint = (value, allowY = false) => Array.isArray(value) &&
    (value.length === 2 || (allowY && value.length === 3)) && value.every(isNum);

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

  function segmentsCross(a, b, c, d) {
    const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
  }

  // Distance from segment a-b to a polygon (0 when touching or inside).
  function segmentPolygonDistance(a, b, polygon) {
    if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) return 0;
    let best = Infinity;
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length];
      if (segmentsCross(a, b, p, q)) return 0;
      best = Math.min(best, segmentDistance(a, p, q), segmentDistance(b, p, q), segmentDistance(p, a, b));
    }
    return best;
  }

  // Point on segment a-b nearest to the polygon's vertices, rounded to centimetres.
  function closestRoutePoint(a, b, polygon) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const length = dx * dx + dz * dz;
    let best = null, bestD = Infinity;
    for (const v of polygon) {
      const t = length ? Math.max(0, Math.min(1, ((v[0] - a[0]) * dx + (v[1] - a[1]) * dz) / length)) : 0;
      const q = [a[0] + t * dx, a[1] + t * dz];
      const d = Math.hypot(q[0] - v[0], q[1] - v[1]);
      if (d < bestD) { best = q; bestD = d; }
    }
    return best.map(value => Math.round(value * 100) / 100);
  }

  function polygonArea(points) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i], q = points[(i + 1) % points.length];
      sum += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(sum / 2);
  }

  const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
  const isStrList = value => Array.isArray(value) && value.every(v => typeof v === 'string');

  // First problem in an object's states list, or null when it is well formed.
  function statesProblem(states) {
    if (!Array.isArray(states)) return 'states 必须是数组';
    if (states.length < 2) return 'states 至少 2 项';
    const seen = new Set();
    for (const state of states) {
      if (!isObject(state)) return 'states 的每一项必须是对象';
      const sid = state.id;
      if (typeof sid !== 'string' || !ID_RE.test(sid)) return `状态 id 非法: ${sid}`;
      if (seen.has(sid)) return `状态 id 重复: ${sid}`;
      seen.add(sid);
      for (const key of ['solid', 'present']) {
        if (state[key] !== undefined && typeof state[key] !== 'boolean') return `状态 ${sid}: ${key} 必须是布尔值`;
      }
      if (state.baseHeight !== undefined && (!isNum(state.baseHeight) || state.baseHeight < 0)) return `状态 ${sid}: baseHeight 必须是 ≥0 的数字`;
      if (state.height !== undefined && (!isNum(state.height) || state.height <= 0)) return `状态 ${sid}: height 必须大于 0`;
    }
    return null;
  }

  const stateIds = object => Array.isArray(object.states)
    ? object.states.filter(s => isObject(s) && typeof s.id === 'string').map(s => s.id)
    : [];

  // First problem in a meta.proximity rule, or null when it is well formed.
  function proximityProblem(rule) {
    if (!isObject(rule)) return '规则必须是对象';
    if (typeof rule.name !== 'string' || !rule.name) return 'name 必须是非空字符串';
    if (!isNum(rule.radius) || rule.radius <= 0) return 'radius 必须大于 0';
    for (const key of ['kinds', 'enemyTypes']) {
      if (rule[key] !== undefined && !isStrList(rule[key])) return `${key} 必须是字符串数组`;
    }
    if (!(rule.kinds || []).length && !(rule.enemyTypes || []).length) return 'kinds 与 enemyTypes 至少一个非空';
    if (rule.lineOfSight !== undefined && typeof rule.lineOfSight !== 'boolean') return 'lineOfSight 必须是布尔值';
    return null;
  }

  const COLLECTIONS = ['floors', 'rooms', 'objects', 'enemies', 'doors', 'routes', 'stairs', 'water', 'links', 'reviewNotes'];
  const POINTED = ['rooms', 'objects', 'doors', 'routes', 'stairs', 'water'];
  const META_OBJECTS = ['bounds', 'provenance', 'player', 'legendLabels'];
  const present = value => value !== null && value !== undefined;
  const isText = value => typeof value === 'string' && value !== '';
  const validPolygon = points => Array.isArray(points) && points.length >= 3 && points.every(p => isPoint(p));

  // Copy of data where every container has the type the checks expect. Each mismatch is
  // reported once as shape-invalid (id = where it is, e.g. rooms[2].points) and treated as absent.
  function normalizeShape(data, error) {
    data = { ...data };
    let meta = data.meta;
    if (present(meta) && !isObject(meta)) {
      error('shape-invalid', 'meta', 'meta 必须是对象');
      meta = null;
    }
    meta = { ...(meta || {}) };
    for (const key of META_OBJECTS) {
      if (present(meta[key]) && !isObject(meta[key])) {
        error('shape-invalid', `meta.${key}`, `meta.${key} 必须是对象`);
        delete meta[key];
      }
    }
    data.meta = meta;
    for (const key of COLLECTIONS) {
      const value = data[key];
      if (!present(value)) continue;
      if (!Array.isArray(value)) {
        error('shape-invalid', key, `${key} 必须是数组`);
        data[key] = [];
        continue;
      }
      const items = [];
      value.forEach((item, index) => {
        if (!isObject(item)) {
          error('shape-invalid', `${key}[${index}]`, `${key}[${index}] 必须是对象`);
          return;
        }
        if (POINTED.includes(key) && present(item.points) && !Array.isArray(item.points)) {
          error('shape-invalid', `${key}[${index}].points`, `${key}[${index}].points 必须是数组`);
          const { points, ...rest } = item;
          item = rest;
        }
        items.push(item);
      });
      data[key] = items;
    }
    return data;
  }

  function validate(data) {
    const errors = [];
    const warnings = [];
    const error = (code, id, msg) => errors.push({ code, id: id ?? null, msg });
    // `at` (optional): plan point the problem is closest to, for drawing it where it happens.
    const warn = (code, id, msg, at) => warnings.push(at ? { code, id: id ?? null, msg, at } : { code, id: id ?? null, msg });
    if (!isObject(data)) {
      error('shape-invalid', '$', '地图必须是一个 JSON 对象');
      data = {};
    }
    data = normalizeShape(data, error);

    if (data.schemaVersion !== 1) error('schema-version', null, 'schemaVersion 必须是 1');
    const meta = data.meta || {};
    let bounds = meta.bounds || {};
    if (meta.units !== 'm') error('meta-units', null, 'meta.units 必须是 "m"');
    if (!['minX', 'minZ', 'maxX', 'maxZ'].every(key => isNum(bounds[key]))) {
      error('meta-bounds', null, 'meta.bounds 需要数字 minX/minZ/maxX/maxZ');
      bounds = { minX: -Infinity, minZ: -Infinity, maxX: Infinity, maxZ: Infinity };
    } else if (bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) {
      error('meta-bounds-order', null, 'meta.bounds 的 min 必须小于 max');
    }
    const inBounds = p => bounds.minX <= p[0] && p[0] <= bounds.maxX && bounds.minZ <= p[1] && p[1] <= bounds.maxZ;
    const provenance = meta.provenance || {};
    if (!['design', 'scene-snapshot'].includes(provenance.kind)) error('provenance-kind', null, 'meta.provenance.kind 必须是 design 或 scene-snapshot');
    if (!isText(provenance.label) || !isText(provenance.source)) error('provenance-fields', null, 'meta.provenance 需要 label 和 source');
    if (provenance.kind === 'design' && !isText(provenance.generatedAt)) error('provenance-date', null, 'design 来源需要 generatedAt');
    if (provenance.kind === 'scene-snapshot' && !isText(provenance.snapshotDate)) error('provenance-date', null, 'scene-snapshot 来源需要 snapshotDate');
    const player = meta.player || {};
    for (const key of PLAYER_KEYS) {
      if (!isNum(player[key]) || player[key] < 0) error('player-field', key, `meta.player.${key} 必须是非负数`);
    }
    for (const [key, value] of Object.entries(meta.legendLabels || {})) {
      if (typeof value !== 'string' || !value) error('legend-label', key, `meta.legendLabels.${key} 必须是非空字符串`);
    }
    if (meta.kindLegend !== undefined) {
      if (!isObject(meta.kindLegend)) error('kind-legend-label', null, 'meta.kindLegend 必须是对象');
      else {
        for (const [key, value] of Object.entries(meta.kindLegend)) {
          if (!isObject(value) || typeof value.label !== 'string' || !value.label) error('kind-legend-label', key, `meta.kindLegend.${key} 需要非空字符串 label`);
        }
      }
    }

    const floorById = new Map();
    const levels = [];
    for (const floor of data.floors || []) {
      const fid = floor.id;
      // A non-string id is reported as is and never becomes a known floor.
      if (typeof fid !== 'string' || !fid || !ID_RE.test(fid)) error('floor-id', fid, `楼层 id 非法: ${fid}`);
      else if (floorById.has(fid)) error('floor-dup', fid, `楼层 id 重复: ${fid}`);
      if (typeof fid === 'string') floorById.set(fid, floor);
      if (!isNum(floor.elevation)) error('floor-elevation', fid, `楼层 ${fid}: elevation 必须是数字`);
      else levels.push(floor.elevation);
      if (!isNum(floor.height) || floor.height <= 0) error('floor-height', fid, `楼层 ${fid}: height 必须大于 0`);
    }
    if (levels.some((level, index) => index && level < levels[index - 1])) warn('floors-order', null, '楼层没有按 elevation 从低到高排列');

    const ids = new Set(floorById.keys());
    const register = (entity, type) => {
      const id = entity.id;
      if (typeof id !== 'string') {
        // A non-string id is reported as is and never joins the id set.
        error('id-invalid', id, `${type} id 非法: ${id}`);
        return id;
      }
      if (!id || !ID_RE.test(id)) error('id-invalid', id, `${type} id 非法: ${id}`);
      else if (ids.has(id)) error('id-dup', id, `ID 重复: ${id}`);
      ids.add(id);
      return id;
    };
    const checkPoints = (points, id, type, allowY = false) => {
      for (const point of points) {
        if (!isPoint(point, allowY)) error('point-invalid', id, `${type} ${id}: 点格式错误 ${JSON.stringify(point)}`);
        else if (!inBounds(point)) error('point-out-of-bounds', id, `${type} ${id}: 点超出 bounds ${JSON.stringify(point)}`);
      }
    };
    const checkFloor = (entity, id, type) => {
      if (!floorById.has(entity.floorId)) error('floor-unknown', id, `${type} ${id}: 未知楼层 ${entity.floorId}`);
    };

    const rooms = data.rooms || [];
    const roomById = new Map();
    if (!rooms.length) error('rooms-empty', null, '至少需要一个房间');
    for (const room of rooms) {
      const rid = register(room, '房间');
      if (typeof rid === 'string') roomById.set(rid, room);
      checkFloor(room, rid, '房间');
      if (!STATUSES.includes(room.status)) error('room-status', rid, `房间 ${rid}: status 非法`);
      if (room.wallHeight !== undefined && (!isNum(room.wallHeight) || room.wallHeight < 0)) error('room-wall-height', rid, `房间 ${rid}: wallHeight 必须是 ≥0 的数字`);
      const points = room.points || [];
      if (room.openEdges !== undefined) {
        const edges = room.openEdges;
        if (!Array.isArray(edges) || edges.some(e => !Number.isInteger(e) || e < 0 || e >= points.length) || new Set(edges).size !== edges.length) {
          error('room-open-edges', rid, `房间 ${rid}: openEdges 必须是不重复的边序号（0 到 ${points.length - 1}）`);
        }
      }
      if (points.length < 3) error('room-points', rid, `房间 ${rid}: 至少 3 个点`);
      else if (points.every(p => isPoint(p)) && polygonArea(points) < 0.5) warn('room-small', rid, `房间 ${rid}: 面积很小`);
      checkPoints(points, rid, '房间');
    }

    // Light AABB overlap warning; polygon-level overlap is intentionally not guessed.
    const box = points => ({
      x0: Math.min(...points.map(p => p[0])), z0: Math.min(...points.map(p => p[1])),
      x1: Math.max(...points.map(p => p[0])), z1: Math.max(...points.map(p => p[1])),
    });
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i], b = rooms[j];
        if (a.floorId !== b.floorId) continue;
        const ap = a.points || [], bp = b.points || [];
        if (ap.length < 3 || bp.length < 3 || !ap.every(p => isPoint(p)) || !bp.every(p => isPoint(p))) continue;
        const A = box(ap), B = box(bp);
        const overlap = Math.max(0, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0)) * Math.max(0, Math.min(A.z1, B.z1) - Math.max(A.z0, B.z0));
        if (overlap > 0.5) warn('room-overlap', a.id, `房间 ${a.id} 与 ${b.id} 外框重叠 ${overlap.toFixed(1)} m²`);
      }
    }

    const objects = data.objects || [];
    for (const object of objects) {
      const oid = register(object, '物件');
      checkFloor(object, oid, '物件');
      const points = object.points || [];
      if (points.length < 3) error('object-points', oid, `物件 ${oid}: 至少 3 个点`);
      checkPoints(points, oid, '物件');
      if (object.baseHeight !== undefined && (!isNum(object.baseHeight) || object.baseHeight < 0)) error('object-base-height', oid, `物件 ${oid}: baseHeight 必须是 ≥0 的数字`);
      if (object.states !== undefined) {
        const problem = statesProblem(object.states);
        if (problem) error('object-states', oid, `物件 ${oid}: ${problem}`);
        else {
          for (const state of object.states) {
            if (state.points === undefined) continue;
            const statePoints = state.points;
            if (!Array.isArray(statePoints) || statePoints.length < 3) error('object-points', oid, `物件 ${oid}: 状态 ${state.id} 至少 3 个点`);
            if (Array.isArray(statePoints)) checkPoints(statePoints, oid, '物件');
          }
        }
      }
      if (object.initialState !== undefined && !stateIds(object).includes(object.initialState)) error('object-initial-state', oid, `物件 ${oid}: initialState 不在 states 里 ${object.initialState}`);
    }

    for (const enemy of data.enemies || []) {
      const eid = register(enemy, '敌人');
      if (!TIERS.includes(enemy.tier)) error('enemy-tier', eid, `敌人 ${eid}: tier 非法`);
      if (!BRANCHES.includes(enemy.branch)) error('enemy-branch', eid, `敌人 ${eid}: branch 非法`);
      const room = typeof enemy.roomId === 'string' ? roomById.get(enemy.roomId) : undefined;
      if (!room) error('enemy-room-unknown', eid, `敌人 ${eid}: 未知房间 ${enemy.roomId}`);
      else if (enemy.floorId !== room.floorId) error('enemy-floor-mismatch', eid, `敌人 ${eid}: 楼层与房间 ${room.id} 不一致`);
      const center = enemy.center;
      if (!isPoint(center)) error('enemy-center-invalid', eid, `敌人 ${eid}: center 格式错误`);
      else if (!inBounds(center)) error('point-out-of-bounds', eid, `敌人 ${eid}: center 超出 bounds`);
      else if (room && validPolygon(room.points) && !pointInPolygon(center, room.points)) error('enemy-outside-room', eid, `敌人 ${eid}: center 不在房间 ${room.id} 内`);
    }

    const radius = isNum(player.radius) ? player.radius : 0;
    for (const door of data.doors || []) {
      const did = register(door, '门');
      checkFloor(door, did, '门');
      const points = door.points || [];
      if (points.length !== 2) error('door-points', did, `门 ${did}: 需要正好 2 个点`);
      if (!isNum(door.width) || door.width <= 0) error('door-width', did, `门 ${did}: width 必须大于 0`);
      else if (door.width < radius * 2 - 1e-6) warn('door-narrow', did, `门 ${did}: 宽 ${door.width}m 小于玩家直径 ${(radius * 2).toFixed(2)}m`);
      if (door.initial !== undefined && !['open', 'closed'].includes(door.initial)) error('door-initial', did, `门 ${did}: initial 必须是 open 或 closed`);
      if (door.height !== undefined && (!isNum(door.height) || door.height <= 0)) error('door-height', did, `门 ${did}: height 必须大于 0`);
      if (points.length === 2 && points.every(p => isPoint(p))) {
        const mid = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
        const onEdge = rooms.some(room => room.floorId === door.floorId && (room.points || []).some((p, i, list) =>
          isPoint(p) && isPoint(list[(i + 1) % list.length]) && segmentDistance(mid, p, list[(i + 1) % list.length]) <= DOOR_EDGE_TOLERANCE));
        if (!onEdge) warn('door-off-boundary', did, `门 ${did}: 中点不在任何房间边上`);
      }
    }

    const playerHeight = player.height;
    const clearanceHeight = isNum(playerHeight) && playerHeight > 0 ? playerHeight : 0;
    const floorLevel = floorId => {
      const level = typeof floorId === 'string' ? floorById.get(floorId)?.elevation : undefined;
      return isNum(level) ? level : 0;
    };
    // Objects with states may move aside; objects hung at or above head height do not block walking.
    const blocksRoute = object => !(Array.isArray(object.states) && object.states.length >= 1) &&
      !(isNum(playerHeight) && playerHeight > 0 && isNum(object.baseHeight) && object.baseHeight >= playerHeight);
    const solids = objects.filter(object => object.solid === true && (object.points || []).length >= 3 && object.points.every(p => isPoint(p)) &&
      blocksRoute(object));
    let main = null;
    for (const route of data.routes || []) {
      const rid = register(route, '路线');
      checkFloor(route, rid, '路线');
      if (!ROUTE_KINDS.includes(route.kind)) error('route-kind', rid, `路线 ${rid}: kind 非法`);
      const points = route.points || [];
      if (points.length < 2) error('route-points', rid, `路线 ${rid}: 至少 2 个点`);
      checkPoints(points, rid, '路线', true);
      if (route.kind === 'main') {
        if (main) warn('main-multiple', rid, '有多条主线；压力节奏只用第一条');
        else main = route;
      }
      if (radius > 0 && points.length >= 2 && points.every(p => isPoint(p, true))) {
        const routeLevel = floorLevel(route.floorId);
        const heights = points.map(p => (p.length === 3 ? p[2] : routeLevel));
        for (const object of solids) {
          if (object.floorId !== route.floorId) continue;
          // Vertical range of the object; a segment passing wholly above or below it is clear.
          const objLow = floorLevel(object.floorId) + (isNum(object.baseHeight) ? object.baseHeight : 0);
          const objHigh = isNum(object.height) && object.height > 0 ? objLow + object.height : Infinity;
          const hit = points.slice(1).findIndex((p, i) => {
            const segLow = Math.min(heights[i], heights[i + 1]);
            const segHigh = Math.max(heights[i], heights[i + 1]) + clearanceHeight;
            if (segHigh <= objLow || segLow >= objHigh) return false;
            return segmentPolygonDistance(points[i], p, object.points) < radius - 1e-6;
          });
          if (hit >= 0) warn('route-clearance', rid, `路线 ${rid}: 离阻挡物件 ${object.id} 不足玩家半径 ${radius}m`, closestRoutePoint(points[hit], points[hit + 1], object.points));
        }
      }
    }
    if (!main) error('main-missing', null, '缺少 kind="main" 的主线');

    for (const stair of data.stairs || []) {
      const sid = register(stair, '楼梯');
      for (const key of ['fromFloorId', 'toFloorId']) {
        if (!floorById.has(stair[key])) error('stairs-floor-unknown', sid, `楼梯 ${sid}: 未知 ${key} ${stair[key]}`);
      }
      if (stair.bottom !== undefined && !SIDES.includes(stair.bottom)) error('stairs-bottom', sid, `楼梯 ${sid}: bottom 必须是 N/S/E/W`);
      const points = stair.points || [];
      if (points.length < 3) error('stairs-points', sid, `楼梯 ${sid}: 至少 3 个点`);
      checkPoints(points, sid, '楼梯');
    }

    for (const water of data.water || []) {
      const wid = register(water, '水面');
      checkFloor(water, wid, '水面');
      const points = water.points || [];
      if (points.length < 3) error('water-points', wid, `水面 ${wid}: 至少 3 个点`);
      checkPoints(points, wid, '水面');
    }

    const objectById = new Map(objects.filter(o => typeof o.id === 'string').map(o => [o.id, o]));
    const enemyIds = new Set((data.enemies || []).filter(e => typeof e.id === 'string').map(e => e.id));
    const roomIds = new Set(rooms.filter(r => typeof r.id === 'string').map(r => r.id));
    const doorIds = new Set((data.doors || []).filter(d => typeof d.id === 'string').map(d => d.id));
    const openedDoors = [];
    for (const link of data.links || []) {
      const lid = register(link, '连接');
      const sources = link.from, targets = link.to;
      if (link.require !== undefined && !['all', 'any'].includes(link.require)) error('link-require', lid, `连接 ${lid}: require 必须是 all 或 any`);
      if (!(Array.isArray(sources) && sources.length && sources.every(s => typeof s === 'string') &&
        Array.isArray(targets) && targets.length &&
        targets.every(t => isObject(t) && typeof t.id === 'string' && typeof t.state === 'string'))) {
        error('link-endpoints', lid, `连接 ${lid}: from 需要非空 ID 数组，to 需要非空 {id, state} 数组`);
        continue;
      }
      openedDoors.push(...targets.filter(t => t.state === 'open').map(t => t.id));
      for (const source of sources) {
        if (!objectById.has(source) && !enemyIds.has(source) && !roomIds.has(source)) error('link-from-unknown', lid, `连接 ${lid}: from 里的 ${source} 不是已有的物件、敌人或房间`);
      }
      for (const { id: tid, state } of targets) {
        if (objectById.has(tid)) {
          if (!stateIds(objectById.get(tid)).includes(state)) error('link-to-state', lid, `连接 ${lid}: 物件 ${tid} 没有状态 ${state}`);
        } else if (doorIds.has(tid)) {
          if (!['open', 'closed'].includes(state)) error('link-to-state', lid, `连接 ${lid}: 门 ${tid} 的状态只能是 open 或 closed`);
        } else {
          error('link-to-unknown', lid, `连接 ${lid}: to 里的 ${tid} 不是已有的物件或门`);
        }
      }
    }

    for (const door of data.doors || []) {
      if (door.initial === 'closed' && !openedDoors.includes(door.id)) warn('door-closed-unlinked', door.id, `门 ${door.id}: 初始关闭，但没有连接把它设为 open`);
    }

    if (meta.proximity !== undefined) {
      let rules = meta.proximity;
      if (!Array.isArray(rules)) {
        error('proximity-field', null, 'meta.proximity 必须是数组');
        rules = [];
      }
      const objectKinds = objects.filter(o => typeof o.kind === 'string').map(o => o.kind);
      const enemyTypes = (data.enemies || []).filter(e => typeof e.enemyType === 'string').map(e => e.enemyType);
      for (const rule of rules) {
        if (isObject(rule)) register(rule, '邻近规则');
        const pid = isObject(rule) && typeof rule.id === 'string' ? rule.id : null;
        const problem = proximityProblem(rule);
        if (problem) {
          error('proximity-field', pid, `邻近规则 ${pid}: ${problem}`);
          continue;
        }
        for (const kind of rule.kinds || []) {
          if (!objectKinds.includes(kind)) warn('proximity-kind-unused', pid, `邻近规则 ${pid}: 地图里没有 kind 为 ${kind} 的物件`);
        }
        for (const enemyType of rule.enemyTypes || []) {
          if (!enemyTypes.includes(enemyType)) warn('proximity-kind-unused', pid, `邻近规则 ${pid}: 地图里没有 enemyType 为 ${enemyType} 的敌人`);
        }
      }
    }

    for (const note of data.reviewNotes || []) {
      const nid = register(note, '备注');
      if (!NOTE_STATUSES.includes(note.status)) error('note-status', nid, `备注 ${nid}: status 非法`);
      // Absent or "" means "not pinned to an entity"; anything else must name a real id.
      if (present(note.targetId) && note.targetId !== '' && (typeof note.targetId !== 'string' || !ids.has(note.targetId))) error('note-target', nid, `备注 ${nid}: targetId 不存在 ${note.targetId}`);
      if (note.at !== undefined) {
        if (!isPoint(note.at)) error('point-invalid', nid, `备注 ${nid}: at 格式错误`);
        else if (!inBounds(note.at)) error('point-out-of-bounds', nid, `备注 ${nid}: at 超出 bounds`);
      }
      if (note.floorId !== undefined && !floorById.has(note.floorId)) error('floor-unknown', nid, `备注 ${nid}: 未知楼层 ${note.floorId}`);
    }

    return {
      errors,
      warnings,
      stats: {
        rooms: rooms.length,
        objects: objects.length,
        enemies: (data.enemies || []).length,
        routes: (data.routes || []).length,
        doors: (data.doors || []).length,
        stairs: (data.stairs || []).length,
        water: (data.water || []).length,
      },
    };
  }

  const api = { validate, pointInPolygon, segmentDistance, segmentPolygonDistance, polygonArea };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkbenchValidate = api;
})(typeof window !== 'undefined' ? window : globalThis);
