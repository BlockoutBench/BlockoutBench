/* Headless regression for the workbench (file://). Writes tools/out/workbench-check.json + screenshots.
   Needs `npm install` (playwright) and any installed Edge/Chrome; falls back to Playwright's own Chromium. */
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let chromium = null;
for (const candidate of [process.env.PLAYWRIGHT_PATH, 'playwright'].filter(Boolean)) {
  try {
    ({ chromium } = require(candidate));
    break;
  } catch {
    // next candidate
  }
}
if (!chromium) throw new Error('playwright not found: run `npm install` (or set PLAYWRIGHT_PATH)');

const root = path.resolve(__dirname, '..');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const pageUrl = hash => `${pathToFileURL(path.join(root, 'index.html')).href}${hash || ''}`;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'maps', 'manifest.json'), 'utf8')).maps.map(entry => entry.key);
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
// Maps whose rooms all have wallHeight 0 draw their walls as objects, so 3D has no room walls to count.
const openOnlyMaps = new Set(JSON.parse(fs.readFileSync(path.join(root, 'maps', 'manifest.json'), 'utf8')).maps
  .filter(entry => {
    const rooms = JSON.parse(fs.readFileSync(path.join(root, entry.file), 'utf8').replace(/^﻿/, '')).rooms || [];
    return rooms.length > 0 && rooms.every(room => room.wallHeight === 0);
  })
  .map(entry => entry.key));
const args = ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

