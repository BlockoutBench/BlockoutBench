/* Generic level workbench. Reads AI_MAP_SPEC v1 maps; no per-hall renderer. */
(() => {
  'use strict';

  const desktop = window.WorkbenchDesktop || null;
  const builtinMaps = window.WORKBENCH_MAPS || {};
  const maps = desktop ? {} : builtinMaps;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = value => Number(value).toFixed(1).replace(/\.0$/, '');
  const point = value => Array.isArray(value) && value.length >= 2 ? [Number(value[0]), Number(value[1])] : null;
  const centerOf = entity => {
    if (Array.isArray(entity.center)) return point(entity.center);
    const points = entity.points || [];
    if (!points.length) return [0, 0];
    return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
  };
  const bboxOf = entity => {
    const points = entity.points || (entity.center ? [entity.center] : []);
    if (!points.length) return null;
    const xs = points.map(p => p[0]), zs = points.map(p => p[1]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  };
  const areaOf = points => Math.abs(points.reduce((sum, p, index) => {
    const q = points[(index + 1) % points.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2);
  const routeLength = points => points.slice(1).reduce((sum, p, index) => sum + Math.hypot(p[0] - points[index][0], p[1] - points[index][1]), 0);
  const unique = list => [...new Set(list)];

  const DEFAULT_LAYERS = {
    grid: true, rooms: true, objects: true, water: true, stairs: true,
    doors: true, routes: true, enemies: true, labels: true, notes: true,
    issues: true, clearance: false, heat: false, exits: false,
    proximity: true, links: false, states: false,
  };
  const state = {
    key: null,
    data: null,
    revision: 0,
    validation: null,
    floor: 'all',
    mode: '2d',
    selected: null,
    view: { x: 0, y: 0, w: 100, h: 100 },
    fitWidth: 100,
    drag: null,
    layers: { ...DEFAULT_LAYERS },
    exitOff: new Set(),
    style: 'schema',
    compare: null,
    tool: null,
    measure: { points: [], hover: null, done: false, closed: false },
    notes: null,
    statsSort: { key: 'area', dir: -1 },
    overrides: {},
    desktopWatch: true,
    desktopRecent: [],
    desktopFiles: new Map(),
  };

  // Layers that compute or overlay review analysis (listed apart from the plain drawing layers).
  const ANALYSIS_LAYERS = new Set(['issues', 'clearance', 'heat', 'exits', 'proximity', 'links', 'states']);
  const LAYERS = [
    ['grid', '网格'], ['rooms', '房间'], ['objects', '物件'], ['water', '水面'], ['stairs', '楼梯'],
    ['doors', '门'], ['routes', '路线'], ['enemies', '敌人'], ['labels', '名称'], ['notes', '备注钉'],
    ['issues', '问题标记'], ['clearance', '通行宽度'], ['heat', '压力热力'], ['exits', '撤离距离'],
    ['proximity', '邻近连线'], ['links', '机关连线'], ['states', '机关状态'],
  ];
  const validate = data => window.WorkbenchValidate.validate(data);
  let view3d = null;
  const playerRadius = () => (Number(state.data?.meta?.player?.radius) > 0 ? Number(state.data.meta.player.radius) : 0);
  const playerHeight = () => (Number(state.data?.meta?.player?.height) > 0 ? Number(state.data.meta.player.height) : 0);
  // Objects and doors as they stand in the previewed state (objects[].states, doors[].initial).
  const currentOf = object => window.WorkbenchGeometry.resolveObject(object, state.overrides);
  const doorState = door => state.overrides[door.id] ?? door.initial ?? 'open';
  // Objects that block walking: not ones that can change state, not ones hung above head height.
  const blocksWalking = object => object.solid === true && !(Array.isArray(object.states) && object.states.length) &&
    !(playerHeight() > 0 && Number.isFinite(object.baseHeight) && object.baseHeight >= playerHeight());
  const issuesFor = id => {
    const result = state.validation || { errors: [], warnings: [] };
    return [...result.errors.map(item => ({ ...item, level: 'error' })), ...result.warnings.map(item => ({ ...item, level: 'warn' }))]
      .filter(item => item.id === id);
  };

  function toast(message) {
    const element = $('toast');
    if (!element) return;
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 1800);
  }

  function floorName(id) {
    const floor = (state.data?.floors || []).find(item => item.id === id);
    return floor ? floor.name : id || '未标注';
  }

  function entityGroups(data) {
    return {
      rooms: data.rooms || [],
      objects: data.objects || [],
      enemies: data.enemies || [],
      doors: data.doors || [],
      routes: data.routes || [],
      stairs: data.stairs || [],
      water: data.water || [],
    };
  }

  function allEntities(data) {
    const groups = entityGroups(data);
    return [
      ...groups.rooms.map(e => ({ ...e, _type: 'room' })),
      ...groups.objects.map(e => ({ ...e, _type: 'object' })),
      ...groups.enemies.map(e => ({ ...e, _type: 'enemy' })),
      ...groups.doors.map(e => ({ ...e, _type: 'door' })),
      ...groups.routes.map(e => ({ ...e, _type: 'route' })),
      ...groups.stairs.map(e => ({ ...e, _type: 'stairs' })),
      ...groups.water.map(e => ({ ...e, _type: 'water' })),
      ...(Array.isArray(data.links) ? data.links : []).map(e => ({ ...e, _type: 'link' })),
    ];
  }

  function indexData(data) {
    const index = new Map();
    for (const entity of allEntities(data)) index.set(entity.id, entity);
    return index;
  }

  function floorMatches(entity) {
    if (state.floor === 'all') return true;
    if (entity.fromFloorId && entity.toFloorId) return entity.fromFloorId === state.floor || entity.toFloorId === state.floor;
    return entity.floorId === state.floor;
  }

  function visibleRouteSections(route) {
    const points = route.points || [];
    if (points.length < 2) return [];
    if (state.floor === 'all') return [points];
    if (!points.some(point => Number.isFinite(point[2]))) return floorMatches(route) ? [points] : [];
    const floors = state.data.floors || [];
    const selected = floors.find(floor => floor.id === state.floor)?.elevation;
    const base = floors.find(floor => floor.id === route.floorId)?.elevation;
    const onFloor = point => Math.abs((point[2] ?? base) - selected) < .1;
    const sections = [];
    let current;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1], point = points[i];
      if (!onFloor(prev) && !onFloor(point)) {
        current = undefined;
        continue;
      }
      if (!current) {
        current = [prev];
        sections.push(current);
      }
      current.push(point);
    }
    return sections;
  }

  function boundsOf(data, floorId = 'all') {
    if (floorId && floorId !== 'all') {
      const points = [];
      for (const entity of allEntities(data)) {
        const onFloor = entity.floorId === floorId || (entity._type === 'stairs' && (entity.fromFloorId === floorId || entity.toFloorId === floorId));
        if (!onFloor) continue;
        if (entity.points) points.push(...entity.points);
        if (entity.center) points.push(entity.center);
      }
      if (points.length) {
        return {
          minX: Math.min(...points.map(p => p[0])) - 1,
          minZ: Math.min(...points.map(p => p[1])) - 1,
          maxX: Math.max(...points.map(p => p[0])) + 1,
          maxZ: Math.max(...points.map(p => p[1])) + 1,
        };
      }
    }
    const meta = data.meta?.bounds;
    if (meta && ['minX', 'minZ', 'maxX', 'maxZ'].every(key => Number.isFinite(meta[key])) && meta.maxX > meta.minX && meta.maxZ > meta.minZ) {
      return { ...meta };
    }
    const points = [];
    for (const entity of allEntities(data)) {
      if (entity.points) points.push(...entity.points);
      if (entity.center) points.push(entity.center);
    }
    if (!points.length) return { minX: 0, minZ: 0, maxX: 100, maxZ: 100 };
    return {
      minX: Math.min(...points.map(p => p[0])) - 1,
      minZ: Math.min(...points.map(p => p[1])) - 1,
      maxX: Math.max(...points.map(p => p[0])) + 1,
      maxZ: Math.max(...points.map(p => p[1])) + 1,
    };
  }

  function fit() {
    const b = boundsOf(state.data, state.floor);
    const w = Math.max(1, b.maxX - b.minX);
    const h = Math.max(1, b.maxZ - b.minZ);
    state.fitWidth = w;
    state.view = { x: b.minX - w * 0.04, y: -b.maxZ - h * 0.04, w: w * 1.08, h: h * 1.08 };
    applyView();
  }

  function applyView() {
    if (!state.data) return;
    const svg = $('map');
    svg.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
    const pct = Math.round((state.fitWidth / state.view.w) * 100);
    $('zoomLabel').textContent = state.mode === '3d' ? '' : `${Math.max(1, pct)}%`;
    render();
    paintScale();
  }

  // Scale bar: a round number of metres drawn at its true on-screen length.
  function paintScale() {
    const bar = $('scaleBar'), svg = $('map');
    if (!bar) return;
    const pxPerMetre = Math.min((svg.clientWidth || 0) / Math.max(1, state.view.w), (svg.clientHeight || 0) / Math.max(1, state.view.h));
    if (!state.data || !(pxPerMetre > 0)) { bar.hidden = true; return; }
    const raw = 110 / pxPerMetre;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const metres = [5, 2, 1].map(step => step * pow).find(value => value <= raw) || pow;
    bar.hidden = false;
    bar.style.width = `${(metres * pxPerMetre).toFixed(1)}px`;
    bar.lastElementChild.textContent = `${num(metres)} m`;
  }

  /* Move the 2D view to state.view with a short ease instead of a jump. The map is drawn
     once for the destination (labels sized for it); only the viewBox is tweened. */
  let viewTween = 0;
  function glideFrom(from) {
    applyView();
    cancelAnimationFrame(viewTween);
    const to = { ...state.view }, svg = $('map');
    const still = ['x', 'y', 'w', 'h'].every(key => Math.abs(from[key] - to[key]) < 1e-6);
    if (still || state.mode === '3d' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const start = performance.now(), duration = 280;
    const frame = now => {
      const t = Math.min(1, (now - start) / duration), k = 1 - (1 - t) ** 3;
      const same = ['x', 'y', 'w', 'h'].every(key => state.view[key] === to[key]);
      if (!same) return;                       // the user panned or zoomed meanwhile
      const at = key => from[key] + (to[key] - from[key]) * k;
      svg.setAttribute('viewBox', `${at('x')} ${at('y')} ${at('w')} ${at('h')}`);
      if (t < 1) viewTween = requestAnimationFrame(frame);
    };
    svg.setAttribute('viewBox', `${from.x} ${from.y} ${from.w} ${from.h}`);
    viewTween = requestAnimationFrame(frame);
  }

  function zoomAt(factor, clientX, clientY) {
    const svg = $('map');
    const rect = svg.getBoundingClientRect();
    const px = state.view.x + ((clientX - rect.left) / Math.max(1, rect.width)) * state.view.w;
    const py = state.view.y + ((clientY - rect.top) / Math.max(1, rect.height)) * state.view.h;
    const nextW = Math.max(4, Math.min(600, state.view.w * factor));
    const scale = nextW / state.view.w;
    state.view = {
      x: px - (px - state.view.x) * scale,
      y: py - (py - state.view.y) * scale,
      w: nextW,
      h: state.view.h * scale,
    };
    applyView();
  }

  function svgPoint(points) {
    return points.map(([x, z]) => `${x},${-z}`).join(' ');
  }

  function labelPosition(entity) {
    if (Array.isArray(entity.label)) return [entity.label[0], -entity.label[1]];
    const center = centerOf(entity);
    return [center[0], -center[1]];
  }

  // Rough text width in font-size units: CJK glyphs are about one em, Latin/digits ~0.6.
  const textWidth = text => [...String(text)].reduce((sum, ch) => sum + (/[⺀-￯]/.test(ch) ? 1.02 : .62), 0);

  // Label level of detail: screen pixels per metre at the current zoom.
  const pixelsPerMetre = () => 14 / labelSize();
  const LOD = { sub: 3, enemy: 7, marker: 12, object: 16 };

  function labelSize() {
    const svg = $('map');
    const width = svg.clientWidth || 1000;
    const height = svg.clientHeight || 600;
    const scale = Math.min(width / Math.max(1, state.view.w), height / Math.max(1, state.view.h));
    return Math.max(0.12, 14 / Math.max(0.001, scale));
  }

  function renderDefs() {
    const routeColors = { main: '#a34f40', optional: '#b58a3c', exit: '#2d7c78', secret: '#7d5a8a' };
    const markers = Object.entries(routeColors).map(([kind, color]) => (
      `<marker id="arrow-${kind}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="3" markerHeight="3" orient="auto"><path d="M0 0L10 5L0 10Z" fill="${color}"/></marker>`
    )).join('');
    const arrow = (labelSize() * .45).toFixed(2);   // link arrowheads in plan metres, scaled with the labels
    return `<defs>
      <pattern id="grid" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M5 0H0V5" fill="none" stroke="#d8cdb8" stroke-width=".04"/></pattern>
      <pattern id="water" width="2" height="2" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#7fa9a2"/><path d="M0 .6Q.5 .35 1 .6T2 .6M0 1.5Q.5 1.25 1 1.5T2 1.5" fill="none" stroke="#d8e7dc" stroke-width=".07"/></pattern>
      ${markers}
      <marker id="arrow-stair" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10" fill="none" stroke="#3a332a" stroke-width="1.6"/></marker>
      <marker id="arrow-link" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="${arrow}" markerHeight="${arrow}" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L10 5L0 10Z" fill="#6a4c93"/></marker>
    </defs>`;
  }

  function render() {
    const data = state.data;
    const svg = $('map');
    if (!data) {
      svg.innerHTML = '';
      $('empty').hidden = false;
      return;
    }
    const index = indexData(data);
    const b = boundsOf(data, state.floor);
    const routeColors = { main: '#a34f40', optional: '#b58a3c', exit: '#2d7c78', secret: '#7d5a8a' };
    let html = renderDefs();
    if (state.layers.grid) {
      html += `<g pointer-events="none"><rect x="${b.minX}" y="${-b.maxZ}" width="${b.maxX - b.minX}" height="${b.maxZ - b.minZ}" fill="url(#grid)" opacity=".55"/></g>`;
    }

    const plan = state.style === 'plan';
    svg.classList.toggle('plan', plan);
    if (state.layers.rooms) {
      for (const room of data.rooms || []) {
        if (!floorMatches(room) || !room.points?.length) continue;
        const fill = plan ? tint(room.color || '#e7dcc5', .6) : room.color || '#e7dcc5';
        html += `<polygon class="wb-room wb-hit" data-id="${esc(room.id)}" points="${svgPoint(room.points)}" fill="${esc(fill)}" opacity="${plan ? 1 : .86}"><title>${esc(room.name)}</title></polygon>`;
      }
      // Finish footprints are generic map objects, drawn below all gameplay
      // geometry. Never draw mesh triangulation edges as physical borders.
      for (const object of [...(data.objects || [])].sort((a,b) => Number(a.kind === 'floor-inlay') - Number(b.kind === 'floor-inlay'))) {
        if (!['floor-finish', 'floor-inlay'].includes(object.kind) || !floorMatches(object)) continue;
        const current = currentOf(object);
        if (!current.present || !current.points?.length) continue;
        html += `<polygon class="wb-finish" points="${svgPoint(current.points)}" fill="${esc(object.color || '#ded6c2')}" pointer-events="none"/>`;
      }
    }
    if (state.layers.heat) {
      const field = heatField(state.floor);
      if (field) {
        const fb = field.bounds;
        html += `<image class="wb-heat" href="${field.url}" x="${fb.minX}" y="${-fb.maxZ}" width="${fb.maxX - fb.minX}" height="${fb.maxZ - fb.minZ}" preserveAspectRatio="none" pointer-events="none"/>`;
      }
    }
    if (state.layers.exits) {
      for (const floorId of visibleFloorIds()) {
        const field = exitField(floorId);
        if (!field) continue;
        const fb = field.bounds;
        html += `<image class="wb-exitfield" href="${field.url}" x="${fb.minX}" y="${-fb.maxZ}" width="${fb.maxX - fb.minX}" height="${fb.maxZ - fb.minZ}" preserveAspectRatio="none" pointer-events="none"/>`;
      }
    }
    if (state.layers.water) {
      for (const water of data.water || []) {
        if (!floorMatches(water) || !water.points?.length) continue;
        const box = bboxOf(water);
        html += `<polygon class="wb-water wb-hit" data-id="${esc(water.id)}" points="${svgPoint(water.points)}" fill="url(#water)" opacity=".8"><title>${esc(water.name)}</title></polygon>`;
        if (state.layers.labels && box && water.label && pixelsPerMetre() >= LOD.sub) {
          html += `<text class="wb-label wb-sub-label" x="${(box.minX + box.maxX) / 2}" y="${-(box.minZ + box.maxZ) / 2}" font-size="${(labelSize() * .55).toFixed(2)}" text-anchor="middle" pointer-events="none">${esc(water.name)}</text>`;
        }
      }
    }
    if (plan && state.layers.rooms) html += planWalls(data);
    if (state.layers.objects) {
      for (const object of data.objects || []) {
        if (!floorMatches(object) || !object.points?.length || ['floor-finish', 'floor-inlay'].includes(object.kind)) continue;
        const color = object.color || '#a99a7e';
        const current = currentOf(object);
        const pts = current.points?.length ? current.points : object.points;
        if (!current.present) {
          html += `<polygon class="wb-object-absent wb-hit" data-id="${esc(object.id)}" points="${svgPoint(pts)}"><title>${esc(object.name)}（不在场）</title></polygon>`;
          continue;
        }
        const raised = current.baseHeight > 0 ? ' wb-object-raised' : '';
        if (object.kind === 'roof') {
          // Match the 3D inspection roof without obscuring plan contents or clicks.
          html += `<polygon class="wb-object${raised}" data-id="${esc(object.id)}" points="${svgPoint(pts)}" fill="${esc(color)}" fill-opacity=".1" stroke-opacity=".6" style="pointer-events:none"><title>${esc(object.name)}（半透明顶盖）</title></polygon>`;
          continue;
        }
        if (plan && !['combat-space', 'loot', 'interaction'].includes(object.kind)) {
          const look = ['column', 'pier'].includes(object.kind) ? 'wb-object-column' : current.solid ? 'wb-object-solid' : 'wb-object-soft';
          html += `<polygon class="${look}${raised} wb-hit" data-id="${esc(object.id)}" points="${svgPoint(pts)}"><title>${esc(object.name)}</title></polygon>`;
          continue;
        }
        if (object.kind === 'combat-space') {
          html += `<polygon class="wb-combat-space${raised} wb-hit" data-id="${esc(object.id)}" points="${svgPoint(pts)}" fill="none" stroke="${esc(color)}"><title>${esc(object.name)}</title></polygon>`;
        } else if (['loot', 'interaction'].includes(object.kind)) {
          const [x, z] = centerOf({ points: pts });
          const label = object.kind === 'loot' ? (object.name.match(/L\d+/)?.[0] || '拾取') : 'F';
          html += `<g class="wb-hit" data-id="${esc(object.id)}"><circle class="wb-resource" cx="${x}" cy="${-z}" r=".62" fill="${object.kind === 'loot' ? '#faf6e9' : '#287c7b'}"/>${pixelsPerMetre() >= LOD.marker ? `<text class="wb-label" x="${x}" y="${-z + .15}" text-anchor="middle" fill="${object.kind === 'loot' ? '#765823' : '#ffffff'}" font-size=".46">${esc(label)}</text>` : ''}<title>${esc(object.name)}</title></g>`;
        } else {
          html += `<polygon class="wb-object${raised} wb-hit" data-id="${esc(object.id)}" points="${svgPoint(pts)}" fill="${esc(color)}" opacity=".92"><title>${esc(object.name)}</title></polygon>`;
        }
      }
    }
    if (state.layers.stairs) {
      for (const stair of data.stairs || []) {
        if (!floorMatches(stair) || !stair.points?.length) continue;
        const bbox = bboxOf(stair);
        if (!bbox) continue;
        if (plan) {
          html += planStair(stair, bbox, data);
          continue;
        }
        const horizontal = bbox.maxX - bbox.minX >= bbox.maxZ - bbox.minZ;
        html += `<g class="wb-hit" data-id="${esc(stair.id)}"><polygon class="wb-stairs" points="${svgPoint(stair.points)}"/><text class="wb-label wb-sub-label" x="${(bbox.minX + bbox.maxX) / 2}" y="${-(bbox.minZ + bbox.maxZ) / 2}" font-size="${(labelSize() * .6).toFixed(2)}" text-anchor="middle">${pixelsPerMetre() >= LOD.sub ? `${horizontal ? '↔' : '↕'} ${esc(stair.direction === 'down' ? '下' : '上')}` : ''}</text><title>${esc(stair.name)}</title></g>`;
      }
    }
    if (state.layers.doors) {
      for (const door of data.doors || []) {
        if (!floorMatches(door) || !door.points || door.points.length < 2) continue;
        const [a, b2] = door.points;
        const narrow = playerRadius() > 0 && door.width < playerRadius() * 2;
        if (doorState(door) === 'closed') html += `<line class="wb-door-closed" data-id="${esc(door.id)}" x1="${a[0]}" y1="${-a[1]}" x2="${b2[0]}" y2="${-b2[1]}" pointer-events="none"><title>${esc(door.name)} · 关</title></line>`;
        else if (plan) html += doorSwing(door, narrow);
        else html += `<line class="wb-door${narrow ? ' wb-door-narrow' : ''}" x1="${a[0]}" y1="${-a[1]}" x2="${b2[0]}" y2="${-b2[1]}" pointer-events="none"><title>${esc(door.name)} · ${num(door.width)}m</title></line>`;
        html += `<line class="wb-hit" data-id="${esc(door.id)}" x1="${a[0]}" y1="${-a[1]}" x2="${b2[0]}" y2="${-b2[1]}" stroke="transparent" stroke-width="12" vector-effect="non-scaling-stroke"><title>${esc(door.name)} · ${num(door.width)}m</title></line>`;
      }
    }
    // Player-width corridor along each route (meta.player.radius, true scale).
    if (state.layers.clearance && playerRadius() > 0) {
      for (const route of data.routes || []) {
        const color = route.color || routeColors[route.kind] || '#a34f40';
        for (const section of visibleRouteSections(route)) {
          html += `<polyline class="wb-clearance" points="${svgPoint(section)}" stroke="${esc(color)}" stroke-width="${playerRadius() * 2}" pointer-events="none"/>`;
        }
      }
    }
    if (state.layers.routes) {
      for (const route of data.routes || []) {
        const color = route.color || routeColors[route.kind] || '#a34f40';
        const width = route.kind === 'main' ? 2.4 : 1.7;
        for (const section of visibleRouteSections(route)) {
          const points = svgPoint(section);
          html += `<polyline class="wb-route" data-id="${esc(route.id)}" points="${points}" stroke="${esc(color)}" stroke-width="${width}" marker-end="url(#arrow-${esc(route.kind)})"><title>${esc(route.name)}</title></polyline>`;
          html += `<polyline class="wb-hit" data-id="${esc(route.id)}" points="${points}" fill="none" stroke="transparent" stroke-width="12" vector-effect="non-scaling-stroke"><title>${esc(route.name)}</title></polyline>`;
        }
      }
    }
    if (state.layers.enemies) {
      for (const enemy of data.enemies || []) {
        if (!floorMatches(enemy) || !enemy.center) continue;
        const [x, z] = enemy.center;
        const y = -z;
        const color = enemy.tier === 'boss' ? '#805394' : enemy.tier === 'elite' ? '#a55c30' : '#b7524b';
        let shape = `<circle class="wb-enemy wb-hit" data-id="${esc(enemy.id)}" cx="${x}" cy="${y}" r=".42" fill="${color}"><title>${esc(enemy.name)}</title></circle>`;
        if (enemy.tier === 'elite') shape = `<path class="wb-enemy wb-hit" data-id="${esc(enemy.id)}" d="M${x} ${y - .56}l.56 .56-.56 .56-.56-.56Z" fill="${color}"><title>${esc(enemy.name)}</title></path>`;
        if (enemy.tier === 'boss') shape = `<circle class="wb-enemy wb-hit" data-id="${esc(enemy.id)}" cx="${x}" cy="${y}" r=".64" fill="${color}"/><circle cx="${x}" cy="${y}" r=".9" fill="none" stroke="#805394" stroke-width=".09" pointer-events="none"/><title>${esc(enemy.name)}</title>`;
        if (state.layers.labels && pixelsPerMetre() >= LOD.enemy) shape += `<text class="wb-label" x="${x + .62}" y="${y + .18}" font-size="${(labelSize() * .55).toFixed(2)}">${esc(kindLegendOf(enemy.enemyType)?.label || enemy.enemyType || '')}</text>`;
        shape += `<circle class="wb-hit" data-id="${esc(enemy.id)}" cx="${x}" cy="${y}" r="1" fill="transparent"><title>${esc(enemy.name)}</title></circle>`;
        html += shape;
      }
    }
    if (state.layers.states) html += stateGhosts(data);
    if (state.layers.proximity && Array.isArray(data.meta?.proximity) && data.meta.proximity.length) html += proximityOverlay(data);
    if (state.layers.links && Array.isArray(data.links) && data.links.length) html += linksOverlay(data, index);
    if (state.compare) html += diffOverlay();
    if (state.layers.labels) {
      const size = labelSize();
      const candidates = (data.rooms || [])
        .filter(room => floorMatches(room) && room.points?.length)
        .map(room => {
          const [x, z] = labelPosition(room);
          const text = `${room.code ? `${room.code} ` : ''}${room.short || room.name}`;
          const rb = bboxOf(room);
          return { room, x, z, text, size, w: Math.max(size * 2, textWidth(text) * size + size * .3), h: size * 1.25, area: room.area || areaOf(room.points), fit: [rb.maxX - rb.minX, rb.maxZ - rb.minZ] };
        })
        .sort((a, b) => b.area - a.area);
      const placed = [];
      const free = box => !placed.some(other => !(box.x2 < other.x1 || box.x1 > other.x2 || box.y2 < other.y1 || box.y1 > other.y2));
      for (const item of candidates) {
        // Zoomed out, a name only shows when its room is big enough on screen to hold it.
        if (item.room.id !== state.selected && (item.fit[0] < item.w * .7 || item.fit[1] < item.h * .9)) continue;
        const box = { x1: item.x - item.w / 2, x2: item.x + item.w / 2, y1: item.z - item.h / 2, y2: item.z + item.h / 2 };
        if (!free(box)) continue;
        placed.push(box);
        html += `<text class="wb-label wb-room-label" x="${item.x}" y="${item.z}" font-size="${item.size.toFixed(2)}" text-anchor="middle">${esc(item.text)}</text>`;
      }
      // Close in, objects get their names too (rooms keep priority).
      if (pixelsPerMetre() >= LOD.object && state.layers.objects) {
        const small = size * .55;
        for (const object of data.objects || []) {
          if (!floorMatches(object) || !object.points?.length || !object.name || ['floor-finish', 'floor-inlay', 'combat-space'].includes(object.kind)) continue;
          const current = currentOf(object);
          const [x, z] = centerOf({ points: current.points?.length ? current.points : object.points });
          const name = current.baseHeight > 0 ? `${object.name} ↑${num(current.baseHeight)}` : object.name;
          const w = textWidth(name) * small + small * .3, h = small * 1.2;
          const box = { x1: x - w / 2, x2: x + w / 2, y1: -z - h / 2, y2: -z + h / 2 };
          if (!free(box)) continue;
          placed.push(box);
          html += `<text class="wb-label wb-sub-label wb-object-label" x="${x}" y="${-z}" font-size="${small.toFixed(2)}" text-anchor="middle" dominant-baseline="middle">${esc(name)}</text>`;
        }
      }
    }
    if (state.layers.notes && data.reviewNotes?.length) {
      const notes = data.reviewNotes.filter(note => (note.targetId && index.has(note.targetId)) || Array.isArray(note.at));
      notes.forEach((note, indexNumber) => {
        const target = note.targetId ? index.get(note.targetId) : null;
        if (target ? !floorMatches(target) : (note.floorId && state.floor !== 'all' && note.floorId !== state.floor)) return;
        const [x, z] = Array.isArray(note.at) ? note.at : centerOf(target);
        html += `<g class="wb-hit" ${target ? `data-id="${esc(target.id)}"` : ''} data-note="${esc(note.id)}"><circle class="wb-pin" cx="${x}" cy="${-z}" r=".62"/><text class="wb-pin-text" x="${x}" y="${-z + .3}" font-size="${(labelSize() * .5).toFixed(2)}">${indexNumber + 1}</text><title>${esc(note.text)}</title></g>`;
      });
    }
    if (state.layers.exits) {
      const r = labelSize() * .62;
      for (const candidate of activeExits()) {
        if (state.floor !== 'all' && candidate.floorId !== state.floor) continue;
        const pts = candidate.source.points || [candidate.source.point];
        const [x, z] = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
        html += `<g class="wb-hit wb-exit-pin" data-id="${esc(candidate.id)}"><circle cx="${x}" cy="${-z}" r="${r.toFixed(2)}"/><text x="${x}" y="${(-z + r * .38).toFixed(2)}" font-size="${(r * 1.05).toFixed(2)}">出</text><title>撤离点：${esc(candidate.label)}</title></g>`;
      }
    }
    // Validation issues pinned to the entity they name (one ring per entity).
    if (state.layers.issues && state.validation) {
      const byId = new Map();
      const placed = [];
      for (const [level, list] of [['error', state.validation.errors], ['warn', state.validation.warnings]]) {
        for (const item of list) {
          if (!item.id || !index.has(item.id)) continue;
          if (Array.isArray(item.at)) { placed.push({ ...item, level }); continue; }
          const entry = byId.get(item.id) || { level, msgs: [] };
          if (level === 'error') entry.level = 'error';
          entry.msgs.push(item.msg);
          byId.set(item.id, entry);
        }
      }
      const r = labelSize() * .55;
      for (const [id, entry] of byId) {
        const target = index.get(id);
        if (!floorMatches(target)) continue;
        const [x, z] = centerOf(target);
        html += `<g class="wb-hit wb-issue wb-issue-${entry.level}" data-id="${esc(id)}" data-issue="${entry.msgs.length}"><circle cx="${x}" cy="${-z}" r="${r.toFixed(2)}"/><text x="${x}" y="${(-z + r * .38).toFixed(2)}" font-size="${(r * 1.1).toFixed(2)}" text-anchor="middle">!</text><title>${esc(entry.msgs.join('\n'))}</title></g>`;
      }
      for (const item of placed) {
        if (!floorMatches(index.get(item.id))) continue;
        const [x, z] = item.at;
        html += `<g class="wb-hit wb-issue wb-issue-${item.level}" data-id="${esc(item.id)}" data-issue="1"><circle cx="${x}" cy="${-z}" r="${r.toFixed(2)}"/><text x="${x}" y="${(-z + r * .38).toFixed(2)}" font-size="${(r * 1.1).toFixed(2)}" text-anchor="middle">!</text><title>${esc(item.msg)}</title></g>`;
      }
    }

    const selected = state.selected ? index.get(state.selected) : null;
    if (selected && floorMatches(selected)) {
      const box = bboxOf(selected);
      if (box && (box.maxX > box.minX || box.maxZ > box.minZ)) {
        html += `<rect class="wb-selection" x="${box.minX - .25}" y="${-box.maxZ - .25}" width="${box.maxX - box.minX + .5}" height="${box.maxZ - box.minZ + .5}" pointer-events="none"/>`;
      } else if (box) {
        html += `<circle class="wb-selection" cx="${box.minX}" cy="${-box.minZ}" r="1.3" pointer-events="none"/>`;
      }
    }
    svg.innerHTML = html;
    $('empty').hidden = true;
    renderLegend();
    renderMapMeta();
    paintPaceCursor();
    paintTools();
    syncHash();
    view3d?.sync();
  }

  /* Link state: floor and non-default layers ride in the hash on every render, so the
     address bar is always shareable; "复制链接" adds the 3D camera pose on demand. */
  function layersParam() {
    return LAYERS.map(([key]) => key)
      .filter(key => state.layers[key] !== DEFAULT_LAYERS[key])
      .map(key => (state.layers[key] ? key : `-${key}`)).join(',');
  }

  function syncHash() {
    if (!state.key) return;
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (state.floor !== 'all') params.set('floor', state.floor); else params.delete('floor');
    const layers = layersParam();
    if (layers) params.set('layers', layers); else params.delete('layers');
    const next = `#${params}`;
    if (next !== location.hash) history.replaceState(null, '', `${location.pathname}${location.search}${next}`);
  }

  function applyHashState(params) {
    for (const token of (params.get('layers') || '').split(',').filter(Boolean)) {
      const key = token.replace(/^-/, '');
      if (key in DEFAULT_LAYERS) state.layers[key] = !token.startsWith('-');
    }
    const floor = params.get('floor');
    if (floor && (state.data.floors || []).some(item => item.id === floor)) state.floor = floor;
    renderLayers();
    renderFloors();
    renderLevels();
    renderExitPanel();
    fit();
  }

  async function copyTextSafe(text, okMessage, promptLabel) {
    if (desktop) {
      await desktop.copyText(text);
      toast(okMessage);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
    } catch {
      window.prompt(promptLabel, text);
    }
  }

  async function saveTextFile({ title, defaultName, filters, mime, content, okMessage }) {
    if (desktop) {
      const result = await desktop.saveFile({ title, defaultName, filters, content });
      if (result?.saved) toast(okMessage);
      return;
    }
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = defaultName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(okMessage);
  }

  async function copyLink() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (state.mode === '3d') params.set('pose', view3d.pose()); else params.delete('pose');
    history.replaceState(null, '', `${location.pathname}${location.search}#${params}`);
    await copyTextSafe(location.href, '链接已复制', '复制这个链接：');
  }

  /* Side panels, theme, help, drag-and-drop import. Panel and theme choices are a
     per-viewer convenience kept in localStorage (guarded: private windows may refuse). */
  const stored = {
    get: key => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  };

  function togglePanel(side, force) {
    const isLeft = side === 'left';
    const main = document.querySelector('.wb-main');
    const cls = isLeft ? 'hide-left' : 'hide-right';
    const hidden = force ?? !main.classList.contains(cls);
    main.classList.toggle(cls, hidden);
    const drawer = main.querySelector(isLeft ? '.wb-side' : '.wb-inspector');
    if (drawer) drawer.inert = hidden;
    const railBtn = $(isLeft ? 'railLeftBtn' : 'railRightBtn');
    if (railBtn) {
      railBtn.setAttribute('aria-expanded', String(!hidden));
      railBtn.title = isLeft
        ? (hidden ? '展开左栏（[）' : '收起左栏（[）')
        : (hidden ? '展开右栏（]）' : '收起右栏（]）');
    }
    stored.set(`wb-${cls}`, hidden ? '1' : '');
    requestAnimationFrame(() => { if (state.data) render(); });
  }

  // The light palette is the default look; dark applies only after the user picks it
  // with the header button (remembered under wb-theme-pick, not taken from the system).
  function setTheme(theme, remember = false) {
    const root = document.documentElement;
    if (root.dataset.theme && root.dataset.theme !== theme) {
      root.classList.add('theme-fade');
      clearTimeout(setTheme.timer);
      setTheme.timer = setTimeout(() => root.classList.remove('theme-fade'), 340);
    }
    root.dataset.theme = theme;
    $('themeBtn').setAttribute('aria-pressed', String(theme === 'dark'));
    if (remember) stored.set('wb-theme-pick', theme);
    if (state.data) render();
    else view3d?.sync();
  }

  function toggleHelp(force) {
    const panel = $('helpPanel');
    panel.hidden = !(force ?? panel.hidden);
  }

  function bindShell() {
    if ($('railLeftBtn')) $('railLeftBtn').onclick = () => togglePanel('left');
    if ($('railRightBtn')) $('railRightBtn').onclick = () => togglePanel('right');
    $('themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
    $('helpBtn').onclick = () => toggleHelp();
    $('copyLinkBtn').onclick = copyLink;
    $('helpPanel').addEventListener('click', event => {
      if (event.target === $('helpPanel') || event.target.closest('[data-close-modal]')) toggleHelp(false);
    });
    let depth = 0;
    const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
    document.addEventListener('dragenter', event => { if (hasFiles(event)) { depth += 1; $('dropHint').hidden = false; } });
    document.addEventListener('dragleave', event => { if (hasFiles(event) && --depth <= 0) { depth = 0; $('dropHint').hidden = true; } });
    document.addEventListener('dragover', event => { if (hasFiles(event)) event.preventDefault(); });
    document.addEventListener('drop', event => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      $('dropHint').hidden = true;
      const file = [...event.dataTransfer.files].find(item => /\.json$/i.test(item.name) || item.type === 'application/json');
      if (!file) { toast('只支持拖入 .json 地图文件'); return; }
      const diskPath = desktop?.getPathForFile?.(file);
      if (diskPath) openDesktopFilePath(diskPath);
      else importFile(file);
    });
    window.addEventListener('keydown', event => {
      if (event.target instanceof Element && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName))) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '?') { toggleHelp(); event.preventDefault(); }
      else if (event.key === 'Escape' && !$('helpPanel').hidden) toggleHelp(false);
      else if (event.key === 'Escape' && !$('statsPanel').hidden) toggleStats(false);
      else if (event.key === 'Escape' && state.tool) toolEscape();
      else if (event.key === 'Enter' && state.tool === 'measure') finishMeasure();
      else if (event.key === '[') togglePanel('left');
      else if (event.key === ']') togglePanel('right');
      else if (state.mode === '2d') tools2dKey(event);
    });
  }

  // 2D tool shortcuts.
  const toolKeys = { m: () => setTool('measure'), n: () => setTool('note'), t: () => toggleStats() };
  function tools2dKey(event) {
    const action = toolKeys[event.key.toLowerCase()];
    if (action) {
      event.preventDefault();
      action();
    }
  }

  /* Version compare: diff the shown map against a base (another map in the list or an
     imported JSON) by entity id. Added = green, removed = red dashed ghost of the old
     shape, moved/reshaped = amber with the old outline and a move arrow, field-only
     edits = amber dot. 2D only; the base is never written anywhere. */
  const DIFF_IGNORE = new Set(['_type']);

  function geometryOf(entity) {
    return JSON.stringify(entity.points || entity.center || null);
  }

  function computeDiff(current, base) {
    const now = indexData(current), before = indexData(base);
    const items = [];
    for (const [id, entity] of now) {
      const old = before.get(id);
      if (!old) { items.push({ kind: 'added', id, entity }); continue; }
      const moved = geometryOf(entity) !== geometryOf(old);
      const fields = unique([...Object.keys(entity), ...Object.keys(old)])
        .filter(key => !DIFF_IGNORE.has(key) && key !== 'points' && key !== 'center' && JSON.stringify(entity[key]) !== JSON.stringify(old[key]));
      if (!moved && !fields.length) continue;
      const a = centerOf(old), b = centerOf(entity);
      items.push({ kind: 'changed', id, entity, old, moved, shift: Math.hypot(b[0] - a[0], b[1] - a[1]), fields });
    }
    for (const [id, old] of before) if (!now.has(id)) items.push({ kind: 'removed', id, old });
    const order = { added: 0, changed: 1, removed: 2 };
    return items.sort((m, n) => order[m.kind] - order[n.kind] || String(m.id).localeCompare(String(n.id)));
  }

  function diffItems() {
    if (!state.compare) return [];
    if (state.compare.forKey !== state.key) {
      state.compare.items = computeDiff(state.data, state.compare.data);
      state.compare.forKey = state.key;
    }
    return state.compare.items;
  }

  function diffShape(entity, cls) {
    if (entity.center && !entity.points) return `<circle class="${cls}" cx="${entity.center[0]}" cy="${-entity.center[1]}" r="1"/>`;
    const points = entity.points || [];
    if (points.length < 2) return '';
    const open = entity._type === 'route' || entity._type === 'door' || points.length < 3;
    return open ? `<polyline class="${cls}" points="${svgPoint(points)}" fill="none"/>` : `<polygon class="${cls}" points="${svgPoint(points)}"/>`;
  }

  function diffOverlay() {
    let html = '';
    for (const item of diffItems()) {
      const entity = item.entity || item.old;
      if (!floorMatches(entity)) continue;
      if (item.kind === 'added') html += diffShape(item.entity, 'wb-diff-added');
      else if (item.kind === 'removed') html += `<g class="wb-hit" data-diff="${esc(item.id)}">${diffShape(item.old, 'wb-diff-removed')}<title>已删除：${esc(item.old.name || item.id)}</title></g>`;
      else if (item.moved) {
        html += diffShape(item.old, 'wb-diff-old') + diffShape(item.entity, 'wb-diff-changed');
        if (item.shift > .2) {
          const [a, b] = [centerOf(item.old), centerOf(item.entity)];
          html += `<line class="wb-diff-move" x1="${a[0]}" y1="${-a[1]}" x2="${b[0]}" y2="${-b[1]}" marker-end="url(#arrow-exit)"/>`;
        }
      } else {
        const [x, z] = centerOf(item.entity);
        html += `<circle class="wb-diff-dot" cx="${x}" cy="${-z}" r="${(labelSize() * .3).toFixed(2)}"/>`;
      }
    }
    return `<g pointer-events="visiblePainted">${html}</g>`;
  }

  function renderDiffPanel() {
    const panel = $('diffPanel');
    panel.hidden = !state.compare || !state.data;
    if (panel.hidden) return;
    const items = diffItems();
    const count = kind => items.filter(item => item.kind === kind).length;
    const tag = { added: '+', removed: '−', changed: '~' };
    const detail = item => {
      if (item.kind === 'added') return typeLabel(item.entity._type);
      if (item.kind === 'removed') return typeLabel(item.old._type);
      return [item.moved ? (item.shift > .2 ? `移动 ${num(item.shift)} m` : '形状') : '', item.fields.join('、')].filter(Boolean).join(' · ');
    };
    panel.innerHTML = `<div class="counts"><span style="color:#2e8a4f">+${count('added')} 新增</span><span style="color:var(--danger)">−${count('removed')} 删除</span><span style="color:var(--amber)">~${count('changed')} 变更</span></div>`
      + (items.length ? items.slice(0, 300).map(item => `<button type="button" data-diff-id="${esc(item.id)}" data-diff-kind="${item.kind}"><b class="wb-diff-tag ${item.kind}">${tag[item.kind]}</b><span>${esc((item.entity || item.old).name || item.id)}</span><small>${esc(detail(item))}</small></button>`).join('')
        : '<p class="wb-hint">两版没有差异</p>');
  }

  function setCompare(base, key) {
    state.compare = base ? { data: base, key, items: [], forKey: null } : null;
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (key && maps[key]) params.set('cmp', key); else params.delete('cmp');
    history.replaceState(null, '', `${location.pathname}${location.search}#${params}`);
    renderCompareSelect();
    renderDiffPanel();
    render();
    if (state.selected) inspect(state.selected);
  }

  // The compare popover (2D tool bar): base picker and the change list.
  function toggleComparePop(force) {
    const pop = $('comparePop');
    pop.hidden = !(force ?? pop.hidden);
    $('compareBtn').setAttribute('aria-expanded', String(!pop.hidden));
    syncCompareBtn();
  }

  function syncCompareBtn() {
    const on = !!state.compare || !$('comparePop').hidden;
    $('compareBtn').classList.toggle('active', on);
    $('compareBtn').setAttribute('aria-pressed', String(!!state.compare));
  }

  // Compare bases that live only in this session (not maps in the list).
  const SESSION_BASES = ['__initial'];

  function renderCompareSelect() {
    const select = $('compareSelect');
    const options = Object.keys(maps).filter(key => key !== state.key)
      .map(key => `<option value="${esc(key)}">${esc((maps[key].meta?.title || key))}</option>`);
    const diskInit = state.desktopFiles.get(state.key)?.initialData;
    const initialOpt = diskInit ? '<option value="__initial">（打开时初版）</option>' : '';
    let prevOpt = '';
    const imported = state.compare && !SESSION_BASES.includes(state.compare.key) && !maps[state.compare.key]
      ? `<option value="__file">（导入）${esc(state.compare.data.meta?.title || '基准 JSON')}</option>` : '';
    select.innerHTML = `<option value="">不对比</option>${prevOpt}${initialOpt}${imported}${options.join('')}`;
    select.value = state.compare ? (SESSION_BASES.includes(state.compare.key) || maps[state.compare.key] ? state.compare.key : '__file') : '';
    syncCompareBtn();
  }

  // Centre on a removed entity's old shape (it no longer exists to be selected).
  function showRemoved(id) {
    const item = diffItems().find(entry => entry.id === id && entry.kind === 'removed');
    const box = item && bboxOf(item.old);
    if (!box) return;
    state.view.x = (box.minX + box.maxX) / 2 - state.view.w / 2;
    state.view.y = -(box.minZ + box.maxZ) / 2 - state.view.h / 2;
    applyView();
    toast(`已删除：${item.old.name || id}（基准里的位置）`);
  }

  /* 2D review tools: measure (M), annotate (N), stats (T). Tools take over the map
     click while active; dragging still pans. Notes are kept per map in this browser
     (localStorage) until exported as reviewNotes in a copy of the map JSON. */
  const walkSpeed = () => (Number(state.data?.meta?.player?.walkSpeed) > 0 ? Number(state.data.meta.player.walkSpeed) : 4);

  function planPoint(event) {
    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform($('map').getScreenCTM().inverse());
    return [+local.x.toFixed(2), +(-local.y).toFixed(2)];
  }

  function setTool(tool) {
    state.tool = tool && state.tool !== tool ? tool : null;
    for (const [id, name] of [['measureBtn', 'measure'], ['noteBtn', 'note']]) {
      $(id).classList.toggle('active', state.tool === name);
      $(id).setAttribute('aria-pressed', String(state.tool === name));
    }
    $('map').classList.toggle('tool-measure', state.tool === 'measure');
    $('map').classList.toggle('tool-note', state.tool === 'note');
    if (state.tool !== 'note') closeNoteEditor();
    if (state.tool === 'measure') toast('测量：单击加点，双击 / Enter 结束，点回起点量面积，Esc 清除');
    if (state.tool === 'note') toast('批注：单击地图放钉（点在对象上就钉在该对象）');
    renderNotes();
    paintTools();
  }

  function toolEscape() {
    if (state.tool === 'measure' && state.measure.points.length) {
      state.measure = { points: [], hover: null, done: false, closed: false };
      paintTools();
    } else if (state.tool === 'note' && !$('noteEditor').hidden) closeNoteEditor();
    else setTool(null);
  }

  function measureClick(event) {
    const m = state.measure;
    if (m.done) Object.assign(m, { points: [], hover: null, done: false, closed: false });
    const p = planPoint(event);
    const first = m.points[0];
    if (first && m.points.length >= 3 && Math.hypot(p[0] - first[0], p[1] - first[1]) < labelSize() * .7) {
      Object.assign(m, { closed: true, done: true, hover: null });
    } else m.points.push(p);
    paintTools();
  }

  function finishMeasure() {
    const m = state.measure;
    if (m.points.length >= 2) Object.assign(m, { done: true, hover: null });
    paintTools();
  }

  function measureFigures() {
    const m = state.measure;
    const pts = m.done || !m.hover ? m.points : [...m.points, m.hover];
    const segments = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    if (m.closed) segments.push(Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]));
    return { pts, segments, total: segments.reduce((sum, value) => sum + value, 0), area: m.closed ? areaOf(pts) : 0 };
  }

  function sessionNotes() {
    if (!state.data) return [];
    const key = `wb-notes:${state.data.meta?.title || state.key}`;
    if (state.notes?.key !== key) {
      let list = [];
      try { list = JSON.parse(stored.get(key) || '[]'); } catch { list = []; }
      state.notes = { key, list: Array.isArray(list) ? list : [] };
    }
    return state.notes.list;
  }

  function saveNotes() {
    stored.set(state.notes.key, JSON.stringify(state.notes.list));
    renderNotes();
    paintTools();
  }

  function noteClick(event, targetId) {
    const at = planPoint(event);
    const b = state.data.meta?.bounds;
    if (b && (at[0] < b.minX || at[0] > b.maxX || at[1] < b.minZ || at[1] > b.maxZ)) {
      toast('批注要放在地图范围（meta.bounds）内');
      return;
    }
    const target = targetId ? indexData(state.data).get(targetId) : null;
    const floors = state.data.floors || [];
    const floorId = target?.floorId || target?.fromFloorId || (state.floor !== 'all' ? state.floor : floors.length === 1 ? floors[0].id : undefined);
    state.pendingNote = { at, targetId: target?.id, floorId };
    const editor = $('noteEditor');
    const rect = $('canvasWrap').getBoundingClientRect();
    editor.style.left = `${Math.max(6, Math.min(rect.width - 270, event.clientX - rect.left + 12))}px`;
    editor.style.top = `${Math.max(6, Math.min(rect.height - 140, event.clientY - rect.top + 12))}px`;
    $('noteTarget').textContent = target ? `钉在：${target.name || target.id}` : `位置：(${num(at[0])}, ${num(at[1])})${floorId ? ` · ${floorName(floorId)}` : ''}`;
    $('noteText').value = '';
    editor.hidden = false;
    $('noteText').focus();
  }

  function closeNoteEditor() {
    const editor = $('noteEditor');
    // Hand the keyboard back to the map, otherwise shortcuts (M / N / T) keep typing
    // into the hidden textarea.
    if (!editor.hidden && editor.contains(document.activeElement)) $('map').focus({ preventScroll: true });
    editor.hidden = true;
    state.pendingNote = null;
  }

  function saveNote() {
    const text = $('noteText').value.trim();
    const pending = state.pendingNote;
    if (!pending) return closeNoteEditor();
    if (!text) { toast('先写批注内容'); return; }
    const taken = new Set([...indexData(state.data).keys(), ...(state.data.floors || []).map(floor => floor.id), ...(state.data.reviewNotes || []).map(note => note.id), ...sessionNotes().map(note => note.id)]);
    let n = sessionNotes().length + 1;
    while (taken.has(`rn-${n}`)) n += 1;
    const note = { id: `rn-${n}`, text, status: 'open', at: pending.at };
    if (pending.targetId) note.targetId = pending.targetId;
    if (pending.floorId) note.floorId = pending.floorId;
    sessionNotes().push(note);
    closeNoteEditor();
    saveNotes();
  }

  function showNote(id) {
    const note = sessionNotes().find(item => item.id === id);
    if (!note) return;
    if (note.targetId) return locate(note.targetId);
    if (note.floorId && state.floor !== 'all' && state.floor !== note.floorId) {
      state.floor = note.floorId;
      renderFloors();
      renderLevels();
    }
    state.view.x = note.at[0] - state.view.w / 2;
    state.view.y = -note.at[1] - state.view.h / 2;
    applyView();
  }

  function renderNotes() {
    const list = sessionNotes();
    $('notesSection').hidden = !list.length && state.tool !== 'note';
    $('notesCount').textContent = list.length ? `${list.length} 条` : '';
    const index = state.data ? indexData(state.data) : new Map();
    $('notesList').innerHTML = list.length
      ? list.map((note, i) => `<div class="note" data-note-id="${esc(note.id)}"><b>N${i + 1}</b><span>${esc(note.text)}<small>${esc(note.targetId ? (index.get(note.targetId)?.name || note.targetId) : `(${num(note.at[0])}, ${num(note.at[1])})`)}${note.floorId && (state.data.floors || []).length > 1 ? ` · ${esc(floorName(note.floorId))}` : ''}</small></span><button type="button" data-note-remove="${esc(note.id)}" title="删除" aria-label="删除批注">×</button></div>`).join('')
      : '<p class="wb-hint">在地图上单击放钉，写下意见；最后导出给 AI 修改。</p>';
  }

  async function exportNotes() {
    const list = sessionNotes();
    if (!list.length) { toast('还没有批注'); return; }
    const copy = JSON.parse(JSON.stringify(state.data));
    copy.reviewNotes = [...(copy.reviewNotes || []), ...list];
    const result = validate(copy);
    if (result.errors.length) { toast(`导出前校验失败：${result.errors[0].msg}`); return; }
    await saveTextFile({
      title: '导出带评审批注的地图 JSON',
      defaultName: `${(state.data.meta?.title || 'map').replace(/[\\/:*?"<>|]/g, '-')}-评审批注.json`,
      filters: [{ name: '关卡地图 JSON', extensions: ['json'] }],
      mime: 'application/json',
      content: `${JSON.stringify(copy, null, 2)}\n`,
      okMessage: `已导出 ${list.length} 条批注`,
    });
  }

  async function copyAiContextPrompt({ includeNotes = false } = {}) {
    if (!state.data) return;
    const list = includeNotes ? sessionNotes() : [];
    const ctx = window.WorkbenchGeometry.buildAiEditContext(state.data, {
      selectedId: state.selected,
      notes: list,
      validation: state.validation,
      hops: 2,
    });
    const index = indexData(state.data);
    const noteLines = list.map((note, i) => {
      const where = note.targetId ? `${index.get(note.targetId)?.name || note.targetId}（${note.targetId}）` : `坐标 (${num(note.at[0])}, ${num(note.at[1])})${note.floorId ? ` @${note.floorId}` : ''}`;
      return `${i + 1}. [${where}] ${note.text}`;
    });
    const issueLines = ctx.issues.slice(0, 12).map(it => `- [${it.level}:${it.code}] ${it.msg}`);
    const diskEntry = state.desktopFiles.get(state.key);
    const fileLine = diskEntry?.filePath ? `（文件：${diskEntry.filePath}）` : '';
    const sections = [
      `请修改地图「${state.data.meta?.title || state.key}」${fileLine}，保持未涉及区域的 ID 与坐标不变。`,
      state.selected ? `当前聚焦实体：${index.get(state.selected)?.name || state.selected}（${state.selected}）` : '',
      noteLines.length ? `评审意见：\n${noteLines.join('\n')}` : '',
      issueLines.length ? `当前结构/空间问题：\n${issueLines.join('\n')}` : '',
      `工作台支持直接粘贴以下两种输出：\n1) 局部补丁：{"patch": {"upsertRooms": [...], "upsertDoors": [...], "upsertObjects": [...], "upsertEnemies": [...], "upsertRoutes": [...], "removeIds": [...]}}\n2) 相对贴靠简写：房间支持 size:[w,d] + attach:"eastOf:<id>"，门支持 between:["roomA","roomB"]`,
      `局部邻近上下文（聚焦 ${ctx.focusRoomIds.join('、') || '全图'}，含 2 跳邻房 ${ctx.neighborRoomIds.join('、') || '无'}）：\n${JSON.stringify(ctx.contextData)}`,
    ].filter(Boolean);
    await copyTextSafe(sections.join('\n\n'), '已复制 AI 局部上下文，可直接发送修改', '复制以下 AI 上下文：');
  }

  async function copyNotes() {
    if (!sessionNotes().length) { toast('还没有批注'); return; }
    await copyAiContextPrompt({ includeNotes: true });
  }

  // Drop cached heat / exit fields after the map data changes in place.
  function invalidateGeometryCaches() {
    heatCache.clear();
    exitCache.clear();
    state.revision += 1;
  }


  // Measure overlay + session note pins; redrawn after every render().
  function paintTools() {
    const svg = $('map');
    svg.querySelector('#wbTools')?.remove();
    if (!state.data) return;
    const size = labelSize();
    let html = '';
    const m = state.measure;
    const readout = $('measureReadout');
    readout.hidden = true;
    if (state.tool === 'measure' && m.points.length) {
      const { pts, segments, total, area } = measureFigures();
      html += `<${m.closed ? 'polygon class="wb-measure-area"' : 'polyline class="wb-measure-line"'} points="${svgPoint(pts)}"/>`;
      pts.forEach(p => { html += `<circle class="wb-measure-dot" cx="${p[0]}" cy="${-p[1]}" r="${(size * .22).toFixed(2)}"/>`; });
      segments.forEach((length, i) => {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (length > size * 2) html += `<text class="wb-measure-label" x="${(a[0] + b[0]) / 2}" y="${-(a[1] + b[1]) / 2 - size * .3}" font-size="${(size * .62).toFixed(2)}">${num(length)} m</text>`;
      });
      readout.innerHTML = `${segments.length} 段 · 总长 <b>${num(total)} m</b> · 步行约 ${Math.round(total / walkSpeed())} s`
        + (m.closed ? `<br>面积 <b>${num(area)} m²</b> · 周长 ${num(total)} m` : '')
        + (m.done ? '' : '<br><small>双击 / Enter 结束 · 点回起点量面积</small>');
      readout.hidden = false;
    }
    if (state.layers.notes) {
      sessionNotes().forEach((note, i) => {
        if (note.floorId && state.floor !== 'all' && note.floorId !== state.floor) return;
        const r = size * .62;
        html += `<g class="wb-note-pin${note.targetId ? ' wb-hit' : ''}" ${note.targetId ? `data-id="${esc(note.targetId)}"` : ''}><circle cx="${note.at[0]}" cy="${-note.at[1]}" r="${r.toFixed(2)}"/><text x="${note.at[0]}" y="${(-note.at[1] + r * .36).toFixed(2)}" font-size="${(r * .95).toFixed(2)}">N${i + 1}</text><title>${esc(note.text)}</title></g>`;
      });
    }
    if (!html) return;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.id = 'wbTools';
    g.innerHTML = html;
    svg.appendChild(g);
  }

  /* Stats: a sortable room table (area, enemies, density, objects, doors, mean
     walking distance to an exit when exits are known) plus enemy and area mix. */
  function toggleStats(force) {
    const panel = $('statsPanel');
    const open = force ?? panel.hidden;
    if (open) renderStats();
    panel.hidden = !open;
  }

  function roomRows() {
    const data = state.data;
    const G = window.WorkbenchGeometry;
    const exits = exitCandidates(data).length > 0;
    return (data.rooms || []).filter(room => room.points?.length >= 3).map(room => {
      const area = room.area || areaOf(room.points);
      const enemies = (data.enemies || []).filter(enemy => enemy.roomId === room.id);
      const objects = (data.objects || []).filter(object => object.floorId === room.floorId && object.points?.length && !['floor-finish', 'floor-inlay'].includes(object.kind) && pointInPoly(centerOf(object), room.points));
      const doors = (data.doors || []).filter(door => door.floorId === room.floorId && door.points?.length === 2 && room.points.some((p, i) => {
        const q = room.points[(i + 1) % room.points.length];
        const mid = [(door.points[0][0] + door.points[1][0]) / 2, (door.points[0][1] + door.points[1][1]) / 2];
        return G.segmentDistance(mid, p, q) <= .1;
      }));
      let exit = null;
      if (exits) {
        const field = exitField(room.floorId);
        if (field) {
          let sum = 0, count = 0, blocked = 0;
          const box = bboxOf(room);
          for (let j = 0; j < field.nz; j++) {
            const z = field.bounds.maxZ - (j + .5) * field.cell;
            if (z < box.minZ || z > box.maxZ) continue;
            for (let i = 0; i < field.nx; i++) {
              const x = field.bounds.minX + (i + .5) * field.cell;
              if (x < box.minX || x > box.maxX || !pointInPoly([x, z], room.points)) continue;
              const d = field.dist[j * field.nx + i];
              if (d === Infinity) blocked += 1;
              else if (d >= 0) { sum += d; count += 1; }
            }
          }
          exit = count ? sum / count : blocked ? Infinity : null;
        }
      }
      return {
        id: room.id, name: room.name || room.id, floor: floorName(room.floorId), kind: room.kind || '', area,
        enemies: enemies.length, elite: enemies.filter(enemy => enemy.tier !== 'normal').length,
        density: enemies.length / Math.max(1, area) * 100, objects: objects.length, doors: doors.length, exit,
      };
    });
  }

  function renderStats() {
    const data = state.data;
    const rows = roomRows();
    const { key, dir } = state.statsSort;
    rows.sort((a, b) => {
      const va = a[key], vb = b[key];
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return ((va ?? -1) - (vb ?? -1)) * dir;
    });
    const hasExit = rows.some(row => row.exit !== null);
    const columns = [['name', '房间'], ['floor', '楼层'], ['kind', '类型'], ['area', '面积 m²'], ['enemies', '敌人'], ['density', '密度 /100m²'], ['objects', '物件'], ['doors', '门'], ...(hasExit ? [['exit', '平均撤离 m']] : [])];
    const densities = rows.map(row => row.density).filter(value => value > 0).sort((a, b) => a - b);
    const hot = densities.length ? densities[Math.floor(densities.length * .85)] : Infinity;
    const cell = (row, column) => {
      const value = row[column];
      if (column === 'area') return num(value);
      if (column === 'density') return value ? `<span class="${value >= hot && row.enemies >= 3 ? 'hot' : ''}">${value.toFixed(1)}</span>` : '—';
      if (column === 'exit') return value === null ? '—' : value === Infinity ? '<span class="hot">到不了</span>' : num(value);
      if (column === 'enemies') return `${value}${row.elite ? `<small>（精英/Boss ${row.elite}）</small>` : ''}`;
      if (column === 'doors') return value ? value : '<span class="hot">0</span>';
      return esc(value);
    };
    const totalArea = rows.reduce((sum, row) => sum + row.area, 0);
    const enemies = data.enemies || [];
    const byType = new Map();
    for (const enemy of enemies) byType.set(enemy.enemyType || enemy.tier, (byType.get(enemy.enemyType || enemy.tier) || 0) + 1);
    const byKind = new Map();
    for (const row of rows) byKind.set(row.kind || '未分类', (byKind.get(row.kind || '未分类') || 0) + row.area);
    const bars = (map, total, unit) => [...map].sort((a, b) => b[1] - a[1])
      .map(([label, value]) => `<div class="wb-bar"><span title="${esc(label)}">${esc(label)}</span><i style="width:${(value / Math.max(1, ...map.values()) * 100).toFixed(1)}%"></i><span>${unit === '%' ? `${Math.round(value / total * 100)}%` : value}</span></div>`).join('');
    const tiers = ['normal', 'elite', 'boss'].map(tier => [tier, enemies.filter(enemy => enemy.tier === tier).length]);
    const metrics = window.WorkbenchGeometry.evaluateMapMetrics(data);
    const ueText = metrics.ue.preflight.missingStairBottom.length
      ? `缺 ${metrics.ue.preflight.missingStairBottom.length} 处楼梯朝向`
      : (metrics.ue.preflight.nonRectShapes.length ? `含 ${metrics.ue.preflight.nonRectShapes.length} 处非矩形拉伸` : '就绪');
    $('statsTitle').textContent = `统计 · ${data.meta?.title || state.key}`;
    $('statsBody').innerHTML = `<div class="wb-stats-summary">
        <div><b>${rows.length}</b>房间</div><div><b>${num(totalArea)} m²</b>房间总面积</div>
        <div><b>${enemies.length}</b>敌人（普通 ${tiers[0][1]} · 精英 ${tiers[1][1]} · Boss ${tiers[2][1]}）</div>
        <div><b>${(enemies.length / Math.max(1, totalArea) * 100).toFixed(2)}</b>平均敌人 /100m²</div>
        <div><b>${enemies.filter(enemy => enemy.branch === 'main').length} / ${enemies.filter(enemy => enemy.branch === 'optional').length}</b>主线 / 可选敌人</div>
        <div><b>${rows.filter(row => !row.doors).length}</b>没有门的房间</div>
        <div><b>${metrics.topology.loopCount}</b>拓扑环路（E−V+C）</div>
        <div><b>${Math.round(metrics.topology.deadEndRatio * 100)}%</b>无回报盲端率</div>
        <div><b>${metrics.progression.noDeadlock ? '无死锁' : `${metrics.progression.deadlockedLinks.length} 处死锁`}</b>机关可达校验</div>
        <div><b>${esc(ueText)}</b>UE 预检状态</div>
      </div>
      <div class="wb-stats-grid">
        <div class="wb-table-wrap"><table class="wb-stats-table"><thead><tr>${columns.map(([k, label]) => `<th data-sort="${k}" class="${k === key ? 'sorted' : ''}">${label}${k === key ? (dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(row => `<tr data-room="${esc(row.id)}">${columns.map(([k]) => `<td>${cell(row, k)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
        <div class="wb-stats-bars"><h3>敌人构成</h3>${bars(byType, enemies.length, 'n') || '<p class="wb-hint">没有敌人</p>'}<h3 style="margin-top:14px">面积占比（按房间类型）</h3>${bars(byKind, totalArea, '%')}</div>
      </div>
      <p class="wb-hint">点表头排序，点行定位到房间。红色：敌人密度在前 15% 且 ≥3 敌、没有门、或到不了出口。</p>`;
  }

  /* Plan style (architectural drawing). Walls come from the same merged runs and door
     cuts as the 3D view (map-geometry.js), drawn at true thickness but never thinner
     than ~2 px; open rooms (wallHeight 0) get a dashed outline instead. */
  function tint(hex, amount) {
    const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#e7dcc5';
    const rgb = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
    return `rgb(${rgb.map(c => Math.round(c + (255 - c) * amount)).join(',')})`;
  }

  const floorElevation = id => (state.data?.floors || []).find(floor => floor.id === id)?.elevation || 0;

  function planWalls(data) {
    const G = window.WorkbenchGeometry;
    const width = Math.max(.3, labelSize() * .14);
    let html = '';
    for (const floorId of unique((data.rooms || []).filter(room => floorMatches(room)).map(room => room.floorId))) {
      const rooms = (data.rooms || []).filter(room => room.floorId === floorId && room.points?.length >= 3);
      const doors = (data.doors || []).filter(door => door.floorId === floorId && door.points?.length === 2);
      for (const run of G.wallRuns(rooms, room => (Number.isFinite(room.wallHeight) ? room.wallHeight : 1))) {
        for (const [p, q] of G.wallSpans(run.a, run.b, doors)) {
          html += `<line class="wb-wall" x1="${p[0]}" y1="${-p[1]}" x2="${q[0]}" y2="${-q[1]}" stroke-width="${width.toFixed(3)}"/>`;
        }
      }
      for (const room of rooms) if (room.wallHeight === 0) html += `<polygon class="wb-wall-open" points="${svgPoint(room.points)}"/>`;
      for (const room of rooms) {
        for (const index of Array.isArray(room.openEdges) ? room.openEdges : []) {
          const a = room.points[index], b = room.points[(index + 1) % room.points.length];
          if (a && b) html += `<line class="wb-open-edge" x1="${a[0]}" y1="${-a[1]}" x2="${b[0]}" y2="${-b[1]}"/>`;
        }
      }
    }
    return `<g pointer-events="none">${html}</g>`;
  }

  // meta.proximity: connected pairs solid, near misses dashed (gap → distance, blocked → cross).
  function proximityOverlay(data) {
    const shownFloor = floorId => state.floor === 'all' || floorId === state.floor;
    const size = labelSize() * .5;
    let html = '';
    for (const rule of window.WorkbenchGeometry.proximityGraph(data, state.overrides)) {
      const nodes = new Map(rule.nodes.map(node => [node.id, node]));
      const line = (item, look) => {
        const a = nodes.get(item.a).anchor, b = nodes.get(item.b).anchor;
        if (!shownFloor(nodes.get(item.a).floorId) && !shownFloor(nodes.get(item.b).floorId)) return null;
        html += `<line class="${look}" x1="${a[0]}" y1="${-a[1]}" x2="${b[0]}" y2="${-b[1]}"/>`;
        return [(a[0] + b[0]) / 2, -(a[1] + b[1]) / 2];
      };
      for (const link of rule.links) line(link, 'wb-prox-link');
      for (const item of rule.near) {
        const mid = line(item, item.reason === 'gap' ? 'wb-prox-gap' : 'wb-prox-blocked');
        if (!mid) continue;
        if (item.reason === 'gap') {
          html += `<text class="wb-prox-text" x="${mid[0]}" y="${mid[1] - size * .3}" font-size="${size.toFixed(2)}" text-anchor="middle">${item.distance.toFixed(1)} m</text>`;
        } else {
          const r = size * .45;
          html += `<path class="wb-prox-cross" d="M${mid[0] - r} ${mid[1] - r}L${mid[0] + r} ${mid[1] + r}M${mid[0] - r} ${mid[1] + r}L${mid[0] + r} ${mid[1] - r}"/>`;
        }
      }
    }
    return `<g pointer-events="none">${html}</g>`;
  }

  // Plan anchor of an entity: door midpoint, object centre in its current state, else centre.
  function anchorOf(entity) {
    if (entity._type === 'door' && entity.points?.length >= 2) return [(entity.points[0][0] + entity.points[1][0]) / 2, (entity.points[0][1] + entity.points[1][1]) / 2];
    if (entity._type === 'object') {
      const current = currentOf(entity);
      return centerOf({ points: current.points?.length ? current.points : entity.points });
    }
    return centerOf(entity);
  }

  // links[]: one arrow per source → target; require "any" dashed. Selectable as the link.
  function linksOverlay(data, index) {
    let html = '';
    for (const link of data.links) {
      for (const sourceId of Array.isArray(link.from) ? link.from : []) {
        for (const target of Array.isArray(link.to) ? link.to : []) {
          const source = index.get(sourceId), goal = index.get(target?.id);
          if (!source || !goal || (!floorMatches(source) && !floorMatches(goal))) continue;
          const [a, b] = [anchorOf(source), anchorOf(goal)];
          const title = `<title>${esc(link.name || link.id)}</title>`;
          html += `<line class="wb-link${link.require === 'any' ? ' wb-link-any' : ''}" data-id="${esc(link.id)}" x1="${a[0]}" y1="${-a[1]}" x2="${b[0]}" y2="${-b[1]}" marker-end="url(#arrow-link)">${title}</line>`;
          html += `<line class="wb-link-hit" data-id="${esc(link.id)}" x1="${a[0]}" y1="${-a[1]}" x2="${b[0]}" y2="${-b[1]}">${title}</line>`;
        }
      }
    }
    return `<g>${html}</g>`;
  }

  // Footprints of the states an object is not in right now (absent states have none).
  function stateGhosts(data) {
    const size = labelSize() * .4;
    let html = '';
    for (const object of data.objects || []) {
      if (!Array.isArray(object.states) || !object.states.length || !floorMatches(object)) continue;
      const current = currentOf(object);
      for (const item of object.states) {
        if (item.id === current.stateId || item.present === false) continue;
        const pts = item.points || object.points;
        if (!pts?.length) continue;
        const [x, z] = centerOf({ points: pts });
        html += `<polygon class="wb-state-ghost" points="${svgPoint(pts)}"/><text class="wb-state-text" x="${x}" y="${-z}" font-size="${size.toFixed(2)}" text-anchor="middle" dominant-baseline="middle">${esc(item.name || item.id)}</text>`;
      }
    }
    return `<g pointer-events="none">${html}</g>`;
  }

  // State preview: overrides[id] = state id (objects) or open / closed (doors). Session only.
  function setObjectState(id, stateId) {
    state.overrides = { ...state.overrides, [id]: stateId };
    refreshStates();
  }

  function resetStates() {
    state.overrides = {};
    refreshStates();
  }

  function refreshStates() {
    render();
    inspect(state.selected);
    renderResetStates();
  }

  function renderResetStates() {
    const button = $('resetStatesBtn');
    if (button) button.hidden = !Object.keys(state.overrides).length;
  }

  // Door leaf + quarter-circle swing, hinged on the door's first point.
  function doorSwing(door, narrow) {
    const [a, b] = door.points;
    const A = [a[0], -a[1]], B = [b[0], -b[1]];
    const length = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (length < .05) return '';
    const w = Math.min(length, door.width || length);
    const u = [(B[0] - A[0]) / length, (B[1] - A[1]) / length], n = [-u[1], u[0]];
    const leaf = [A[0] + n[0] * w, A[1] + n[1] * w], jamb = [A[0] + u[0] * w, A[1] + u[1] * w];
    const sweep = n[0] * u[1] - n[1] * u[0] > 0 ? 1 : 0;
    return `<path class="wb-door-swing${narrow ? ' wb-door-narrow' : ''}" d="M${A} L${leaf} A${w} ${w} 0 0 ${sweep} ${jamb}" pointer-events="none"><title>${esc(door.name)} · ${num(door.width)}m</title></path>`;
  }

  // Treads across the run and an arrow pointing up the stair.
  function planStair(stair, box, data) {
    const G = window.WorkbenchGeometry;
    const roomsByFloor = new Map();
    for (const room of data.rooms || []) {
      if (!room.points?.length) continue;
      if (!roomsByFloor.has(room.floorId)) roomsByFloor.set(room.floorId, []);
      roomsByFloor.get(room.floorId).push(room);
    }
    const side = G.stairSide(stair, box, roomsByFloor, floorElevation);
    const up = floorElevation(stair.toFloorId) >= floorElevation(stair.fromFloorId) ? side.sign : -side.sign;
    const [lo, hi] = side.axis === 'x' ? [box.minX, box.maxX] : [box.minZ, box.maxZ];
    const [across1, across2] = side.axis === 'x' ? [box.minZ, box.maxZ] : [box.minX, box.maxX];
    const count = Math.max(3, Math.round((hi - lo) / .3));
    let html = `<g class="wb-hit" data-id="${esc(stair.id)}"><polygon class="wb-stair-plan" points="${svgPoint(stair.points)}"/>`;
    for (let k = 1; k < count; k++) {
      const t = lo + (hi - lo) * k / count;
      html += side.axis === 'x'
        ? `<line class="wb-tread" x1="${t}" y1="${-across1}" x2="${t}" y2="${-across2}"/>`
        : `<line class="wb-tread" x1="${across1}" y1="${-t}" x2="${across2}" y2="${-t}"/>`;
    }
    const mid = (across1 + across2) / 2;
    const [from, to] = up > 0 ? [lo + (hi - lo) * .12, hi - (hi - lo) * .12] : [hi - (hi - lo) * .12, lo + (hi - lo) * .12];
    html += side.axis === 'x'
      ? `<line class="wb-stair-arrow" x1="${from}" y1="${-mid}" x2="${to}" y2="${-mid}" marker-end="url(#arrow-stair)"/>`
      : `<line class="wb-stair-arrow" x1="${mid}" y1="${-from}" x2="${mid}" y2="${-to}" marker-end="url(#arrow-stair)"/>`;
    return `${html}<title>${esc(stair.name)} · ${esc(floorName(stair.fromFloorId))} → ${esc(floorName(stair.toFloorId))}</title></g>`;
  }

  function setStyle(style) {
    state.style = style === 'plan' ? 'plan' : 'schema';
    for (const [id, on] of [['styleSchemaBtn', state.style === 'schema'], ['stylePlanBtn', state.style === 'plan']]) {
      $(id).classList.toggle('active', on);
      $(id).setAttribute('aria-pressed', String(on));
    }
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (state.style === 'plan') params.set('style', 'plan'); else params.delete('style');
    history.replaceState(null, '', `${location.pathname}${location.search}#${params}`);
    render();
  }

  function renderLegend() {
    const data = state.data;
    if (!data) return;
    const routes = unique((data.routes || []).map(route => route.kind));
    const routeColors = { main: '#a34f40', optional: '#b58a3c', exit: '#2d7c78', secret: '#7d5a8a' };
    const routeLabels = { main: '主线', optional: '可选', exit: '离场', secret: '暗线' };
    let html = '<span><i style="background:#e7dcc5;border:1px solid #6b5b45"></i>房间</span>';
    for (const kind of routes) html += `<span><i style="background:${routeColors[kind] || '#a34f40'}"></i>${routeLabels[kind] || esc(kind)}</span>`;
    if (data.enemies?.some(e => e.tier === 'normal')) html += '<span><i class="dot" style="background:#b7524b"></i>普通</span>';
    if (data.enemies?.some(e => e.tier === 'elite')) html += '<span><i class="diamond" style="background:#a55c30"></i>精英</span>';
    if (data.enemies?.some(e => e.tier === 'boss')) html += '<span><i class="dot" style="background:#805394"></i>Boss</span>';
    if (data.water?.length) html += '<span><i style="background:#6fa6a0;height:6px"></i>水面</span>';
    if (data.objects?.some(o => o.kind === 'loot')) html += '<span><i class="dot" style="background:#d8b453"></i>资源 L</span>';
    if (data.objects?.some(o => o.kind === 'combat-space')) html += '<span><i style="background:#73a78b;height:3px"></i>战斗留白</span>';
    if (state.layers.issues && state.validation && [...state.validation.errors, ...state.validation.warnings].some(item => item.id)) html += '<span><i class="dot" style="background:#fff6df;border:1px solid #8a611f"></i>问题</span>';
    if (state.layers.clearance && playerRadius() > 0) html += `<span><i style="background:#a34f4033;height:6px"></i>通行宽度 ${num(playerRadius() * 2)}m</span>`;
    if (state.layers.exits) html += '<span title="沿可走区域、只穿过门的步行距离；灰色 = 走不到任何出口"><i class="wb-dist-swatch"></i>撤离距离 近→远</span><span><i class="dot" style="background:#8c8c8c"></i>到不了出口</span>';
    if (state.layers.heat) html += '<span title="同压力曲线公式，但计入全部敌人（含可选支线），按本层最大值归一"><i class="wb-heat-swatch"></i>压力热力 低→高</span>';
    $('legend').innerHTML = html;
  }

  function renderMapMeta() {
    const data = state.data;
    if (!data) return;
    const b = boundsOf(data, state.floor);
    $('mapMeta').innerHTML = `${esc(data.meta?.title || '未命名')} · ${num(b.maxX - b.minX)}×${num(b.maxZ - b.minZ)}m · ${esc(state.floor === 'all' ? '全部楼层' : floorName(state.floor))}${state.mode === '3d' ? ' · 3D 块面' : ''}`;
  }

  function renderMapHead() {
    const data = state.data;
    if (!data) return;
    $('mapTitle').textContent = data.meta?.title || '未命名地图';
    const diskEntry = state.desktopFiles.get(state.key);
    const subtitle = data.meta?.subtitle || data.meta?.concept || '';
    $('mapSubtitle').textContent = diskEntry ? [subtitle, diskEntry.filePath].filter(Boolean).join(' · ') : subtitle;
    const badges = [];
    if (data.meta?.provenance?.label) badges.push(data.meta.provenance.label);
    if (data.floors?.length) badges.push(`${data.floors.length} 层`);
    if (data.meta?.player) badges.push(`玩家 ${data.meta.player.radius} m`);
    let html = badges.map(item => `<span>${esc(item)}</span>`).join('');
    if (desktop && diskEntry) {
      html += `<button type="button" id="desktopWatchChip" class="wb-badge-watch${state.desktopWatch ? ' active' : ''}" title="点击切换自动监听热重载">${state.desktopWatch ? '监听热重载' : '监听已暂停'}</button>`;
    }
    $('mapBadges').innerHTML = html;
    const watchChip = $('desktopWatchChip');
    if (watchChip) {
      watchChip.onclick = () => desktop.setWatchEnabled(!state.desktopWatch);
    }
  }

  function renderSummary() {
    const data = state.data;
    if (!data) return;
    const rooms = data.rooms?.length || 0;
    const enemies = data.enemies?.length || 0;
    const main = (data.routes || []).find(route => route.kind === 'main');
    const length = data.meta?.mainLength || (main ? routeLength(main.points || []) : 0);
    const area = data.meta?.area || (data.rooms || []).reduce((sum, room) => sum + areaOf(room.points || []), 0);
    $('summary').innerHTML = [
      [rooms, '房间'], [enemies, '敌人'],
      [`${num(length)} m`, '主线'], [`${num(area)} m²`, '面积'],
    ].map(([value, label]) => `<div><b>${esc(value)}</b><span>${label}</span></div>`).join('');
  }

  function renderLevels() {
    const data = state.data;
    if (!data) return;
    const floors = [...(data.floors || [])].sort((a, b) => a.elevation - b.elevation);
    $('levelsPanel').innerHTML = floors.map(floor => (
      `<button type="button" data-level="${esc(floor.id)}" class="${state.floor === floor.id ? 'active' : ''}"><b>${esc(floor.name)}</b><span>${esc(floor.note || `${num(floor.elevation)} m`)}</span></button>`
    )).join('') || '<p class="wb-hint">无楼层信息</p>';
    $('levelsPanel').querySelectorAll('[data-level]').forEach(button => {
      button.onclick = () => {
        state.floor = button.dataset.level;
        renderFloors();
        renderLevels();
        fit();
      };
    });
  }

  function renderDesignNotes() {
    const notes = Array.isArray(state.data?.meta?.designNotes) ? state.data.meta.designNotes : [];
    $('designNotes').innerHTML = notes.length ? notes.map(note => `<p>${esc(note)}</p>`).join('') : '<p>暂无设计说明</p>';
  }

  function renderPacing() {
    const data = state.data;
    const panel = $('pacingPanel');
    if (!data || !window.ViewerPacing || !(data.routes || []).length || !(data.enemies || []).length) {
      panel.hidden = true;
      return;
    }
    const weights = {};
    for (const enemy of data.enemies) {
      weights[enemy.enemyType] = enemy.tier === 'boss' ? 6 : enemy.tier === 'elite' ? 3 : 1;
    }
    const pacing = data.meta?.pacing || {};
    const m = window.ViewerPacing.compute({
      routes: data.routes, enemies: data.enemies, rooms: data.rooms || [], floors: data.floors || [],
      weights: pacing.weights || weights,
      lambda: pacing.lambda || 5.5,
      aggro: pacing.aggro || 8,
      step: pacing.step || 1,
    });
    if (!m) {
      panel.hidden = true;
      state.pacing = null;
      return;
    }
    panel.hidden = false;
    $('pacingSummary').textContent = `主线 ${m.L.toFixed(0)} m · 敌 ${m.mainCount}+${m.optionalCount} · 峰值 ${m.peak.v.toFixed(2)}@${m.peak.s.toFixed(0)}m`;
    const followsHeight = data.floors?.length > 1 && m.route.some(point => Number.isFinite(point[2]));
    $('pacingNote').textContent = followsHeight
      ? '敌情压力按主线路点标高和同层敌人估算，约 0.65 m 内视为同层。机关、解谜等非战斗压力可写进批注。'
      : '压力按主线附近敌人的距离递减，是静态摆位估算。';
    const W = 1000, H = 150, padL = 42, padR = 12, padT = 18, padB = 22;
    const pw = W - padL - padR, ph = H - padT - padB;
    const pmax = m.peak.v * 1.16 || 1;
    const X = value => padL + (value / Math.max(1, m.L)) * pw;
    const Y = value => padT + (1 - value / pmax) * ph;
    let svg = '';
    for (const band of m.bands || []) {
      const room = (data.rooms || []).find(item => item.id === band.room);
      svg += `<rect x="${X(band.a).toFixed(1)}" y="${padT}" width="${Math.max(0, X(band.b) - X(band.a)).toFixed(1)}" height="${ph}" fill="${esc(room?.color || '#e9e3d4')}" opacity=".5"/>`;
    }
    svg += `<line x1="${padL}" y1="${Y(m.restThreshold).toFixed(1)}" x2="${W - padR}" y2="${Y(m.restThreshold).toFixed(1)}" stroke="#b58a3c" stroke-width="1" stroke-dasharray="5 4"/>`;
    svg += `<polyline points="${m.samples.map(sample => `${X(sample.s).toFixed(1)},${Y(sample.p).toFixed(1)}`).join(' ')}" class="wb-pace-curve"/>`;
    const peakX = X(m.peak.s), peakY = Y(m.peak.v);
    svg += `<circle cx="${peakX.toFixed(1)}" cy="${peakY.toFixed(1)}" r="3.2" fill="#a34f40"/>`;
    svg += `<text class="wb-pace-peak" x="${Math.min(W - 90, peakX + 7).toFixed(1)}" y="${Math.max(12, peakY - 6).toFixed(1)}" font-size="10" fill="#a34f40">峰值 ${m.peak.v.toFixed(2)} @ ${m.peak.s.toFixed(0)}m</text>`;
    svg += `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" class="wb-pace-axis"/>`;
    svg += `<text x="${padL}" y="${H - 6}" font-size="10" class="wb-pace-tick">0</text><text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="10" class="wb-pace-tick">${m.L.toFixed(0)} m</text>`;
    svg += `<g id="paceHover" pointer-events="none"></g><rect class="wb-pace-hit" x="${padL}" y="0" width="${pw}" height="${H}" fill="transparent"/>`;
    $('pacingChart').innerHTML = svg;
    state.pacing = { m, X, Y, padL, pw, W, H, padT, padB, aggro: pacing.aggro || 8, profile: routeProfile(data) };
    state.paceCursor = null;
  }

  /* Pressure heatmap: the pacing formula (weight × exp(−d/λ)) evaluated over the whole
     floor instead of along the route, coloured only inside rooms. Unlike the curve it
     counts every enemy (main and optional): it answers "where is it dangerous". */
  const HEAT_STOPS = [[255, 236, 160], [244, 170, 70], [214, 84, 52], [128, 28, 46]];
  const heatCache = new Map();

  function heatWeights(data) {
    const pacing = data.meta?.pacing || {};
    return enemy => pacing.weights?.[enemy.enemyType] ?? (enemy.tier === 'boss' ? 6 : enemy.tier === 'elite' ? 3 : 1);
  }

  function heatField(floorId) {
    const data = state.data;
    const key = `${state.key}|${floorId}`;
    if (heatCache.has(key)) return heatCache.get(key);
    const onFloor = entity => floorId === 'all' || entity.floorId === floorId;
    const enemies = (data.enemies || []).filter(enemy => enemy.center && onFloor(enemy));
    const rooms = (data.rooms || []).filter(room => room.points?.length >= 3 && onFloor(room))
      .map(room => ({ points: room.points, box: bboxOf(room) }));
    if (!enemies.length || !rooms.length) {
      heatCache.set(key, null);
      return null;
    }
    const lambda = data.meta?.pacing?.lambda || 5.5;
    const weight = heatWeights(data);
    const b = boundsOf(data, floorId);
    const cell = Math.max(.4, Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 180);
    const nx = Math.ceil((b.maxX - b.minX) / cell), nz = Math.ceil((b.maxZ - b.minZ) / cell);
    const values = new Float32Array(nx * nz).fill(-1);
    let max = 0;
    for (let j = 0; j < nz; j++) {
      const z = b.maxZ - (j + .5) * cell; // row 0 is the north edge (top of the image)
      for (let i = 0; i < nx; i++) {
        const x = b.minX + (i + .5) * cell;
        if (!rooms.some(room => x >= room.box.minX && x <= room.box.maxX && z >= room.box.minZ && z <= room.box.maxZ && pointInPoly([x, z], room.points))) continue;
        let p = 0;
        for (const enemy of enemies) p += weight(enemy) * Math.exp(-Math.hypot(x - enemy.center[0], z - enemy.center[1]) / lambda);
        values[j * nx + i] = p;
        if (p > max) max = p;
      }
    }
    const canvas = paintField(values, nx, nz, value => {
      const t = value < 0 ? 0 : value / (max || 1);
      return t < .04 ? null : rampColor(HEAT_STOPS, t, 255 * (.2 + .55 * t));
    });
    const field = { canvas, url: canvas.toDataURL(), bounds: { minX: b.minX, maxX: b.minX + nx * cell, minZ: b.maxZ - nz * cell, maxZ: b.maxZ }, max, cell };
    heatCache.set(key, field);
    return field;
  }

  // Colour a grid (row 0 = north) into a canvas; colorOf returns [r, g, b, a] or null.
  function paintField(values, nx, nz, colorOf) {
    const canvas = document.createElement('canvas');
    canvas.width = nx;
    canvas.height = nz;
    const context = canvas.getContext('2d');
    const image = context.createImageData(nx, nz);
    for (let k = 0; k < values.length; k++) {
      const rgba = colorOf(values[k]);
      if (rgba) image.data.set(rgba, k * 4);
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  function rampColor(stops, t, alpha) {
    const f = Math.max(0, Math.min(.999, t)) * (stops.length - 1), lo = Math.floor(f), mix = f - lo;
    return [0, 1, 2].map(c => stops[lo][c] + (stops[lo + 1][c] - stops[lo][c]) * mix).concat(alpha);
  }

  /* Extraction distance: walking distance from every walkable spot to the nearest exit,
     per floor (map-geometry.js: rooms only connect through doors, solid objects block).
     Exits are auto-detected — exit-route end points, kind extract/exit, names like
     "E1 …" or containing 撤离点/撤离标记/出口 — and can be switched off in the side panel. */
  const EXIT_NAME = /(^|[\s·|])E\d+(?=$|[\s·|])|撤离点|撤离标记|出口/;
  const EXIT_KINDS = ['extract', 'extraction', 'exit'];
  const DIST_STOPS = [[96, 186, 152], [232, 220, 120], [222, 140, 76], [118, 64, 124]];
  const exitCache = new Map();

  function exitCandidates(data) {
    const list = [];
    for (const route of data.routes || []) {
      if (route.kind !== 'exit' || !route.points?.length) continue;
      const end = route.points[route.points.length - 1];
      list.push({ key: `route:${route.id}`, id: route.id, label: `${route.name || route.id} · 终点`, floorId: route.floorId, source: { point: [end[0], end[1]] }, why: '离场路线' });
    }
    const things = [...(data.rooms || []).map(e => ({ ...e, _type: 'room' })), ...(data.objects || []).map(e => ({ ...e, _type: 'object' }))];
    for (const entity of things) {
      if (!entity.points?.length || entity.kind === 'sign') continue;
      const byKind = EXIT_KINDS.includes(String(entity.kind || '').toLowerCase());
      if (!byKind && !EXIT_NAME.test(entity.name || '')) continue;
      list.push({ key: `${entity._type}:${entity.id}`, id: entity.id, label: entity.name || entity.id, floorId: entity.floorId, source: { points: entity.points }, why: byKind ? `kind ${entity.kind}` : '名称' });
    }
    return list;
  }

  const visibleFloorIds = () => (state.floor === 'all' ? (state.data.floors || []).map(floor => floor.id) : [state.floor]);
  const activeExits = () => exitCandidates(state.data).filter(candidate => !state.exitOff.has(candidate.key));

  /* Fields for every floor at once: stairs are portals, so a floor without an exit is
     still reachable through them. Each pass hands every stair the best distance at its
     footprint on one floor (+ stair length) as a seed for the other floor; repeat until
     nothing improves (distances only shrink, so this settles within a few passes). */
  function exitFields() {
    const data = state.data;
    const active = activeExits();
    const key = `${state.key}|${active.map(candidate => candidate.key).join(',')}`;
    if (exitCache.has(key)) return exitCache.get(key);
    const G = window.WorkbenchGeometry;
    const floorIds = (data.floors || []).length ? data.floors.map(floor => floor.id) : [undefined];
    const elevation = id => (data.floors || []).find(floor => floor.id === id)?.elevation || 0;
    const compute = (floorId, portals) => {
      const rooms = (data.rooms || []).filter(room => room.points?.length >= 3 && room.floorId === floorId);
      if (!rooms.length) return null;
      const b = boundsOf(data, floorId);
      const exits = active.filter(candidate => candidate.floorId === floorId);
      const field = G.distanceField({
        rooms,
        doors: (data.doors || []).filter(door => door.floorId === floorId),
        solids: (data.objects || []).filter(object => blocksWalking(object) && object.floorId === floorId && object.points?.length >= 3),
        sources: [...exits.map(candidate => candidate.source), ...portals],
        bounds: b,
        cell: Math.max(.4, Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 180),
      });
      return Object.assign(field, { exits: exits.length, portals: portals.length });
    };
    let portals = new Map(), fields = new Map();
    for (let pass = 0; pass <= floorIds.length + 1; pass++) {
      fields = new Map(floorIds.map(floorId => [floorId, compute(floorId, portals.get(floorId) || [])]));
      const next = new Map();
      for (const stair of data.stairs || []) {
        if (!stair.points?.length) continue;
        const box = bboxOf(stair);
        const length = Math.max(box.maxX - box.minX, box.maxZ - box.minZ) + Math.abs(elevation(stair.toFloorId) - elevation(stair.fromFloorId));
        for (const [a, b] of [[stair.fromFloorId, stair.toFloorId], [stair.toFloorId, stair.fromFloorId]]) {
          const field = fields.get(a);
          const d = field ? G.minInPolygon(field, stair.points) : Infinity;
          if (d === Infinity || !fields.get(b)) continue;
          if (!next.has(b)) next.set(b, []);
          next.get(b).push({ points: stair.points, d: d + length });
        }
      }
      const signature = map => JSON.stringify([...map].map(([floorId, list]) => [floorId, list.map(item => Math.round(item.d * 10))]));
      if (signature(next) === signature(portals)) break;
      portals = next;
    }
    // One colour scale across floors so the same colour means the same distance everywhere.
    const globalMax = Math.max(1, ...[...fields.values()].filter(Boolean).map(field => field.max));
    for (const field of fields.values()) {
      if (!field) continue;
      field.canvas = paintField(field.dist, field.nx, field.nz, value => {
        if (value < 0) return null;
        if (value === Infinity) return [140, 140, 140, 165];
        return rampColor(DIST_STOPS, value / globalMax, 150);
      });
      field.url = field.canvas.toDataURL();
    }
    exitCache.set(key, fields);
    return fields;
  }

  const exitField = floorId => exitFields().get(floorId) || null;

  function renderExitPanel() {
    const panel = $('exitPanel');
    panel.hidden = !state.layers.exits || !state.data;
    if (panel.hidden) return;
    const candidates = exitCandidates(state.data);
    const walk = Number(state.data.meta?.player?.walkSpeed) > 0 ? Number(state.data.meta.player.walkSpeed) : 4;
    let html = `<h3>撤离点（${candidates.length - candidates.filter(c => state.exitOff.has(c.key)).length}/${candidates.length}）</h3>`;
    html += candidates.map(candidate => `<label><input type="checkbox" data-exit="${esc(candidate.key)}" ${state.exitOff.has(candidate.key) ? '' : 'checked'}><button type="button" data-exit-locate="${esc(candidate.id)}" title="${esc(candidate.label)}">${esc(candidate.label)}</button><small>${esc(candidate.why)}</small></label>`).join('');
    if (!candidates.length) html += '<p>没识别到出口。在地图里给撤离点写 <code>objects[].kind: "extract"</code>，或加 <code>kind: "exit"</code> 的路线。</p>';
    const lines = visibleFloorIds().map(floorId => {
      const field = exitField(floorId);
      if (!field) return '';
      const share = field.walkable ? Math.round(field.unreachable / field.walkable * 100) : 0;
      const name = (state.data.floors || []).length > 1 ? `${floorName(floorId)}：` : '';
      if (!field.exits && !field.portals) return `<p>${esc(name)}本层没有出口，也没有楼梯通到能撤离的楼层。</p>`;
      return `<p>${esc(name)}最远 ${num(field.max)} m（≈ ${Math.round(field.max / walk)} s，步速 ${num(walk)} m/s）${share ? ` · <b style="color:var(--danger)">${share}% 可走区域到不了出口</b>` : ''}</p>`;
    }).join('');
    panel.innerHTML = html + lines;
  }

  // Readout under the cursor while the distance layer is on.
  function showDistanceTip(event) {
    const tip = $('mapTip');
    if (!state.layers.exits || state.mode !== '2d' || state.drag?.moved) {
      tip.hidden = true;
      return;
    }
    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform($('map').getScreenCTM().inverse());
    const [x, z] = [local.x, -local.y];
    let d = null;
    for (const floorId of visibleFloorIds()) {
      const field = exitField(floorId);
      const value = field ? window.WorkbenchGeometry.sampleField(field, x, z) : null;
      if (value !== null) { d = value; break; }
    }
    if (d === null) {
      tip.hidden = true;
      return;
    }
    const walk = Number(state.data.meta?.player?.walkSpeed) > 0 ? Number(state.data.meta.player.walkSpeed) : 4;
    tip.textContent = d === Infinity ? '到不了任何出口（检查门或出口）' : `到最近出口 ${num(d)} m · 约 ${Math.round(d / walk)} s`;
    const rect = $('canvasWrap').getBoundingClientRect();
    tip.style.left = `${Math.min(rect.width - 190, event.clientX - rect.left + 14)}px`;
    tip.style.top = `${event.clientY - rect.top + 14}px`;
    tip.hidden = false;
  }

  /* Pacing chart ↔ map. Hovering the chart marks that point of the main route on the
     2D map and in 3D (with the aggro ring and the enemies inside it); clicking moves
     the view there. Samples come from viewer-pacing.js, so this matches the curve. */
  // Elevation along main(+exit) route by distance, so the 3D marker sits on the right floor.
  function routeProfile(data) {
    const elevation = id => (data.floors || []).find(floor => floor.id === id)?.elevation || 0;
    const main = (data.routes || []).find(route => route.kind === 'main') || (data.routes || [])[0];
    const exit = (data.routes || []).find(route => route.kind === 'exit');
    if (!main?.points) return [];
    const points = [
      ...main.points.map(p => [p[0], p[1], Number.isFinite(p[2]) ? p[2] : elevation(main.floorId)]),
      ...(exit ? exit.points.slice(1).map(p => [p[0], p[1], Number.isFinite(p[2]) ? p[2] : elevation(exit.floorId)]) : []),
    ];
    let s = 0;
    return points.map((p, index) => {
      if (index) s += Math.hypot(p[0] - points[index - 1][0], p[1] - points[index - 1][1]);
      return { s, y: p[2] };
    });
  }

  function elevationAt(profile, s) {
    if (!profile.length) return 0;
    for (let i = 1; i < profile.length; i++) {
      if (s <= profile[i].s) {
        const a = profile[i - 1], b = profile[i];
        return a.y + (b.y - a.y) * ((s - a.s) / Math.max(1e-6, b.s - a.s));
      }
    }
    return profile[profile.length - 1].y;
  }

  function paceSampleAt(clientX, clientY) {
    const chart = $('pacingChart');
    const pace = state.pacing;
    if (!pace || !chart.getScreenCTM()) return null;
    const local = new DOMPoint(clientX, clientY).matrixTransform(chart.getScreenCTM().inverse());
    const s = Math.max(0, Math.min(pace.m.L, (local.x - pace.padL) / pace.pw * pace.m.L));
    let best = pace.m.samples[0];
    for (const sample of pace.m.samples) if (Math.abs(sample.s - s) < Math.abs(best.s - s)) best = sample;
    return best;
  }

  function setPaceCursor(sample) {
    const pace = state.pacing;
    state.paceCursor = sample && pace ? { ...sample, y: sample.y ?? elevationAt(pace.profile, sample.s) } : null;
    const hover = $('paceHover');
    $('pacingChart').classList.toggle('hovering', !!state.paceCursor);
    if (hover) {
      const c = state.paceCursor;
      if (!c) hover.innerHTML = '';
      else {
        const x = pace.X(c.s), y = pace.Y(c.p);
        const room = c.room ? (state.data.rooms || []).find(item => item.id === c.room) : null;
        const text = `${c.s.toFixed(0)} m · 压力 ${c.p.toFixed(2)} · ${pace.aggro}m 内 ${c.n} 敌${room ? ` · ${room.short || room.name}` : ''}`;
        const tx = x > pace.W - 230 ? x - 8 : x + 8;
        hover.innerHTML = `<line x1="${x.toFixed(1)}" y1="${pace.padT}" x2="${x.toFixed(1)}" y2="${pace.H - pace.padB}" class="wb-pace-hover-line"/>`
          + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="wb-pace-hover-dot"/>`
          + `<text x="${tx.toFixed(1)}" y="${pace.padT + 10}" font-size="11" text-anchor="${tx < x ? 'end' : 'start'}" class="wb-pace-label">${esc(text)}</text>`;
      }
    }
    paintPaceCursor();
    view3d?.setCursor(state.paceCursor ? [state.paceCursor.x, state.paceCursor.z, state.paceCursor.y] : null, pace?.aggro || 8);
  }

  // 2D marker; redrawn after every render() because render replaces the SVG contents.
  function paintPaceCursor() {
    const svg = $('map');
    svg.querySelector('#wbPaceCursor')?.remove();
    const c = state.paceCursor;
    if (!c || !state.data) return;
    const aggro = state.pacing?.aggro || 8;
    const near = c.nearby.filter(floorMatches);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.id = 'wbPaceCursor';
    g.setAttribute('pointer-events', 'none');
    g.innerHTML = `<circle class="wb-pace-ring" cx="${c.x}" cy="${-c.z}" r="${aggro}"/>`
      + near.map(enemy => `<circle class="wb-pace-enemy" cx="${enemy.center[0]}" cy="${-enemy.center[1]}" r="1.1"/>`).join('')
      + `<circle class="wb-pace-dot" cx="${c.x}" cy="${-c.z}" r="${(labelSize() * .45).toFixed(2)}"/>`;
    svg.appendChild(g);
  }

  // Click on the chart: bring that route point to the middle of the 2D map / 3D view.
  function centerOnPace() {
    const c = state.paceCursor;
    if (!c) return;
    if (state.mode === '3d') {
      view3d?.lookAt([c.x, c.z, c.y]);
      return;
    }
    const from = { ...state.view };
    state.view.x = c.x - state.view.w / 2;
    state.view.y = -c.z - state.view.h / 2;
    glideFrom(from);
  }

  function renderMapList() {
    const keys = Object.keys(maps);
    $('mapCount').textContent = `${keys.length} 张`;
    if (!keys.length) {
      $('mapList').innerHTML = '<p class="wb-hint wb-map-empty">还没有地图，点下方「打开 JSON」或拖入地图文件。</p>';
      return;
    }
    $('mapList').innerHTML = keys.map(key => {
      const data = maps[key];
      const rooms = data.rooms?.length || 0;
      const enemies = data.enemies?.length || 0;
      const fullTitle = data.meta?.title || key;
      const shortTitle = fullTitle;
      const btn = `<button type="button" data-map="${esc(key)}" class="${desktop ? '' : (key === state.key ? 'active' : '')}" title="${esc(fullTitle)}"><b>${esc(shortTitle)}</b><small>${rooms} 房 · ${enemies} 敌</small></button>`;
      return desktop
        ? `<div class="wb-map-row${key === state.key ? ' active' : ''}">${btn}<button type="button" class="wb-map-del" data-remove-map="${esc(key)}" title="从列表移除（不删原文件）" aria-label="移除 ${esc(shortTitle)}">×</button></div>`
        : btn;
    }).join('');
    $('mapList').querySelectorAll('[data-map]').forEach(button => {
      button.onclick = () => {
        const diskEntry = state.desktopFiles.get(button.dataset.map);
        if (desktop && diskEntry) openDesktopFilePath(diskEntry.filePath);
        else loadMap(button.dataset.map);
      };
    });
    $('mapList').querySelectorAll('[data-remove-map]').forEach(button => {
      button.onclick = event => {
        event.stopPropagation();
        removeDesktopMap(button.dataset.removeMap);
      };
    });
  }

  function renderLayers() {
    const box = ([key, label]) => `<label><input type="checkbox" data-layer="${key}" ${state.layers[key] ? 'checked' : ''}>${label}</label>`;
    const group = (title, list) => `<div class="wb-layer-group"><h3>${title}</h3><div class="wb-layers">${list.map(box).join('')}</div></div>`;
    $('layerList').innerHTML = group('基础', LAYERS.filter(([key]) => !ANALYSIS_LAYERS.has(key))) + group('分析', LAYERS.filter(([key]) => ANALYSIS_LAYERS.has(key)));
    $('layerList').querySelectorAll('input').forEach(input => {
      input.onchange = () => {
        state.layers[input.dataset.layer] = input.checked;
        render();
        renderExitPanel();
        if (!state.layers.exits) $('mapTip').hidden = true;
      };
    });
  }

  function renderFloors() {
    const bar = $('floorBar');
    const floors = state.data?.floors || [];
    const options = [{ id: 'all', name: '全部' }, ...floors];
    const sig = options.map(floor => `${floor.id}:${floor.name || floor.id}`).join('|');
    if (bar.dataset.floorSig !== sig || !bar.querySelector('[data-floor]')) {
      bar.dataset.floorSig = sig;
      bar.innerHTML = options.map(floor => `<button type="button" data-floor="${esc(floor.id)}" class="${state.floor === floor.id ? 'active' : ''}" aria-pressed="${state.floor === floor.id}">${esc(floor.name || floor.id)}</button>`).join('');
      bar.querySelectorAll('[data-floor]').forEach(button => {
        button.onclick = () => {
          state.floor = button.dataset.floor;
          renderFloors();
          renderLevels();
          fit();
        };
      });
      return;
    }
    bar.querySelectorAll('[data-floor]').forEach(button => {
      const active = button.dataset.floor === state.floor;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  // meta.kindLegend entry for an object kind / enemy type: { label, note } or null.
  const kindLegendOf = kind => {
    const entry = state.data?.meta?.kindLegend?.[kind];
    return entry && typeof entry === 'object' && entry.label ? entry : null;
  };

  function typeLabel(type) {
    return ({ room: '房间', object: '物件', enemy: '敌人', door: '门', route: '路线', stairs: '楼梯', water: '水面', link: '连接' })[type] || type;
  }

  function inspect(id) {
    const entity = id ? indexData(state.data).get(id) : null;
    if (!entity) {
      $('inspector').innerHTML = '<p class="wb-hint">点击地图上的房间、物件、敌人、路线或门查看详情。</p>';
      return;
    }
    if ($('inspectorPanel')) $('inspectorPanel').open = true;
    const pairs = [
      ['类型', typeLabel(entity._type)],
      ['ID', entity.id],
    ];
    if (entity._type !== 'link') pairs.push(['楼层', floorName(entity.floorId)]);
    const add = (key, value) => { if (value !== undefined && value !== null && value !== '') pairs.push([key, value]); };
    const addHtml = (key, html) => { if (html) pairs.push([key, html, true]); };
    const index = indexData(state.data);
    const jump = (id, label) => `<button type="button" class="wb-link-jump" data-jump="${esc(id)}">${esc(label ?? index.get(id)?.name ?? id)}</button>`;
    add('状态', ({existing:'已落地', planned:'设计预设', annotation:'示意标注'})[entity.status] || entity.status);
    if (entity._type === 'room') {
      add('节拍', entity.beat);
      add('面积', `${(entity.area || areaOf(entity.points || [])).toFixed(1)} m²`);
      if (entity.wallHeight !== undefined) add('墙高', entity.wallHeight === 0 ? '0（开放/露天）' : `${num(entity.wallHeight)} m`);
      add('敌人', `${(state.data.enemies || []).filter(e => e.roomId === entity.id).length} 个`);
      add('物件', `${(state.data.objects || []).filter(o => o.floorId === entity.floorId && o.points && pointInPoly(centerOf(o), entity.points)).length} 个`);
      add('职责', entity.role);
      add('预设', entity.preset);
      add('动线', entity.flow);
      add('备注', entity.note);
    } else if (entity._type === 'enemy') {
      const legend = kindLegendOf(entity.enemyType);
      add('类型', legend ? `${legend.label}（${entity.enemyType}）` : entity.enemyType);
      if (legend) add('说明', legend.note);
      add('等级', entity.tier);
      add('分支', entity.branch === 'optional' ? '可选' : '主线');
      add('房间', state.data.rooms?.find(room => room.id === entity.roomId)?.name || entity.roomId);
      add('生命', entity.hp);
      add('移速', entity.speed ? `${entity.speed} m/s` : '');
      add('机制', entity.mechanic);
      add('备注', entity.note);
    } else if (entity._type === 'route') {
      add('路线', entity.kind);
      add('长度', `${(entity.length || routeLength(entity.points || [])).toFixed(1)} m`);
      add('点数', `${(entity.points || []).length}`);
      const heights = (entity.points || []).filter(p => Number.isFinite(p[2])).map(p => p[2]);
      if (heights.length) add('标高', `${num(Math.min(...heights))} → ${num(Math.max(...heights))} m（跨层）`);
      add('备注', entity.note);
    } else if (entity._type === 'door') {
      add('宽度', `${num(entity.width)} m${playerRadius() > 0 ? ` · 玩家直径 ${num(playerRadius() * 2)} m` : ''}`);
      const now = doorState(entity);
      addHtml('初始状态', `${entity.initial === 'closed' ? '关' : '开'} <span class="wb-state-buttons">${[['open', '开'], ['closed', '关']].map(([value, label]) =>
        `<button type="button" data-set-state="${esc(entity.id)}" data-state="${value}" class="${now === value ? 'active' : ''}">${label}</button>`).join('')}</span>`);
      if (Number.isFinite(entity.height)) add('门洞高', `${num(entity.height)} m`);
      add('备注', entity.note);
    } else if (entity._type === 'stairs') {
      add('连接', `${floorName(entity.fromFloorId)} → ${floorName(entity.toFloorId)}`);
      add('方向', entity.direction === 'down' ? '下行' : '上行');
      add('低端', ({ N: '北侧', S: '南侧', E: '东侧', W: '西侧' })[entity.bottom] || (entity.bottom ? entity.bottom : '未标注（3D 推测）'));
      add('备注', entity.note);
    } else if (entity._type === 'water') {
      add('水面', entity.kind || 'water');
      add('备注', entity.note);
    } else if (entity._type === 'object') {
      const legend = kindLegendOf(entity.kind);
      add('物件', legend ? `${legend.label}（${entity.kind}）` : entity.kind);
      if (legend) add('说明', legend.note);
      add('阻挡', entity.solid ? '是' : '否');
      if (entity.baseHeight !== undefined) add('离地', `${num(entity.baseHeight)} m`);
      if (entity.walkable !== undefined) add('可站人', entity.walkable ? '是' : '否');
      if (Array.isArray(entity.states) && entity.states.length) {
        const initial = entity.initialState ?? entity.states[0].id;
        const now = currentOf(entity).stateId;
        addHtml('状态', `<span class="wb-state-buttons">${entity.states.map(item =>
          `<button type="button" data-set-state="${esc(entity.id)}" data-state="${esc(item.id)}" class="${item.id === now ? 'active' : ''}">${esc(item.name || item.id)}${item.id === initial ? '（初始）' : ''}</button>`).join('')}</span>`);
      }
      add('备注', entity.note);
      add('素材', (entity.assets || []).join('、'));
    }
    if (entity._type === 'link') {
      add('名称', entity.name);
      add('触发方式', entity.trigger);
      add('条件', entity.require === 'any' ? '任一' : '全部');
      addHtml('触发源', (Array.isArray(entity.from) ? entity.from : []).map(id => jump(id)).join(''));
      const stateName = (id, value) => {
        const target = index.get(id);
        if (target?._type === 'door') return value === 'open' ? '开' : value === 'closed' ? '关' : value;
        return (target?.states || []).find(item => item.id === value)?.name || value;
      };
      addHtml('目标', (Array.isArray(entity.to) ? entity.to : []).map(item => jump(item.id, `${index.get(item.id)?.name ?? item.id} → ${stateName(item.id, item.state)}`)).join(''));
      add('备注', entity.note);
    }
    if (['object', 'door', 'enemy', 'room'].includes(entity._type)) {
      const related = (Array.isArray(state.data.links) ? state.data.links : []).filter(link =>
        (Array.isArray(link.from) && link.from.includes(entity.id)) || (Array.isArray(link.to) && link.to.some(item => item?.id === entity.id)));
      addHtml('相关连接', related.map(link => jump(link.id, link.name || link.id)).join(''));
    }
    const change = state.compare ? diffItems().find(item => item.id === entity.id) : null;
    if (change?.kind === 'added') pairs.push(['对比', '新增（基准里没有）']);
    if (change?.kind === 'changed') pairs.push(['对比', [change.moved ? (change.shift > .2 ? `移动 ${num(change.shift)} m` : '形状改变') : '', change.fields.length ? `字段：${change.fields.join('、')}` : ''].filter(Boolean).join('；')]);
    const issues = issuesFor(entity.id);
    const issueHtml = issues.length ? `<ul class="wb-inspector-issues">${issues.map(item => `<li class="${item.level}">${esc(item.msg)}</li>`).join('')}</ul>` : '';
    const inspectorActions = [
      '<button id="copyContextBtn" type="button" class="wb-copy-ctx" title="复制选中实体及 2 跳邻房 JSON 切片、问题与 Patch 格式说明">复制上下文</button>',
    ];
    $('inspector').innerHTML = `<span class="type">${esc(typeLabel(entity._type))}</span><h3>${esc(entity.name || entity.id)}</h3>${issueHtml}<dl class="wb-kv">${pairs.map(([key, value, raw]) => `<dt>${esc(key)}</dt><dd>${raw ? value : esc(value)}</dd>`).join('')}</dl><div class="wb-inspector-actions">${inspectorActions.join('')}</div>`;
    $('copyContextBtn').onclick = () => copyAiContextPrompt({ includeNotes: true });
  }

  function select(id) {
    const changed = state.selected !== id;
    state.selected = id;
    render();
    if (changed) $('map').querySelectorAll('.wb-selection').forEach(element => element.classList.add('fresh'));
    inspect(id);
    const url = new URL(location.href);
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    params.set('map', state.key || '');
    if (id) params.set('id', id); else params.delete('id');
    history.replaceState(null, '', `#${params.toString()}`);
    $('live').textContent = id ? `已选择 ${indexData(state.data).get(id)?.name || id}` : '已清除选择';
    syncOutline();
  }

  /* Outline: floors › rooms › what sits in each room, plus doors/routes/stairs/water.
     Typing in the search box flattens it to matches. Clicking an entry locates it. */
  const OUTLINE_LIMIT = 300;
  const outlineTag = entity => ({ room: entity.kind || '房间', object: entity.kind || '物件', enemy: entity.enemyType || entity.tier || '敌人', door: '门', route: entity.kind || '路线', stairs: '楼梯', water: entity.kind || '水面', link: entity.require === 'any' ? '任一' : '连接' })[entity._type];

  function outlineItem(entity, depth = 0) {
    return `<button type="button" class="wb-ol-item wb-ol-${entity._type}" data-outline-id="${esc(entity.id)}" style="--depth:${depth}" title="${esc(entity.id)}"><i></i><span>${esc(entity.name || entity.id)}</span><small>${esc(outlineTag(entity))}</small></button>`;
  }

  function outlineGroup(title, items, { open = false, id = null, depth = 0, count = items.length } = {}) {
    if (!items.length && !id) return '';
    const head = id
      ? `<summary class="wb-ol-item wb-ol-room" data-outline-id="${esc(id)}" style="--depth:${depth}"><i></i><span>${esc(title)}</span><small>${count}</small></summary>`
      : `<summary class="wb-ol-group" style="--depth:${depth}"><span>${esc(title)}</span><small>${count}</small></summary>`;
    return `<details${open ? ' open' : ''}${id ? ` data-room="${esc(id)}"` : ''}>${head}${items.join('')}</details>`;
  }

  function renderOutline() {
    const data = state.data;
    if (!data) return;
    const entities = allEntities(data);
    const query = (state.outlineQuery || '').trim().toLowerCase();
    $('outlineCount').textContent = `${entities.length} 项`;
    if (query) {
      const hits = entities.filter(entity => [entity.name, entity.id, entity.kind, entity.enemyType, entity.tier, typeLabel(entity._type)]
        .some(value => String(value ?? '').toLowerCase().includes(query)));
      $('outline').innerHTML = hits.length
        ? hits.slice(0, OUTLINE_LIMIT).map(entity => outlineItem(entity)).join('') + (hits.length > OUTLINE_LIMIT ? `<p class="wb-hint">还有 ${hits.length - OUTLINE_LIMIT} 项，请缩小搜索</p>` : '')
        : '<p class="wb-hint">没有匹配的对象</p>';
      $('outlineCount').textContent = `${hits.length} / ${entities.length}`;
      syncOutline();
      return;
    }
    const floors = data.floors?.length ? data.floors : [{ id: undefined, name: '未分层' }];
    const byType = type => entities.filter(entity => entity._type === type);
    const rooms = byType('room'), objects = byType('object'), enemies = byType('enemy');
    let html = '';
    for (const floor of floors) {
      const onFloor = entity => entity.floorId === floor.id;
      const floorRooms = rooms.filter(onFloor);
      const placed = new Set();
      const roomBlocks = floorRooms.map(room => {
        const inside = [
          ...enemies.filter(enemy => enemy.roomId === room.id),
          ...objects.filter(object => onFloor(object) && object.points?.length && pointInPoly(centerOf(object), room.points || [])),
        ].filter(entity => !placed.has(entity.id));
        inside.forEach(entity => placed.add(entity.id));
        return outlineGroup(room.name || room.id, inside.map(entity => outlineItem(entity, 2)), { id: room.id, depth: 1, count: inside.length });
      });
      const loose = [...enemies, ...objects].filter(entity => onFloor(entity) && !placed.has(entity.id));
      const extras = [
        outlineGroup('房间外', loose.map(entity => outlineItem(entity, 2)), { depth: 1 }),
        outlineGroup('门', byType('door').filter(onFloor).map(entity => outlineItem(entity, 2)), { depth: 1 }),
        outlineGroup('路线', byType('route').filter(onFloor).map(entity => outlineItem(entity, 2)), { depth: 1 }),
        outlineGroup('水面', byType('water').filter(onFloor).map(entity => outlineItem(entity, 2)), { depth: 1 }),
      ];
      const open = floors.length <= 2 || state.floor === floor.id;
      html += outlineGroup(floor.name || floor.id || '未分层', [...roomBlocks, ...extras], { open, count: entities.filter(onFloor).length });
    }
    html += outlineGroup('楼梯（跨层）', byType('stairs').map(entity => outlineItem(entity, 1)));
    html += outlineGroup('连接', byType('link').map(entity => outlineItem(entity, 1)));
    const rules = Array.isArray(data.meta?.proximity) ? data.meta.proximity.filter(rule => rule && typeof rule === 'object') : [];
    html += outlineGroup('邻近规则', rules.map(rule => `<div class="wb-ol-item wb-ol-rule" style="--depth:1" title="${esc(rule.id)}"><i></i><span>${esc(rule.name || rule.id)}</span><small>${num(rule.radius)} m</small></div>`));
    $('outline').innerHTML = html;
    syncOutline();
  }

  // Mark the selected entry, open its parents and keep it in view.
  function syncOutline() {
    const root = $('outline');
    if (!root) return;
    root.querySelectorAll('.wb-ol-item.active').forEach(element => element.classList.remove('active'));
    if (!state.selected) return;
    const item = [...root.querySelectorAll('[data-outline-id]')].find(element => element.dataset.outlineId === state.selected);
    if (!item) return;
    item.classList.add('active');
    for (let parent = item.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS' && !(item.tagName === 'SUMMARY' && parent === item.parentElement)) parent.open = true;
    }
    const top = item.offsetTop - root.offsetTop, bottom = top + item.offsetHeight;
    if (top < root.scrollTop || bottom > root.scrollTop + root.clientHeight) root.scrollTop = top - root.clientHeight / 3;
  }

  // Show an entity wherever it is: switch to its floor, frame it in 2D (and 3D), select it.
  function locate(id) {
    const entity = state.data ? indexData(state.data).get(id) : null;
    if (!entity) return;
    if (!floorMatches(entity)) {
      state.floor = entity.floorId || entity.fromFloorId || 'all';
      renderFloors();
      renderLevels();
    }
    const box = bboxOf(entity);
    if (box) {
      const from = { ...state.view };
      const size = Math.max(box.maxX - box.minX, box.maxZ - box.minZ, 1);
      // Frame the entity with some margin; small things get at least a 24 m wide view.
      const want = Math.max(size * 1.5, 24);
      if (state.view.w > want * 2 || state.view.w < size * 1.2) {
        const scale = want / state.view.w;
        state.view.w *= scale;
        state.view.h *= scale;
      }
      state.view.x = (box.minX + box.maxX) / 2 - state.view.w / 2;
      state.view.y = -(box.minZ + box.maxZ) / 2 - state.view.h / 2;
      glideFrom(from);
    }
    select(id);
    if (state.mode === '3d') view3d?.focus(id);
  }

  function pointInPoly(point, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, zi] = points[i], [xj, zj] = points[j];
      if (((zi > point[1]) !== (zj > point[1])) && (point[0] < (xj - xi) * (point[1] - zi) / ((zj - zi) || 1e-9) + xi)) inside = !inside;
    }
    return inside;
  }

  function renderHealth() {
    const result = state.validation || { errors: [], warnings: [], stats: {} };
    const badge = $('healthBadge');
    badge.textContent = result.errors.length ? `${result.errors.length} 错误` : result.warnings.length ? `通过 · ${result.warnings.length} 告警` : '通过';
    badge.style.color = result.errors.length ? 'var(--danger)' : result.warnings.length ? 'var(--amber)' : 'var(--teal)';
    // Same rules/codes as tools/validate_ai_map.py; issues naming an entity are clickable.
    const issue = item => (item.id && state.data && indexData(state.data).has(item.id)
      ? `<button type="button" data-issue-id="${esc(item.id)}" title="${esc(item.code)}">${esc(item.msg)}</button>`
      : `<div title="${esc(item.code)}">${esc(item.msg)}</div>`);
    const FIXABLE_CODES = new Set(['door-off-boundary', 'room-overlap', 'route-clearance']);
    const fixableCount = result.warnings.filter(w => FIXABLE_CODES.has(w.code)).length;
    let html = '';
    if (!result.errors.length) html += '<div class="wb-health-ok">结构校验通过</div>';
    if (result.errors.length) html += `<div class="wb-health-errors">${result.errors.slice(0, 30).map(issue).join('')}</div>`;
    if (fixableCount) html += `<button id="autoFixBtn" type="button" class="wb-health-fix" title="只生成修正后的预览副本，不修改原文件">一键吸附修正（预览副本 · ${fixableCount} 处候选）</button>`;
    if (result.warnings.length) html += `<details class="wb-health-warnings"${result.warnings.length <= 6 ? ' open' : ''}><summary>${result.warnings.length} 条告警</summary>${result.warnings.slice(0, 60).map(issue).join('')}</details>`;
    html += `<ul><li>${result.stats.rooms} 房间 · ${result.stats.objects} 物件</li><li>${result.stats.enemies} 敌人 · ${result.stats.routes} 路线</li><li>${result.stats.doors} 门 · ${result.stats.stairs} 楼梯 · ${result.stats.water} 水面</li></ul>`;
    $('health').innerHTML = html;
    if ($('autoFixBtn')) {
      $('autoFixBtn').onclick = () => {
        if (!state.data) return;
        const { data: fixed, fixes } = window.WorkbenchGeometry.snapAndClearGeometry(state.data);
        if (!fixes.length) { toast('超出自动吸附阈值，建议「复制邻近上下文给 AI」局部重排'); return; }
        loadImportedData(fixed, summarizeFixes(fixes));
      };
    }
  }

  function renderInfo() {
    const data = state.data;
    if (!data) return;
    const b = boundsOf(data);
    $('mapInfo').innerHTML = `<b>${esc(data.meta?.title || '未命名')}</b><br>${esc(data.meta?.subtitle || '')}<br>${esc(data.meta?.provenance?.label || '无来源')}<br>${num(b.maxX - b.minX)}×${num(b.maxZ - b.minZ)} m · ${data.floors?.length || 0} 层`;
    // meta.kindLegend: what each custom kind / enemy type is.
    const legend = data.meta?.kindLegend && typeof data.meta.kindLegend === 'object' && !Array.isArray(data.meta.kindLegend)
      ? Object.values(data.meta.kindLegend).filter(item => item && typeof item === 'object' && item.label) : [];
    if ($('kindLegendPanel')) $('kindLegendPanel').hidden = !legend.length;
    if ($('kindLegend')) $('kindLegend').innerHTML = legend.map(item => `<div><b>${esc(item.label)}</b>${esc(item.note || '')}</div>`).join('');
  }

  function renderAllPanels() {
    renderMapList();
    renderLayers();
    renderFloors();
    renderHealth();
    renderInfo();
    renderMapHead();
    renderSummary();
    renderLevels();
    renderDesignNotes();
    renderPacing();
    renderOutline();
    renderExitPanel();
    renderCompareSelect();
    renderDiffPanel();
    renderNotes();
    renderResetStates();
  }

  function clearActiveMap() {
    if (desktop) desktop.stopWatch();
    if (state.mode === '3d') view3d?.setMode('2d');
    state.key = null;
    state.data = null;
    state.validation = null;
    state.floor = 'all';
    state.selected = null;
    state.overrides = {};
    state.compare = null;
    state.pacing = null;
    state.exitOff = new Set();
    state.measure = { points: [], hover: null, done: false, closed: false };
    closeNoteEditor();
    $('map').innerHTML = '';
    $('empty').textContent = desktop ? '还没有地图 · 点左侧「打开 JSON」或拖入 .json 文件' : '没有可显示的内容';
    $('empty').hidden = false;
    $('mapTitle').textContent = '关卡工作台';
    $('mapSubtitle').textContent = '';
    $('mapBadges').innerHTML = '';
    $('floorBar').innerHTML = '';
    $('summary').innerHTML = '';
    $('mapInfo').innerHTML = '';
    if ($('kindLegendPanel')) $('kindLegendPanel').hidden = true;
    if ($('kindLegend')) $('kindLegend').innerHTML = '';
    $('levelsPanel').innerHTML = '';
    $('designNotes').innerHTML = '';
    $('outline').innerHTML = '';
    $('outlineCount').textContent = '0 / 0';
    $('health').innerHTML = '';
    $('healthBadge').textContent = '';
    $('legend').innerHTML = '';
    $('mapMeta').innerHTML = '';
    $('pacingPanel').hidden = true;
    $('diffPanel').hidden = true;
    $('exitPanel').hidden = true;
    $('notesSection').hidden = true;
    $('scaleBar').hidden = true;
    inspect(null);
    renderMapList();
    renderCompareSelect();
    renderResetStates();
    if ($('desktopClearBtn')) $('desktopClearBtn').disabled = !Object.keys(maps).length;
    if (desktop) desktop.notifyActiveMap({ key: null, filePath: null, title: '关卡工作台' });
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }

  function removeDesktopMap(key) {
    if (!key || !maps[key]) return;
    delete maps[key];
    state.desktopFiles.delete(key);
    desktop?.removeLibraryItem(key);
    if (state.compare?.key === key) state.compare = null;
    if (state.key === key) {
      const next = Object.keys(maps)[0];
      if (next) {
        const nextDisk = state.desktopFiles.get(next);
        if (desktop && nextDisk) openDesktopFilePath(nextDisk.filePath);
        else loadMap(next);
      } else {
        clearActiveMap();
      }
    } else {
      renderMapList();
      renderCompareSelect();
      renderDiffPanel();
      if ($('desktopClearBtn')) $('desktopClearBtn').disabled = !Object.keys(maps).length;
    }
    toast('已从列表移除');
  }

  function clearDesktopMaps() {
    if (!Object.keys(maps).length) return;
    for (const key of Object.keys(maps)) delete maps[key];
    state.desktopFiles.clear();
    desktop?.clearLibrary();
    clearActiveMap();
    toast('已清空地图列表');
  }

  function syncDesktopActive() {
    if (!desktop || !state.data) return;
    const diskEntry = state.desktopFiles.get(state.key);
    desktop.setActiveLibraryKey(state.key);
    desktop.notifyActiveMap({
      key: state.key,
      filePath: diskEntry?.filePath || null,
      title: state.data.meta?.title || state.key || '关卡工作台',
    });
  }

  function loadMap(key, external) {
    const data = external || maps[key];
    if (!data) return;
    if (external && !maps[key]) maps[key] = external;
    const diskEntry = state.desktopFiles.get(key);
    if (desktop && !external && !diskEntry) desktop.stopWatch();
    state.key = key;
    state.data = data;
    state.validation = validate(data);
    state.floor = 'all';
    state.selected = null;
    state.overrides = {};
    state.layers = { ...DEFAULT_LAYERS };
    state.exitOff = new Set();
    if (state.compare?.key === key) state.compare = null;
    state.measure = { points: [], hover: null, done: false, closed: false };
    closeNoteEditor();
    renderAllPanels();
    inspect(null);
    fit();
    $('empty').hidden = true;
    if ($('desktopClearBtn')) $('desktopClearBtn').disabled = !Object.keys(maps).length;
    syncDesktopActive();
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (params.get('map') !== key) params.delete('id');
    params.set('map', key);
    history.replaceState(null, '', `${location.pathname}${location.search}#${params}`);
    if (params.get('id')) select(params.get('id'));
  }

  function summarizeFixes(fixes) {
    if (!fixes?.length) return '';
    const counts = { 'door-snap': 0, 'room-unoverlap': 0, 'route-clear': 0 };
    for (const f of fixes) if (f.kind in counts) counts[f.kind] += 1;
    const parts = [
      counts['door-snap'] ? `门贴边 ${counts['door-snap']}` : '',
      counts['room-unoverlap'] ? `微重叠 ${counts['room-unoverlap']}` : '',
      counts['route-clear'] ? `路线净空 ${counts['route-clear']}` : '',
    ].filter(Boolean);
    return parts.length ? `已自动修正：${parts.join(' · ')}` : `已修正 ${fixes.length} 处几何`;
  }

  function prepareImportInput(raw, { autoSnap = false } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { data: raw, fixes: [] };
    const geom = window.WorkbenchGeometry;
    const isPatch = Boolean(raw.patch || ['upsertRooms', 'upsertObjects', 'upsertEnemies', 'upsertDoors', 'upsertRoutes', 'upsertStairs', 'removeIds'].some(k => k in raw));
    if (isPatch) {
      if (!state.data) return { error: '请先打开一张基础地图再应用局部 Patch' };
      return geom.applyAiPatch(state.data, raw, { autoSnap });
    }
    const hasRelative = (Array.isArray(raw.rooms) && raw.rooms.some(r => r && !r.points && r.size))
      || (Array.isArray(raw.doors) && raw.doors.some(d => d && !d.points && d.between));
    const expanded = hasRelative ? geom.expandRelativeLayout(raw) : raw;
    if (!autoSnap) return { data: expanded, fixes: [] };
    if (validate(expanded).errors.length) return { data: expanded, fixes: [] };
    return geom.snapAndClearGeometry(expanded);
  }

  function loadImportedData(data, extraMsg = '') {
    const result = validate(data);
    if (result.errors.length) {
      toast(`导入失败：${result.errors[0].msg}${result.errors.length > 1 ? `（共 ${result.errors.length} 个错误）` : ''}`);
      return false;
    }
    const key = `imported-${Date.now()}`;
    maps[key] = data;
    state.validation = result;
    if (desktop) desktop.saveLibraryItem({ key, type: 'inline', text: JSON.stringify(data) });
    loadMap(key, data);
    toast(extraMsg ? `已导入地图 · ${extraMsg}` : '已导入地图');
    return true;
  }

  function parseDiskPayload(payload) {
    if (!payload || payload.canceled) return null;
    if (payload.error) { toast(payload.error); return null; }
    try {
      const data = JSON.parse(payload.text);
      const result = validate(data);
      if (result.errors.length) {
        toast(`导入失败：${result.errors[0].msg}${result.errors.length > 1 ? `（共 ${result.errors.length} 个错误）` : ''}`);
        return null;
      }
      return { data, result };
    } catch (error) {
      toast(`JSON 解析失败：${error.message}`);
      return null;
    }
  }

  function openDiskPayload(payload, { keyOverride = null, persist = true, silent = false } = {}) {
    const parsed = parseDiskPayload(payload);
    if (!parsed) return false;
    const { data, result } = parsed;
    const existing = [...state.desktopFiles.entries()]
      .find(([, item]) => item.filePath.toLowerCase() === payload.filePath.toLowerCase());
    const key = existing ? existing[0] : (keyOverride || `disk-${Date.now()}`);
    const initialData = existing ? existing[1].initialData : JSON.parse(JSON.stringify(data));
    state.desktopFiles.set(key, { filePath: payload.filePath, fileName: payload.fileName, initialData });
    maps[key] = data;
    state.validation = result;
    if (persist && desktop) desktop.saveLibraryItem({ key, type: 'file', filePath: payload.filePath });
    loadMap(key, data);
    if (!silent) toast(`已打开：${payload.fileName}`);
    return true;
  }

  function reloadActiveFromDisk(payload) {
    if (!payload || payload.error) { if (payload?.error) toast(payload.error); return; }
    const entry = state.desktopFiles.get(state.key);
    if (!entry || entry.filePath.toLowerCase() !== payload.filePath.toLowerCase()) {
      openDiskPayload(payload);
      return;
    }
    const parsed = parseDiskPayload(payload);
    if (!parsed) return;
    const { data, result } = parsed;
    const prevView = { ...state.view };
    const prevMode = state.mode;
    const prevPose = prevMode === '3d' ? view3d.pose() : null;
    const prevSelected = state.selected;
    invalidateGeometryCaches();
    maps[state.key] = data;
    state.data = data;
    state.validation = result;
    if (state.floor !== 'all' && !(data.floors || []).some(f => f.id === state.floor)) state.floor = 'all';
    if (state.compare) state.compare.forKey = null;
    const nextIndex = indexData(data);
    state.selected = prevSelected && nextIndex.has(prevSelected) ? prevSelected : null;
    state.overrides = Object.fromEntries(Object.entries(state.overrides).filter(([id]) => nextIndex.has(id)));
    renderAllPanels();
    if (prevMode === '2d') {
      state.view = prevView;
      applyView();
    } else {
      render();
      if (prevPose) view3d.setPose(prevPose);
    }
    inspect(state.selected);
    syncOutline();
    syncDesktopActive();
    toast(`文件已更新，已自动重载（${payload.fileName}）`);
  }

  async function openDesktopFile() {
    if (!desktop) return;
    const payload = await desktop.openFileDialog();
    openDiskPayload(payload);
  }

  async function openDesktopFilePath(filePath, opts = {}) {
    if (!desktop || !filePath) return;
    const payload = await desktop.openFilePath(filePath);
    openDiskPayload(payload, opts);
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadImportedData(JSON.parse(String(reader.result)));
      } catch (error) {
        toast(`JSON 解析失败：${error.message}`);
      }
    };
    reader.readAsText(file);
  }

  async function exportSvg() {
    if (!state.data) return;
    const clone = $('map').cloneNode(true);
    clone.querySelectorAll('.wb-selection, #wbPaceCursor').forEach(element => element.remove());
    const b = boundsOf(state.data, state.floor);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', '1600');
    clone.setAttribute('height', '1000');
    clone.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    background.setAttribute('x', String(b.minX - 2));
    background.setAttribute('y', String(-b.maxZ - 2));
    background.setAttribute('width', String(b.maxX - b.minX + 4));
    background.setAttribute('height', String(b.maxZ - b.minZ + 4));
    background.setAttribute('fill', '#f8f5ea');   // --canvas of the light palette
    clone.insertBefore(background, clone.firstChild);
    await saveTextFile({
      title: '导出 SVG 平面图',
      defaultName: `${(state.data.meta?.title || 'map').replace(/[\\/:*?"<>|]/g, '-')}.svg`,
      filters: [{ name: 'SVG 矢量图', extensions: ['svg'] }],
      mime: 'image/svg+xml',
      content: new XMLSerializer().serializeToString(clone),
      okMessage: 'SVG 已导出',
    });
  }

  async function exportUePackage() {
    if (!state.data) return;
    const val = state.validation || window.WorkbenchValidate.validate(state.data);
    if (val.errors.length) {
      toast(`存在 ${val.errors.length} 处结构错误（${val.errors[0].msg}），请先修复后再导出 UE 构建包`);
      return;
    }
    const pkg = window.WorkbenchGeometry.buildUeWhiteboxSpec(state.data);
    const spatialWarns = (val.warnings || [])
      .filter(w => ['room-overlap', 'door-off-boundary', 'route-clearance'].includes(w.code))
      .map(w => ({ code: w.code, id: w.id || null, msg: w.msg }));
    pkg.preflight.spatialWarnings = spatialWarns;
    const notes = [];
    if (pkg.preflight.missingStairBottom.length) notes.push(`缺少楼梯 bottom：${pkg.preflight.missingStairBottom.join(', ')}`);
    if (spatialWarns.length) notes.push(`${spatialWarns.length} 处空间告警建议先点「一键吸附修正」`);
    const safeName = (state.data.meta?.title || state.key || 'map').replace(/[\\/:*?"<>|]/g, '-');
    const c = pkg.expectedCounts;
    const okMsg = `已导出 UE 构建包（墙 ${c.walls} · 门 ${c.doors} · 物件 ${c.objects}）${notes.length ? ` · 注意：${notes.join('；')}` : ''}`;
    await saveTextFile({
      title: '导出 UE5 白盒构建包',
      defaultName: `${safeName}-ue-whitebox.json`,
      filters: [{ name: 'UE Whitebox JSON', extensions: ['json'] }],
      mime: 'application/json',
      content: JSON.stringify(pkg, null, 2),
      okMessage: okMsg,
    });
  }

  function setPacingCollapsed(collapsed) {
    const panel = $('pacingPanel');
    const button = $('pacingToggle');
    panel.classList.toggle('collapsed', collapsed);
    button.textContent = collapsed ? '展开' : '收起';
    button.setAttribute('aria-expanded', String(!collapsed));
  }

  function bind() {
    $('pacingToggle').onclick = () => setPacingCollapsed(!$('pacingPanel').classList.contains('collapsed'));
    if (window.innerHeight < 860) setPacingCollapsed(true);
    $('fitBtn').onclick = () => { if (state.mode === '3d') return view3d.fit(); const from = { ...state.view }; fit(); glideFrom(from); };
    $('zoomIn').onclick = () => (state.mode === '3d' ? view3d.zoom(.8) : zoomAt(0.8, $('map').getBoundingClientRect().left + $('map').clientWidth / 2, $('map').getBoundingClientRect().top + $('map').clientHeight / 2));
    $('zoomOut').onclick = () => (state.mode === '3d' ? view3d.zoom(1.25) : zoomAt(1.25, $('map').getBoundingClientRect().left + $('map').clientWidth / 2, $('map').getBoundingClientRect().top + $('map').clientHeight / 2));
    $('view2dBtn').onclick = () => view3d.setMode('2d');
    $('styleSchemaBtn').onclick = () => setStyle('schema');
    $('stylePlanBtn').onclick = () => setStyle('plan');
    $('view3dBtn').onclick = () => { setTool(null); view3d.setMode('3d'); };
    $('health').addEventListener('click', event => {
      const id = event.target.closest('[data-issue-id]')?.dataset.issueId;
      if (id) locate(id);
    });
    $('outline').addEventListener('click', event => {
      const item = event.target.closest('[data-outline-id]');
      if (!item) return;
      // A room row toggles its children only when clicked again while already selected.
      if (item.tagName === 'SUMMARY' && state.selected !== item.dataset.outlineId) {
        event.preventDefault();
        item.parentElement.open = true;
      }
      locate(item.dataset.outlineId);
    });
    $('pacingChart').addEventListener('pointermove', event => setPaceCursor(paceSampleAt(event.clientX, event.clientY)));
    $('pacingChart').addEventListener('pointerleave', () => setPaceCursor(null));
    $('pacingChart').addEventListener('click', event => {
      setPaceCursor(paceSampleAt(event.clientX, event.clientY));
      centerOnPace();
    });
    $('compareSelect').addEventListener('change', event => {
      const key = event.target.value;
      if (key === '__file') return;
      if (key === '__initial') {
        const initData = state.desktopFiles.get(state.key)?.initialData;
        if (initData) setCompare(initData, '__initial');
        return;
      }
      setCompare(key ? maps[key] : null, key || null);
    });
    $('compareFile').onchange = event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          setCompare(JSON.parse(String(reader.result)), `file:${file.name}`);
          toast(`对比基准：${file.name}`);
        } catch (error) {
          toast(`JSON 解析失败：${error.message}`);
        }
      };
      reader.readAsText(file);
    };
    $('diffPanel').addEventListener('click', event => {
      const button = event.target.closest('[data-diff-id]');
      if (!button) return;
      if (button.dataset.diffKind === 'removed') showRemoved(button.dataset.diffId);
      else locate(button.dataset.diffId);
    });
    $('exitPanel').addEventListener('change', event => {
      const key = event.target.dataset.exit;
      if (!key) return;
      if (event.target.checked) state.exitOff.delete(key); else state.exitOff.add(key);
      render();
      renderExitPanel();
    });
    $('exitPanel').addEventListener('click', event => {
      const id = event.target.closest('[data-exit-locate]')?.dataset.exitLocate;
      if (id) locate(id);
    });
    $('map').addEventListener('pointermove', showDistanceTip);
    $('map').addEventListener('pointerleave', () => { $('mapTip').hidden = true; });
    $('outlineSearch').addEventListener('input', event => {
      state.outlineQuery = event.target.value;
      renderOutline();
    });
    $('outlineSearch').addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.target.value = '';
        state.outlineQuery = '';
        renderOutline();
      }
      if (event.key === 'Enter') $('outline').querySelector('[data-outline-id]')?.click();
    });
    $('clearBtn').onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      select(null);
    };
    const exportList = $('exportList');
    const closeExport = () => { exportList.hidden = true; $('exportMenuBtn').setAttribute('aria-expanded', 'false'); };
    $('exportMenuBtn').onclick = event => {
      event.stopPropagation();
      exportList.hidden = !exportList.hidden;
      $('exportMenuBtn').setAttribute('aria-expanded', String(!exportList.hidden));
    };
    // Capture phase: the map stops its own clicks from bubbling.
    document.addEventListener('pointerdown', event => { if (!event.target.closest('#exportMenu')) closeExport(); }, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeExport(); });
    $('exportUeBtn').onclick = () => { closeExport(); exportUePackage(); };
    $('exportBtn').onclick = () => { closeExport(); exportSvg(); };
    $('compareBtn').onclick = () => toggleComparePop();
    if (desktop) {
      $('fileInput').closest('label')?.addEventListener('click', event => {
        event.preventDefault();
        openDesktopFile();
      });
    }
    $('fileInput').onchange = event => { if (event.target.files?.[0]) importFile(event.target.files[0]); event.target.value = ''; };
    $('pasteBtn').onclick = () => {
      try {
        const raw = JSON.parse($('pasteInput').value);
        const autoSnap = $('autoSnapChk')?.checked ?? false;
        const prepared = prepareImportInput(raw, { autoSnap });
        if (prepared.error) { toast(prepared.error); return; }
        const msg = summarizeFixes(prepared.fixes);
        if (loadImportedData(prepared.data, msg)) $('pasteInput').value = '';
      } catch (error) {
        toast(`JSON 解析失败：${error.message}`);
      }
    };
    window.addEventListener('resize', () => { if (state.data) render(); });
    const svg = $('map');
    svg.addEventListener('wheel', event => {
      event.preventDefault();
      zoomAt(event.deltaY > 0 ? 1.12 : 0.89, event.clientX, event.clientY);
    }, { passive: false });
    svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      svg.setPointerCapture(event.pointerId);
      state.drag = { x: event.clientX, y: event.clientY, ox: state.view.x, oy: state.view.y, moved: false, target: event.target.closest('[data-id]')?.dataset.id || null };
      svg.classList.add('dragging');
    });
    svg.addEventListener('pointermove', event => {
      if (!state.drag) return;
      const dx = event.clientX - state.drag.x;
      const dy = event.clientY - state.drag.y;
      if (Math.hypot(dx, dy) > 4) state.drag.moved = true;
      if (state.drag.moved) {
        state.view.x = state.drag.ox - dx / Math.max(1, svg.clientWidth) * state.view.w;
        state.view.y = state.drag.oy - dy / Math.max(1, svg.clientHeight) * state.view.h;
        svg.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
      }
    });
    svg.addEventListener('pointerup', event => {
      if (state.drag && !state.drag.moved) {
        if (state.tool === 'measure') measureClick(event);
        else if (state.tool === 'note') noteClick(event, state.drag.target);
        else select(state.drag.target);
      }
      state.drag = null;
      svg.classList.remove('dragging');
    });
    svg.addEventListener('pointercancel', () => { state.drag = null; svg.classList.remove('dragging'); });
    svg.addEventListener('pointermove', event => {
      if (state.tool !== 'measure' || state.measure.done || !state.measure.points.length || state.drag?.moved) return;
      state.measure.hover = planPoint(event);
      paintTools();
    });
    svg.addEventListener('dblclick', event => {
      if (state.tool !== 'measure') return;
      event.preventDefault();
      // The double click already added its second point; drop the duplicate.
      const pts = state.measure.points;
      if (pts.length > 2 && Math.hypot(pts.at(-1)[0] - pts.at(-2)[0], pts.at(-1)[1] - pts.at(-2)[1]) < labelSize() * .3) pts.pop();
      finishMeasure();
    });
    $('measureBtn').onclick = () => setTool('measure');
    $('noteBtn').onclick = () => setTool('note');
    $('statsBtn').onclick = () => toggleStats();
    $('noteSave').onclick = saveNote;
    $('noteCancel').onclick = closeNoteEditor;
    $('noteText').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); saveNote(); }
      if (event.key === 'Escape') { event.preventDefault(); closeNoteEditor(); }
    });
    $('notesList').addEventListener('click', event => {
      const remove = event.target.closest('[data-note-remove]');
      if (remove) {
        event.stopPropagation();
        const list = sessionNotes();
        list.splice(list.findIndex(note => note.id === remove.dataset.noteRemove), 1);
        saveNotes();
        return;
      }
      const item = event.target.closest('[data-note-id]');
      if (item) showNote(item.dataset.noteId);
    });
    $('notesExport').onclick = exportNotes;
    $('notesCopy').onclick = copyNotes;
    $('notesClear').onclick = () => {
      if (!sessionNotes().length || !window.confirm(`清空这张图的 ${sessionNotes().length} 条批注？`)) return;
      sessionNotes().length = 0;
      saveNotes();
    };
    $('statsPanel').addEventListener('click', event => {
      if (event.target === $('statsPanel') || event.target.closest('[data-close-modal]')) toggleStats(false);
      const sort = event.target.closest('[data-sort]')?.dataset.sort;
      if (sort) {
        state.statsSort = { key: sort, dir: state.statsSort.key === sort ? -state.statsSort.dir : (sort === 'name' || sort === 'floor' ? 1 : -1) };
        renderStats();
        return;
      }
      const row = event.target.closest('[data-room]');
      if (row) { toggleStats(false); locate(row.dataset.room); }
    });
    svg.addEventListener('keydown', event => {
      const step = state.view.w * .06;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'ArrowLeft') state.view.x -= step;
        if (event.key === 'ArrowRight') state.view.x += step;
        if (event.key === 'ArrowUp') state.view.y -= step;
        if (event.key === 'ArrowDown') state.view.y += step;
        applyView();
      }
      if (event.key === 'Escape') select(null);
    });
  }


  function renderDesktopRecent() {
    const select = $('desktopRecentSelect');
    if (!select) return;
    const items = state.desktopRecent || [];
    select.innerHTML = `<option value="">${items.length ? `最近打开（${items.length}）` : '暂无最近打开'}</option>`
      + items.map(item => `<option value="${esc(item.filePath)}" title="${esc(item.filePath)}">${esc(item.fileName)}</option>`).join('');
    select.value = '';
  }

  function initDesktop() {
    if (!desktop) return;
    // Desktop file actions sit in the map panel, just above the paste box.
    const anchor = document.querySelector('details.wb-paste');
    if (anchor) {
      const sampleKeys = Object.keys(builtinMaps);
      const sampleSelectHtml = sampleKeys.length
        ? `<select id="desktopSampleSelect" aria-label="打开内置示例"><option value="">打开内置示例…</option>${sampleKeys.map(key => `<option value="${esc(key)}">${esc(builtinMaps[key]?.meta?.title || key)}</option>`).join('')}</select>`
        : '';
      anchor.insertAdjacentHTML('beforebegin', `
        <div id="desktopBar" class="wb-desktop-bar">
          <div class="wb-desktop-actions">
            <button type="button" id="desktopOpenBtn" title="打开本地地图 JSON（Ctrl+O，支持修改热重载）">打开 JSON</button>
            <button type="button" id="desktopRevealBtn" title="在资源管理器中定位当前地图源文件">定位文件</button>
            <button type="button" id="desktopEditBtn" title="用系统默认编辑器打开当前地图 JSON">编辑</button>
            <button type="button" id="desktopClearBtn" title="清空当前地图列表（不删除原文件）">清空</button>
          </div>
          <select id="desktopRecentSelect" aria-label="最近打开的地图"></select>
          ${sampleSelectHtml}
        </div>
      `);
      $('desktopOpenBtn').onclick = openDesktopFile;
      $('desktopRevealBtn').onclick = async () => {
        const ok = await desktop.revealFile({ key: state.key, filePath: state.desktopFiles.get(state.key)?.filePath });
        if (!ok) toast('当前地图没有对应的本地文件');
      };
      $('desktopEditBtn').onclick = async () => {
        const res = await desktop.openInEditor({ key: state.key, filePath: state.desktopFiles.get(state.key)?.filePath });
        if (!res?.ok) toast(res?.error || '无法打开编辑器');
      };
      $('desktopClearBtn').onclick = clearDesktopMaps;
      $('desktopRecentSelect').onchange = event => {
        const filePath = event.target.value;
        event.target.value = '';
        if (filePath) openDesktopFilePath(filePath);
      };
      if ($('desktopSampleSelect')) {
        $('desktopSampleSelect').onchange = event => {
          const key = event.target.value;
          event.target.value = '';
          if (!key || !builtinMaps[key]) return;
          const copy = JSON.parse(JSON.stringify(builtinMaps[key]));
          state.desktopFiles.delete(key);
          maps[key] = copy;
          desktop.saveLibraryItem({ key, type: 'inline', text: JSON.stringify(copy) });
          loadMap(key);
          toast(`已打开示例：${copy.meta?.title || key}`);
        };
      }
    }
    desktop.onOpenFile(payload => openDiskPayload(payload));
    desktop.onFileUpdated(payload => reloadActiveFromDisk(payload));
    desktop.onWatchChanged(enabled => {
      state.desktopWatch = Boolean(enabled);
      renderMapHead();
      toast(state.desktopWatch ? '已开启文件监听热重载' : '已暂停文件监听');
    });
    desktop.onRecentChanged(list => {
      state.desktopRecent = Array.isArray(list) ? list : [];
      renderDesktopRecent();
    });
    desktop.onCommand(async (command, arg) => {
      if (command === 'open') openDesktopFile();
      else if (command === 'open-builtin' && arg && builtinMaps[arg]) {
        maps[arg] = builtinMaps[arg];
        loadMap(arg, builtinMaps[arg]);
        toast(`已打开内置示例：${builtinMaps[arg].meta?.title || arg}`);
      }
      else if (command === 'clear-library') clearDesktopMaps();
      else if (command === 'reload-watched') reloadActiveFromDisk(await desktop.reloadWatched());
      else if (command === 'export-svg') exportSvg();
      else if (command === 'export-notes') exportNotes();
      else if (command === 'rebuild-builtins') {
        const res = await desktop.rebuildBuiltins();
        if (res?.ok) {
          toast('内置地图已重建，正在刷新…');
          setTimeout(() => location.reload(), 250);
        } else {
          toast(`重建失败：${res?.error || '未知错误'}`);
        }
      }
      else if (command === 'toggle-mode') view3d.setMode(state.mode === '3d' ? '2d' : '3d');
      else if (command === 'toggle-style') setStyle(state.style === 'plan' ? 'schema' : 'plan');
      else if (command === 'toggle-left') togglePanel('left');
      else if (command === 'toggle-right') togglePanel('right');
      else if (command === 'toggle-theme') $('themeBtn').click();
      else if (command === 'tool-measure') setTool('measure');
      else if (command === 'tool-note') setTool('note');
      else if (command === 'tool-stats') toggleStats();
      else if (command === 'reset-states') resetStates();
      else if (command === 'help') toggleHelp();
    });
    clearActiveMap();
    desktop.initState().then(async info => {
      if (!info) return;
      state.desktopWatch = Boolean(info.watchEnabled);
      state.desktopRecent = Array.isArray(info.recentFiles) ? info.recentFiles : [];
      renderDesktopRecent();
      for (const item of info.libraryItems || []) {
        try {
          const data = JSON.parse(item.text);
          if (validate(data).errors.length) continue;
          maps[item.key] = data;
          if (item.type === 'file' && item.filePath) {
            state.desktopFiles.set(item.key, {
              filePath: item.filePath,
              fileName: item.fileName,
              initialData: JSON.parse(JSON.stringify(data)),
            });
          }
        } catch {
          /* skip invalid saved item */
        }
      }
      const sampleKeys = Object.keys(builtinMaps);
      if (info.preloadBuiltinSamples && !Object.keys(maps).length && !info.initialFile && sampleKeys.length) {
        for (const skey of sampleKeys) {
          maps[skey] = JSON.parse(JSON.stringify(builtinMaps[skey]));
        }
        for (const skey of sampleKeys.slice().reverse()) {
          await desktop.saveLibraryItem({ key: skey, type: 'inline', text: JSON.stringify(maps[skey]) });
        }
      }
      renderMapList();
      renderCompareSelect();
      if ($('desktopClearBtn')) $('desktopClearBtn').disabled = !Object.keys(maps).length;
      if (info.initialFile) {
        openDiskPayload(info.initialFile);
      } else {
        const targetKey = info.activeKey && maps[info.activeKey] ? info.activeKey : Object.keys(maps)[0];
        if (targetKey) {
          const diskEntry = state.desktopFiles.get(targetKey);
          if (diskEntry) openDesktopFilePath(diskEntry.filePath, { silent: true });
          else loadMap(targetKey);
        } else {
          clearActiveMap();
        }
      }
    });
  }

  function initSegmentedPills() {
    const bars = [...document.querySelectorAll('.wb-mode, .wb-floors')];
    const syncBar = bar => {
      let thumb = bar.querySelector(':scope > .wb-pill-thumb');
      const active = bar.querySelector('button.active');
      if (!active || !active.offsetWidth) {
        if (thumb) thumb.style.opacity = '0';
        if (!active) delete bar.dataset.pillReady;
        return;
      }
      const isFresh = !thumb || bar.dataset.pillReady !== '1';
      if (!thumb) {
        thumb = document.createElement('span');
        thumb.className = 'wb-pill-thumb';
        thumb.setAttribute('aria-hidden', 'true');
        bar.prepend(thumb);
      }
      if (isFresh) bar.classList.add('wb-pill-instant');
      thumb.style.width = `${active.offsetWidth}px`;
      thumb.style.height = `${active.offsetHeight}px`;
      thumb.style.transform = `translate3d(${active.offsetLeft}px, ${active.offsetTop}px, 0)`;
      thumb.style.opacity = '1';
      if (isFresh) {
        void thumb.offsetWidth;
        bar.dataset.pillReady = '1';
        bar.classList.remove('wb-pill-instant');
      }
    };
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
      for (const entry of entries) syncBar(entry.target);
    }) : null;
    for (const bar of bars) {
      let raf = 0;
      const schedule = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; syncBar(bar); });
      };
      new MutationObserver(mutations => {
        const onlyThumb = mutations.every(m => m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(n => n.classList?.contains('wb-pill-thumb')));
        if (!onlyThumb) syncBar(bar);
      }).observe(bar, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      resizeObserver?.observe(bar);
      document.fonts?.ready?.then?.(schedule);
      syncBar(bar);
    }
  }

  function init() {
    if (!desktop && !Object.keys(maps).length) {
      toast('没有示例地图');
      return;
    }
    view3d = window.WorkbenchView3D({
      state, $, toast, select, applyView, renderMapMeta,
      boundsOf, bboxOf, centerOf, areaOf, pointInPoly, floorMatches, visibleRouteSections, heatField, exitField,
      exitKey: () => `${state.revision}|${[...state.exitOff].sort().join(',')}`,
      overrides: () => state.overrides,
      theme: () => document.documentElement.dataset.theme || 'light',
      entityById: id => (state.data ? indexData(state.data).get(id) : null),
    });
    setTheme(stored.get('wb-theme-pick') === 'dark' ? 'dark' : 'light');
    if (stored.get('wb-hide-left')) togglePanel('left', true);
    if (stored.get('wb-hide-right')) togglePanel('right', true);
    renderMapList();
    renderLayers();
    $('layerList').insertAdjacentHTML('afterend', '<button id="resetStatesBtn" type="button" class="wb-reset-states" hidden>复位机关状态</button>');
    $('resetStatesBtn').onclick = resetStates;
    $('inspector').addEventListener('click', event => {
      const target = event.target.closest('[data-jump]');
      if (target) locate(target.dataset.jump);
      const choice = event.target.closest('[data-set-state]');
      if (choice) setObjectState(choice.dataset.setState, choice.dataset.state);
    });
    bind();
    bindShell();
    initSegmentedPills();
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (desktop) {
      initDesktop();
    } else {
      const wanted = params.get('map');
      const key = wanted && maps[wanted] ? wanted : 'ai-sample';
      if (wanted && !maps[wanted]) setTimeout(() => toast(`链接里的地图「${wanted}」不在列表里，已打开示例地图`), 400);
      loadMap(key);
      applyHashState(params);
    }
    window.__workbench = {
      get state() { return state; },
      get maps() { return maps; },
      loadMap,
      validate,
      select,
      fit,
      setMode: view3d.setMode,
      view3d: view3d.debug,
      proximity: () => window.WorkbenchGeometry.proximityGraph(state.data, state.overrides),
      expandRelativeLayout: window.WorkbenchGeometry.expandRelativeLayout,
      snapAndClearGeometry: window.WorkbenchGeometry.snapAndClearGeometry,
      applyAiPatch: window.WorkbenchGeometry.applyAiPatch,
      buildAiEditContext: (opts = {}) => window.WorkbenchGeometry.buildAiEditContext(state.data, { selectedId: state.selected, notes: sessionNotes(), validation: state.validation, ...opts }),
      buildUeWhiteboxSpec: () => (state.data ? window.WorkbenchGeometry.buildUeWhiteboxSpec(state.data) : null),
      evaluateMapMetrics: (opts = {}) => (state.data ? window.WorkbenchGeometry.evaluateMapMetrics(state.data, opts) : null),
      gradeBenchmarkCase: window.WorkbenchGeometry.gradeBenchmarkCase,
      setObjectState,
      resetStates,
    };
    if (!desktop) {
      if (params.get('style') === 'plan') setStyle('plan');
      if (params.get('cmp') && maps[params.get('cmp')]) setCompare(maps[params.get('cmp')], params.get('cmp'));
      if (params.get('view') === '3d') {
        view3d.setMode('3d').then(() => { if (params.get('pose')) view3d.setPose(params.get('pose')); });
      }
    }
  }

  init();
})();