async function launch() {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      return await chromium.launch({ channel, headless: true, args });
    } catch {
      // try the next browser
    }
  }
  throw new Error('no browser: install Edge/Chrome or run `npx playwright install chromium`');
}

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const wb = (fn, arg) => page.evaluate(fn, arg);
  const paste = async json => {
    const details = page.locator('details.wb-paste');
    if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
    await page.fill('#pasteInput', JSON.stringify(json));
    await page.click('#pasteBtn');
    await page.waitForTimeout(300);
  };
  await page.goto(pageUrl(), { waitUntil: 'load' });
  await page.waitForTimeout(600);
  const initial = await wb(() => ({
    maps: document.querySelectorAll('#mapList [data-map]').length,
    key: window.__workbench.state.key,
    pacing: document.querySelector('#pacingSummary')?.textContent || '',
    openPanels: [...document.querySelectorAll('.wb-side > details.wb-panel')].map(panel => panel.open),
  }));
  await wb(() => document.querySelectorAll('.wb-side > details.wb-panel').forEach(panel => { panel.open = true; }));

  // Every map loads without structural errors.
  const maps = {};
  for (const key of manifest) {
    await wb(value => window.__workbench.loadMap(value), key);
    await page.waitForTimeout(120);
    maps[key] = await wb(() => ({
      errors: window.__workbench.state.validation.errors.length,
      warnings: window.__workbench.state.validation.warnings.length,
      badge: document.querySelector('#healthBadge')?.textContent,
      tabs: document.querySelectorAll('#floorBar button').length,
    }));
  }

  // 2D: floor tab, click-select, inspector.
  await wb(() => window.__workbench.loadMap('sample-multifloor'));
  await page.click('#floorBar [data-floor="B1"]');
  await page.waitForTimeout(120);
  const floor = await wb(() => ({ active: document.querySelector('#floorBar .active')?.dataset.floor, rooms: document.querySelectorAll('.wb-room').length }));
  await wb(() => window.__workbench.loadMap('ai-sample'));
  await page.waitForTimeout(120);
  const clickPoint = await wb(() => {
    const screen = new DOMPoint(3, -3).matrixTransform(document.querySelector('#map').getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.waitForTimeout(120);
  const clicked = await wb(() => window.__workbench.state.selected);

  // Import: file, paste, and a broken map that must be refused.
  const beforeImport = await wb(() => document.querySelectorAll('#mapList [data-map]').length);
  await page.setInputFiles('#fileInput', path.join(root, 'AI_MAP_SAMPLE.json'));
  await page.waitForTimeout(350);
  const imported = await wb(() => document.querySelectorAll('#mapList [data-map]').length);
  await paste(readJson('tools/fixtures/bad-map.json'));
  const refused = await wb(() => ({ maps: document.querySelectorAll('#mapList [data-map]').length, toast: document.querySelector('#toast').textContent }));

  // Issues: a too-narrow door shows up as a warning, a ring on the map and a clickable list entry.
  const narrow = readJson('AI_MAP_SAMPLE.json');
  narrow.doors[0].width = 0.5;
  await paste(narrow);
  const issues = await wb(() => ({
    warnings: window.__workbench.state.validation.warnings.map(item => item.code),
    rings: document.querySelectorAll('.wb-issue').length,
    narrowDoors: document.querySelectorAll('.wb-door-narrow').length,
    buttons: document.querySelectorAll('#health [data-issue-id]').length,
  }));
  await wb(() => document.querySelectorAll('#health details').forEach(element => { element.open = true; }));
  await page.click('#health [data-issue-id="d_entry"]');
  await page.waitForTimeout(120);
  issues.selected = await wb(() => window.__workbench.state.selected);
  issues.inspector = await wb(() => document.querySelector('.wb-inspector-issues')?.innerText || '');
  await page.click('#layerList [data-layer="clearance"]');
  await page.waitForTimeout(100);
  issues.clearance = await wb(() => document.querySelectorAll('.wb-clearance').length);

  // SVG export.
  const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await page.click('#exportMenuBtn');
  await page.click('#exportBtn');
  const download = await downloadPromise;
  const svgText = download ? fs.readFileSync(await download.path(), 'utf8') : '';
  const exported = { bytes: svgText.length, ok: svgText.includes('<svg') && svgText.includes('wb-room') };

  // 3D: every map builds; new optional fields change the geometry as specified.
  const wait3d = () => page.waitForFunction(() => window.__workbench.view3d.ready || window.__workbench.view3d.error, null, { timeout: 15000 });
  await wb(() => window.__workbench.loadMap('ai-sample'));
  await page.click('#view3dBtn');
  await wait3d();
  const three = { error: await wb(() => window.__workbench.view3d.error), maps: {} };
  for (const key of manifest) {
    await wb(value => window.__workbench.loadMap(value), key);
    await page.waitForTimeout(200);
    three.maps[key] = await wb(() => ({ ready: window.__workbench.view3d.ready, ...window.__workbench.view3d.stats }));
    await page.screenshot({ path: path.join(out, `3d-${key}.png`) });
  }
  await wb(() => window.__workbench.loadMap('sample-multifloor'));
  await page.waitForTimeout(200);
  const pos = id => wb(value => window.__workbench.view3d.positions(value), id);
  const top = list => list.reduce((best, p) => (p[2] > best[2] ? p : best));
  const bottom = list => list.reduce((best, p) => (p[2] < best[2] ? p : best));
  const up = await pos('s_up'), down = await pos('s_down'), main = await pos('main');
  three.fields = {
    stairUpClimbsEast: top(up)[0] > bottom(up)[0],      // bottom: "W"
    stairDownLowEast: bottom(down)[0] > top(down)[0],   // bottom: "E"
    routeReaches2F: Math.max(...main.map(p => p[2])) > 3.5,
    walls: three.maps['sample-multifloor'].walls,
  };
  const walled = readJson('maps/sample-multifloor.json');
  delete walled.rooms.find(room => room.id === 'f1_court').wallHeight;
  await paste(walled);
  await page.waitForTimeout(250);
  three.fields.wallsIfCourtClosed = await wb(() => window.__workbench.view3d.stats.walls);

  // Spec extension sample: open edges, raised objects, object states, closed doors, proximity.
  const mechData = readJson('maps/sample-mechanisms.json');
  await wb(() => window.__workbench.loadMap('sample-mechanisms'));
  await page.waitForTimeout(250);
  const mech = { walls: await wb(() => window.__workbench.view3d.stats.walls), bell: await pos('o_bell_1'), gate: await pos('o_gate') };
  mech.closedDoor = await wb(() => [...document.querySelectorAll('#map [class*="wb-door-closed"]')].map(element => element.dataset.id));
  const noOpenEdges = JSON.parse(JSON.stringify(mechData));
  noOpenEdges.rooms.forEach(room => delete room.openEdges);
  await paste(noOpenEdges);
  await page.waitForTimeout(250);
  mech.wallsWithoutOpenEdges = await wb(() => window.__workbench.view3d.stats.walls);
  const gateOpen = JSON.parse(JSON.stringify(mechData));
  gateOpen.objects.find(object => object.id === 'o_gate').initialState = 'open';
  await paste(gateOpen);
  await page.waitForTimeout(250);
  mech.gateOpened = await pos('o_gate');
  mech.gateAbsent2d = await wb(() => !!document.querySelector('#map .wb-object-absent[data-id="o_gate"]'));
  mech.prox = await wb(data => [{}, { o_ding: 'slot_s' }, { o_ding: 'slot_s', o_gate: 'open' }].map(overrides => {
    const [rule] = window.WorkbenchGeometry.proximityGraph(data, overrides);
    return { links: rule.links.map(link => `${link.a}-${link.b}:${link.distance.toFixed(2)}`), near: rule.near.map(item => ({ pair: `${item.a}-${item.b}`, reason: item.reason, blockers: item.blockers })) };
  }), mechData);
  const mechLinks = [
    ['e_guard-o_lock_1:1.42', 'e_guard-o_pillar_b:5.45', 'o_bell_1-o_bell_2:3.00', 'o_bell_2-o_pillar_b:4.74', 'o_lock_1-o_pillar_b:5.34'],
  ];
  mechLinks.push([...mechLinks[0], 'o_bell_1-o_ding:5.15', 'o_ding-o_pillar_a:5.10'].sort());
  mechLinks.push([...mechLinks[1], 'o_lock_2-o_pillar_b:4.97'].sort());
  const sameList = (a, b) => a.length === b.length && [...a].sort().every((item, index) => item === [...b].sort()[index]);
  mech.proxOk = mech.prox.every((result, index) => sameList(result.links, mechLinks[index])) &&
    mech.prox[0].near.some(item => item.pair === 'o_lock_2-o_pillar_b' && item.reason === 'blocked' && JSON.stringify(item.blockers) === '["o_gate"]');
  // Proximity / links / states layers and the state preview.
  await wb(() => window.__workbench.loadMap('sample-mechanisms'));
  await page.waitForTimeout(250);
  const proxCount = () => wb(() => document.querySelectorAll('#map .wb-prox-link').length);
  mech.layers = await wb(() => [...document.querySelectorAll('#layerList [data-layer]')].map(element => element.dataset.layer));
  mech.proxLinks = [await proxCount()];
  await wb(() => window.__workbench.setObjectState('o_ding', 'slot_s'));
  mech.proxLinks.push(await proxCount());
  await wb(() => window.__workbench.setObjectState('o_gate', 'open'));
  mech.proxLinks.push(await proxCount());
  mech.resetShown = await wb(() => !document.querySelector('#resetStatesBtn').hidden);
  await page.waitForTimeout(250);
  mech.proxLines3d = await wb(() => window.__workbench.view3d.look.proxLines);
  await wb(() => window.__workbench.resetStates());
  mech.proxLinks.push(await proxCount());
  mech.resetHidden = await wb(() => document.querySelector('#resetStatesBtn').hidden);
  await page.click('#layerList [data-layer="links"]');
  await page.waitForTimeout(150);
  mech.linkLines = await wb(() => document.querySelectorAll('#map .wb-link').length);
  await wb(() => window.__workbench.select('lk_vault'));
  await page.waitForTimeout(100);
  mech.linkInspector = await wb(() => document.querySelector('#inspector').innerText);
  three.mech = mech;
  await wb(() => window.__workbench.loadMap('sample-multifloor'));
  await page.waitForTimeout(150);
  await page.click('#floorBar [data-floor="B1"]');
  await page.waitForTimeout(200);
  three.ghost = await wb(() => ({ rooms: window.__workbench.view3d.stats.room, ghosts: window.__workbench.view3d.stats.ghosts }));
  await page.screenshot({ path: path.join(out, '3d-multifloor-B1.png') });
  await page.click('#floorBar [data-floor="all"]');
  await page.waitForTimeout(200);
  await wb(() => window.__workbench.setMode('3d'));
  const target = await wb(() => window.__workbench.view3d.screenOf('e_hall'));
  const distBefore = await wb(() => window.__workbench.view3d.camera.dist);
  await page.mouse.dblclick(target.x, target.y);
  await page.waitForTimeout(250);
  three.focus = await wb(() => ({ selected: window.__workbench.state.selected, tag: window.__workbench.view3d.stats.tag, dist: window.__workbench.view3d.camera.dist, hash: location.hash }));
  three.focus.closer = three.focus.dist < distBefore;
  await page.screenshot({ path: path.join(out, '3d-multifloor-focus.png') });
  await wb(() => window.__workbench.select(null));
  await wb(() => window.__workbench.view3d.camera && window.__workbench.loadMap('sample-multifloor'));
  await page.click('#fitBtn');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(out, '3d-multifloor.png') });

  // UE-style camera (workbench-3d.js): free eye + orbit pivot; WASD works without any mouse button.
  const cam = () => wb(() => window.__workbench.view3d.camera);
  const flyState = () => wb(() => window.__workbench.view3d.fly);
  const hold = async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); await page.waitForTimeout(60); };
  const sub = (a, b) => a.map((value, i) => value - b[i]);
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const same = (a, b, eps = 1e-3) => a.every((value, i) => Math.abs(value - b[i]) < eps);
  const box3d = await page.locator('#gl3d').boundingBox();
  const cx = box3d.x + box3d.width / 2, cy = box3d.y + box3d.height / 2;
  await wb(() => window.__workbench.select(null));
  await page.mouse.move(cx, cy);
  await page.focus('#gl3d');
  const fly = {};
  let before = await cam();
  await hold('w', 250);
  fly.wWithoutRightButton = !same((await cam()).eye, before.eye);
  await page.mouse.down({ button: 'right' });
  before = await cam();
  await hold('w', 400);
  let after = await cam();
  const moved = sub(after.eye, before.eye);
  fly.forward = +dot(moved, before.forward).toFixed(2);
  fly.drift = +Math.hypot(...sub(moved, before.forward.map(value => value * fly.forward))).toFixed(3);
  fly.pivotKept = same(after.pivot, before.pivot);
  await hold('e', 300);
  fly.rose = +((await cam()).eye[1] - after.eye[1]).toFixed(2);
  await page.keyboard.down('z');
  await page.waitForTimeout(300);
  fly.fovWide = (await cam()).fov;
  await page.keyboard.up('z');
  await page.waitForTimeout(60);
  fly.fovBack = (await cam()).fov;
  const levelBefore = (await flyState()).level;
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(60);
  fly.speedUp = (await flyState()).level > levelBefore;
  before = await cam();
  await page.mouse.move(cx + 90, cy + 30, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(60);
  after = await cam();
  fly.lookEyeFixed = same(after.eye, before.eye);
  fly.lookTurned = Math.abs(after.yaw - before.yaw) > .1;
  fly.rightClickNoSelect = (await wb(() => window.__workbench.state.selected)) === null;
  fly.rightReleased = !(await flyState()).rmb;
  before = after;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 80, { steps: 6 });
  await page.mouse.up();
  after = await cam();
  const walked = sub(after.eye, before.eye);
  fly.walkFlat = Math.abs(walked[1]) < 1e-6;
  fly.walkForward = dot(walked, [after.forward[0], 0, after.forward[2]]) > .5;
  before = after;
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 60, cy - 40, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  after = await cam();
  fly.panKeepsView = after.yaw === before.yaw && after.pitch === before.pitch && !same(after.eye, before.eye);
  before = after;
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(cx + 160, cy - 40, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  after = await cam();
  const toPivot = sub(after.pivot, after.eye).map(value => value / after.dist);
  fly.orbitKeepsDistance = Math.abs(after.dist - before.dist) < .01;
  fly.orbitFacesPivot = dot(toPivot, after.forward) > .999;
  before = after;
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(80);
  after = await cam();
  fly.wheelForward = dot(sub(after.eye, before.eye), before.forward) > .3;
  before = after;
  await page.focus('#gl3d');
  await hold('ArrowUp', 250);
  after = await cam();
  fly.arrowMoves = dot(sub(after.eye, before.eye), before.forward) > .3;
  await page.focus('#pasteInput');
  await hold('ArrowUp', 250);
  fly.typingIgnored = same((await cam()).eye, after.eye);
  three.fly = fly;
  await page.click('#view2dBtn');
  await page.waitForTimeout(150);
  three.back2d = await wb(() => ({ mode: window.__workbench.state.mode, svgVisible: !document.querySelector('#map').hidden, hash: location.hash }));
  await page.screenshot({ path: path.join(out, '2d-multifloor.png') });

  // Outline, pacing ↔ map, heatmap (2D) — then 3D: heat planes, cursor, 2.5D, cutaway, shadows.
  const extra = {};
  await wb(() => window.__workbench.loadMap('sample-multifloor'));
  await page.waitForTimeout(150);
  await page.click('#floorBar [data-floor="B1"]');
  await page.fill('#outlineSearch', '守卫长');
  await page.waitForTimeout(100);
  extra.outlineHits = await wb(() => [...document.querySelectorAll('#outline [data-outline-id]')].map(element => element.dataset.outlineId));
  await page.click('#outline [data-outline-id="e_boss"]');
  await page.waitForTimeout(150);
  extra.outline = await wb(() => ({ selected: window.__workbench.state.selected, floor: window.__workbench.state.floor, active: document.querySelector('#outline .active')?.dataset.outlineId }));
  await page.fill('#outlineSearch', '');
  await page.click('#floorBar [data-floor="all"]');
  await page.waitForTimeout(100);
  const chartBox = await page.locator('#pacingChart').boundingBox();
  const chartAt = t => [chartBox.x + chartBox.width * t, chartBox.y + chartBox.height * .55];
  await page.mouse.move(...chartAt(.75));
  await page.waitForTimeout(120);
  extra.pace2d = await wb(() => ({ cursor: !!document.querySelector('#wbPaceCursor'), label: document.querySelector('.wb-pace-label')?.textContent || '', at: window.__workbench.state.paceCursor }));
  await page.mouse.click(...chartAt(.75));
  await page.waitForTimeout(120);
  extra.pace2d.centered = await wb(() => {
    const { view, paceCursor } = window.__workbench.state;
    return Math.abs(view.x + view.w / 2 - paceCursor.x) < .01 && Math.abs(-(view.y + view.h / 2) - paceCursor.z) < .01;
  });
  await page.mouse.move(chartBox.x - 20, chartBox.y - 20);
  await page.waitForTimeout(80);
  extra.pace2d.cleared = await wb(() => !document.querySelector('#wbPaceCursor'));
  await page.click('#layerList [data-layer="heat"]');
  await page.waitForTimeout(250);
  extra.heat2d = await wb(() => document.querySelectorAll('.wb-heat').length);
  await page.screenshot({ path: path.join(out, '2d-heat.png') });

  await page.click('#view3dBtn');
  await page.waitForTimeout(250);
  extra.heat3d = await wb(() => window.__workbench.view3d.look.heatPlanes);
  await page.mouse.move(...chartAt(.75));
  await page.waitForTimeout(120);
  extra.cursor3d = await wb(() => window.__workbench.view3d.look.cursor);
  const pivotBefore = (await cam()).pivot;
  await page.mouse.click(...chartAt(.75));
  await page.waitForTimeout(120);
  extra.lookAt3d = !same((await cam()).pivot, pivotBefore);
  await page.mouse.move(chartBox.x - 20, chartBox.y - 20);
  await page.click('#layerList [data-layer="heat"]');
  await page.waitForTimeout(150);
  extra.look = await wb(() => window.__workbench.view3d.look);
  await page.click('#cutBtn');
  await page.waitForTimeout(150);
  extra.uncutTop = (await wb(() => window.__workbench.view3d.look)).wallTop;
  await page.click('#cutBtn');
  await page.click('#shadowBtn');
  await page.waitForTimeout(150);
  extra.shadowsOff = (await wb(() => window.__workbench.view3d.look)).shadowCasters;
  await page.click('#shadowBtn');
  await page.click('#viewIsoBtn');
  await page.click('#fitBtn');
  await page.waitForTimeout(150);
  const iso0 = await cam();
  await page.click('#rotRightBtn');
  await page.waitForTimeout(60);
  const iso1 = await cam();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy + 20, { steps: 5 });
  await page.mouse.up();
  const iso2 = await cam();
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(80);
  const iso3 = await cam();
  await page.click('#fitBtn');
  await page.waitForTimeout(100);
  const isoTarget = await wb(() => window.__workbench.view3d.screenOf('e_hall'));
  await page.mouse.click(isoTarget.x, isoTarget.y);
  await page.waitForTimeout(120);
  extra.iso = {
    freePerspective: !iso0.ortho && iso0.view === 'iso', pitch45: Math.abs(iso0.pitch - Math.PI / 4) < 1e-6,
    rotated90: Math.abs(iso1.yaw - iso0.yaw - Math.PI / 2) < 1e-6,
    leftDragMovesEye: !same(iso2.eye, iso1.eye), leftDragStaysOnGround: Math.abs(iso2.eye[1] - iso1.eye[1]) < 1e-6,
    wheelMovesEye: !same(iso3.eye, iso2.eye),
    clickSelect: (await wb(() => window.__workbench.state.selected)) === 'e_hall',
    hash: await wb(() => location.hash),
  };
  await page.screenshot({ path: path.join(out, '3d-iso-check.png') });
  await page.click('#viewPerspBtn');
  await page.waitForTimeout(80);
  extra.backPersp = !(await cam()).ortho && !(await wb(() => location.hash)).includes('cam=iso');
  await page.click('#view2dBtn');
  three.extra = extra;

  // Batch 2: merged 3D drawing, minimap, extraction distance, plan style, version compare.
  const batch = {};
  // Extraction distance on a multi-floor variant with one exit on 2F: stairs carry it down.
  const withExit = readJson('maps/sample-multifloor.json');
  withExit.meta.title = 'AI 样本 · 三层庭院（2F 撤离点）';
  withExit.objects.push({ id: 'x_roof', name: '天台撤离点', kind: 'extract', floorId: '2F', points: [[24, 15], [25.5, 15], [25.5, 16.5], [24, 16.5]] });
  await paste(withExit);
  await page.click('#layerList [data-layer="exits"]');
  await page.waitForTimeout(300);
  batch.exits = await wb(() => ({
    panel: document.querySelector('#exitPanel').innerText,
    images: document.querySelectorAll('.wb-exitfield').length,
    pins: document.querySelectorAll('.wb-exit-pin').length,
  }));
  await page.click('#floorBar [data-floor="B1"]');
  await page.waitForTimeout(200);
  const storeAt = await wb(() => {
    const screen = new DOMPoint(11, -16).matrixTransform(document.querySelector('#map').getScreenCTM());
    return [screen.x, screen.y];
  });
  await page.mouse.move(...storeAt);
  await page.waitForTimeout(100);
  batch.exits.tipB1 = await wb(() => document.querySelector('#mapTip').hidden ? '' : document.querySelector('#mapTip').textContent);
  await page.click('#floorBar [data-floor="all"]');
  await page.click('#layerList [data-layer="exits"]');
  await page.waitForTimeout(100);
  // Plan style.
  await page.click('#stylePlanBtn');
  await page.waitForTimeout(150);
  batch.plan = await wb(() => ({
    walls: document.querySelectorAll('.wb-wall').length, open: document.querySelectorAll('.wb-wall-open').length,
    swings: document.querySelectorAll('.wb-door-swing').length, treads: document.querySelectorAll('.wb-tread').length,
    arrows: document.querySelectorAll('.wb-stair-arrow').length, hash: location.hash,
  }));
  await page.screenshot({ path: path.join(out, '2d-plan.png') });
  await page.click('#styleSchemaBtn');
  // Compare the variant against the original sample.
  await page.click('#compareBtn');
  await page.selectOption('#compareSelect', 'sample-multifloor');
  await page.waitForTimeout(150);
  batch.compare = await wb(() => ({
    counts: document.querySelector('#diffPanel .counts')?.innerText || '',
    added: document.querySelectorAll('.wb-diff-added').length,
    ids: [...document.querySelectorAll('#diffPanel [data-diff-id]')].map(element => element.dataset.diffId),
  }));
  await page.selectOption('#compareSelect', '');
  batch.compare.cleared = await wb(() => document.querySelector('#diffPanel').hidden && !document.querySelector('.wb-diff-added'));
  // 3D: merged drawing and minimap.
  await page.click('#view3dBtn');
  await page.waitForTimeout(250);
  batch.look = await wb(() => window.__workbench.view3d.look);
  batch.walls = await wb(() => window.__workbench.view3d.stats.walls);
  const miniBox = await page.locator('#gl3dMini').boundingBox();
  const pivotBeforeMini = (await cam()).pivot;
  await page.mouse.click(miniBox.x + miniBox.width * .8, miniBox.y + miniBox.height * .3);
  await page.waitForTimeout(150);
  batch.miniMoved = !same((await cam()).pivot, pivotBeforeMini);
  await page.click('#miniBtn');
  await page.waitForTimeout(80);
  batch.miniHidden = await wb(() => document.querySelector('#gl3dMini').hidden);
  await page.click('#miniBtn');
  await page.click('#view2dBtn');
  three.batch = batch;

  // Batch 3: label levels, measure, review notes, stats, link state, help, panels, theme, drop.
  const b3 = {};
  await wb(() => { localStorage.clear(); window.__workbench.loadMap('ai-sample'); });
  await page.waitForTimeout(150);
  const objectLabels = () => wb(() => document.querySelectorAll('.wb-object-label').length);
  b3.labelsNear = await objectLabels();
  for (let i = 0; i < 4; i++) await page.click('#zoomOut');
  await page.waitForTimeout(100);
  b3.labelsFar = await objectLabels();
  await page.click('#fitBtn');
  await page.waitForTimeout(400);   // 全图 now glides the view (280 ms); wait before reading screen coordinates
  const atPlan = (x, z) => wb(([px, pz]) => {
    const screen = new DOMPoint(px, -pz).matrixTransform(document.querySelector('#map').getScreenCTM());
    return [screen.x, screen.y];
  }, [x, z]);
  await page.focus('#map');
  await page.keyboard.press('m');
  for (const [x, z] of [[4, 4], [7, 4], [7, 8], [4, 4]]) await page.mouse.click(...await atPlan(x, z));
  b3.measure = await wb(() => document.querySelector('#measureReadout').innerText);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('n');
  await page.mouse.click(...await atPlan(16, 8));
  b3.noteTarget = await wb(() => document.querySelector('#noteTarget').textContent);
  await page.keyboard.type('祭台缩小一半');
  await page.keyboard.press('Enter');
  await page.mouse.click(...await atPlan(31, 20));
  await page.keyboard.type('这里加掩体');
  await page.keyboard.press('Enter');
  const exportPromise = page.waitForEvent('download', { timeout: 5000 });
  await page.click('#notesExport');
  const exportedMap = JSON.parse(fs.readFileSync(await (await exportPromise).path(), 'utf8'));
  b3.exported = { notes: exportedMap.reviewNotes.length, valid: await wb(map => window.__workbench.validate(map).errors.length === 0, exportedMap), free: exportedMap.reviewNotes.some(note => !note.targetId && Array.isArray(note.at)) };
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  b3.stats = await wb(() => ({ open: !document.querySelector('#statsPanel').hidden, rows: document.querySelectorAll('#statsBody tbody tr').length }));
  await page.click('#statsBody tbody tr');
  b3.stats.locate = await wb(() => document.querySelector('#statsPanel').hidden && !!window.__workbench.state.selected);
  await page.keyboard.press('Shift+Slash');
  b3.help = await wb(() => !document.querySelector('#helpPanel').hidden);
  await page.keyboard.press('Escape');
  await page.keyboard.press('[');
  await page.waitForTimeout(320);
  b3.collapsed = await wb(() => {
    const side = document.querySelector('.wb-side');
    const style = getComputedStyle(side);
    return document.querySelector('.wb-main').classList.contains('hide-left')
      && side.getBoundingClientRect().width <= 1
      && (style.display === 'none' || style.visibility === 'hidden');
  });
  await page.keyboard.press('[');
  await page.waitForTimeout(320);
  await page.click('#themeBtn');
  b3.dark = await wb(() => document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.body).backgroundColor !== 'rgb(248, 245, 235)');
  await page.click('#themeBtn');
  await page.click('#layerList [data-layer="heat"]');
  await page.click('#floorBar [data-floor="1F"]');
  b3.hash = await wb(() => location.hash);
  const linked = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await linked.goto(pageUrl(`#${b3.hash.split('#')[1] || b3.hash.replace(/^#/, '')}`), { waitUntil: 'load' });
  await linked.waitForTimeout(500);
  b3.restored = await linked.evaluate(() => ({ floor: window.__workbench.state.floor, heat: window.__workbench.state.layers.heat }));
  const dropped = await linked.evaluateHandle(json => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([json], 'dropped.json', { type: 'application/json' }));
    return transfer;
  }, fs.readFileSync(path.join(root, 'AI_MAP_SAMPLE.json'), 'utf8'));
  const beforeDrop = await linked.evaluate(() => document.querySelectorAll('#mapList [data-map]').length);
  await linked.dispatchEvent('body', 'drop', { dataTransfer: dropped });
  await linked.waitForTimeout(300);
  b3.dropped = (await linked.evaluate(() => document.querySelectorAll('#mapList [data-map]').length)) - beforeDrop;
  await linked.close();
  await page.click('#layerList [data-layer="heat"]');
  await page.click('#floorBar [data-floor="all"]');
  three.b3 = b3;

  const deep = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await deep.goto(pageUrl('#map=sample-multifloor&view=3d'), { waitUntil: 'load' });
  await deep.waitForFunction(() => window.__workbench?.view3d.ready || window.__workbench?.view3d.error, null, { timeout: 15000 });
  three.deepLink = await deep.evaluate(() => ({ key: window.__workbench.state.key, mode: window.__workbench.state.mode, ready: window.__workbench.view3d.ready }));
  await deep.close();


  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const mobileErrors = [];
  mobile.on('pageerror', error => mobileErrors.push(String(error)));
  await mobile.goto(pageUrl(), { waitUntil: 'load' });
  await mobile.waitForTimeout(400);
  await mobile.click('#view3dBtn');
  await mobile.waitForFunction(() => window.__workbench.view3d.ready || window.__workbench.view3d.error, null, { timeout: 15000 });
  const mobileInfo = await mobile.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, ready3d: window.__workbench.view3d.ready }));
  await mobile.screenshot({ path: path.join(out, '3d-mobile.png') });
  await mobile.close();

  const checks = {
    initial: initial.maps === manifest.length && initial.key === 'ai-sample' && initial.pacing.includes('主线') &&
      JSON.stringify(initial.openPanels) === '[true,false,false,false,false]',
    mapsLoad: Object.values(maps).every(value => value.errors === 0 && value.badge.startsWith('通过')),
    samplesClean: maps['ai-sample'].warnings === 0 && maps['sample-multifloor'].warnings === 0,
    floorTab: floor.active === 'B1' && floor.rooms === 1,
    click2d: clicked === 'r_entry',
    importFile: imported === beforeImport + 1,
    importRefused: refused.maps === imported && refused.toast.includes('导入失败'),
    issues: issues.warnings.includes('door-narrow') && issues.rings > 0 && issues.narrowDoors === 1 && issues.buttons > 0 &&
      issues.selected === 'd_entry' && issues.inspector.includes('玩家直径') && issues.clearance === narrow.routes.length,
    export: exported.ok && exported.bytes > 1000,
    threeAllMaps: !three.error && Object.entries(three.maps).every(([key, value]) => value.ready && value.room > 0 && (value.walls > 0 || openOnlyMaps.has(key))),
    stairsBottom: three.fields.stairUpClimbsEast && three.fields.stairDownLowEast,
    routeY: three.fields.routeReaches2F,
    openRoom: three.fields.wallsIfCourtClosed > three.fields.walls,
    mechOpenEdges: three.mech.walls < three.mech.wallsWithoutOpenEdges,
    mechRaised: three.mech.bell.length > 0 && Math.min(...three.mech.bell.map(p => p[3])) >= 2.45 && Math.min(...three.mech.bell.map(p => p[3])) <= 2.55,
    mechAbsent: three.mech.gate.length > 0 && three.mech.gateOpened.length === 0 && three.mech.gateAbsent2d,
    mechClosedDoor: three.mech.closedDoor.includes('d_vault'),
    mechProximity: three.mech.proxOk,
    mechLayers: ['proximity', 'links', 'states'].every(key => three.mech.layers.includes(key)),
    mechProxLayer: three.mech.proxLinks[0] === 5,
    mechStatePreview: JSON.stringify(three.mech.proxLinks) === '[5,7,8,5]',
    mechLinksLayer: three.mech.linkLines === 3,
    mechLinkSelect: ['接收器 1', '接收器 2', '宝库门'].every(text => three.mech.linkInspector.includes(text)),
    ghostFloors: three.ghost.rooms === 1 && three.ghost.ghosts > 0,
    focus: three.focus.selected === 'e_hall' && three.focus.tag && three.focus.closer && three.focus.hash.includes('view=3d'),
    flyCamera: three.fly.wWithoutRightButton && three.fly.forward > 1 && three.fly.drift < .05 && three.fly.pivotKept && three.fly.rose > .5 &&
      three.fly.fovWide > 50 && three.fly.fovBack === 45 && three.fly.speedUp && three.fly.lookEyeFixed && three.fly.lookTurned &&
      three.fly.rightClickNoSelect && three.fly.rightReleased && three.fly.walkFlat && three.fly.walkForward && three.fly.panKeepsView &&
      three.fly.orbitKeepsDistance && three.fly.orbitFacesPivot && three.fly.wheelForward && three.fly.arrowMoves && three.fly.typingIgnored,
    outline: three.extra.outlineHits.length === 1 && three.extra.outline.selected === 'e_boss' && three.extra.outline.floor === '2F' && three.extra.outline.active === 'e_boss',
    paceLink: three.extra.pace2d.cursor && three.extra.pace2d.label.includes('压力') && three.extra.pace2d.centered && three.extra.pace2d.cleared &&
      three.extra.cursor3d && three.extra.lookAt3d,
    heatmap: three.extra.heat2d === 1 && three.extra.heat3d >= 3,
    isoView: Object.entries(three.extra.iso).every(([key, value]) => key === 'hash' ? value.includes('cam=iso') : value) && three.extra.backPersp,
    solidWalls: three.extra.look.cutaway && Math.abs(three.extra.look.wallTop - 1.2) < 1e-6 && three.extra.uncutTop > 1.2 &&
      three.extra.look.shadows && three.extra.look.shadowCasters > 0 && three.extra.shadowsOff === 0,
    exitDistance: three.batch.exits.panel.includes('天台撤离点') && three.batch.exits.images === 3 && three.batch.exits.pins === 1 &&
      !three.batch.exits.panel.includes('到不了出口') && !three.batch.exits.panel.includes('没有出口') && /到最近出口 \d/.test(three.batch.exits.tipB1),
    planStyle: three.batch.plan.walls > 10 && three.batch.plan.open === 1 && three.batch.plan.swings === 3 && three.batch.plan.treads > 10 &&
      three.batch.plan.arrows === 2 && three.batch.plan.hash.includes('style=plan'),
    compare: three.batch.compare.counts.includes('+1') && three.batch.compare.added === 1 && three.batch.compare.ids.includes('x_roof') && three.batch.compare.cleared,
    merged3d: three.batch.walls > 10 && three.batch.look.drawables < 80,
    minimap: three.batch.look.mini && three.batch.miniMoved && three.batch.miniHidden,
    labelLevels: three.b3.labelsNear > 0 && three.b3.labelsFar === 0,
    measureTool: three.b3.measure.includes('总长 12 m') && three.b3.measure.includes('面积 6 m²'),
    reviewNotes: three.b3.noteTarget.includes('中央祭台') && three.b3.exported.notes === 3 && three.b3.exported.valid && three.b3.exported.free,
    statsPanel: three.b3.stats.open && three.b3.stats.rows === 3 && three.b3.stats.locate,
    shell: three.b3.help && three.b3.collapsed && three.b3.dark && three.b3.hash.includes('layers=heat') && three.b3.hash.includes('floor=1F') &&
      three.b3.restored.floor === '1F' && three.b3.restored.heat && three.b3.dropped === 1,
    back2d: three.back2d.mode === '2d' && three.back2d.svgVisible && !three.back2d.hash.includes('view=3d'),
    deepLink: three.deepLink.key === 'sample-multifloor' && three.deepLink.mode === '3d' && three.deepLink.ready,
    mobile: mobileInfo.scrollWidth <= mobileInfo.width && mobileInfo.ready3d && mobileErrors.length === 0,
    noConsoleErrors: errors.length === 0,
  };
  const ok = Object.values(checks).every(Boolean);
  const result = { ok, checks, initial, maps, floor, clicked, refused, issues, exported, three, mobile: mobileInfo, errors };
  fs.writeFileSync(path.join(out, 'workbench-check.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ok, checks, failed: Object.keys(checks).filter(key => !checks[key]), errors }, null, 2));
  // Playwright can throw TargetClosedError while tearing down; the verdict is already written.
  const exit = () => process.exit(ok ? 0 : 1);
  process.on('uncaughtException', exit);
  process.on('unhandledRejection', exit);
  await browser.close().catch(() => {});
  exit();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
