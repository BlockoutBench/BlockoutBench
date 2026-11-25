/* Benchmark scorer (sample). Scores one answer map against one question folder.
     node benchmark/score.cjs benchmark/Q001 benchmark/Q001/参考答案.json
   Layer 1 (gate): validator + hard constraints. Layer 2: measurable design targets
   taken from question.json. Layer 3 (review questions) is for a human or AI judge. */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
global.window = {};
require(path.join(root, 'viewer-pacing.js'));
const { validate } = require(path.join(root, 'map-validate.js'));
const G = require(path.join(root, 'map-geometry.js'));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

const [dir, answerFile] = process.argv.slice(2);
if (!dir || !answerFile) {
  console.error('usage: node benchmark/score.cjs <question dir> <answer.json>');
  process.exit(2);
}
const question = readJson(path.join(dir, 'question.json'));
const task = readJson(path.join(dir, question.taskMap));
const answer = readJson(answerFile);
const T = question.targets;
const round = (value, digits = 2) => (Number.isFinite(value) ? +value.toFixed(digits) : value);

const GROUPS = ['rooms', 'objects', 'enemies', 'doors', 'routes', 'stairs', 'water', 'links'];
const entities = data => new Map(GROUPS.flatMap(group => (data[group] || []).map(item => [item.id, item])));
const centre = points => [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];

// Layer 1: gate.
const result = validate(answer);
const taskIds = [...entities(task).keys()].sort(), answerIds = [...entities(answer).keys()].sort();
const gate = {
  errors: result.errors.length,
  warnings: result.warnings.length,
  warningCodes: [...new Set(result.warnings.map(item => item.code))],
  sameIds: JSON.stringify(taskIds) === JSON.stringify(answerIds),
  sameBounds: JSON.stringify(task.meta.bounds) === JSON.stringify(answer.meta?.bounds),
};
gate.pass = gate.errors <= question.hard.maxErrors && gate.warnings <= question.hard.maxWarnings &&
  (!question.hard.sameIds || gate.sameIds) && (!question.hard.sameBounds || gate.sameBounds);

// Layer 2: design targets.
const weights = {};
for (const enemy of answer.enemies || []) weights[enemy.enemyType] = enemy.tier === 'boss' ? 6 : enemy.tier === 'elite' ? 3 : 1;
const pacing = window.ViewerPacing.compute({ routes: answer.routes, enemies: answer.enemies || [], rooms: answer.rooms || [], weights });
const metrics = [];
const metric = (id, label, value, pass, target) => metrics.push({ id, label, value, target, pass: !!pass });

if (pacing) {
  const position = pacing.peak.s / pacing.L;
  metric('peakLate', '最高压力出现在主线的位置', round(position), position >= T.peakPositionMin, `≥ ${T.peakPositionMin}`);
  const rest = Math.max(0, ...pacing.rest.filter(([, end]) => end <= pacing.peak.s).map(([start, end]) => end - start));
  metric('restBeforePeak', '高潮前最长的休息段（米）', round(rest, 1), rest >= T.restBeforePeakMin, `≥ ${T.restBeforePeakMin}`);
  const early = Math.max(...pacing.samples.filter(sample => sample.s <= pacing.L * T.warmupSpan).map(sample => sample.p));
  metric('warmup', `前 ${T.warmupSpan * 100}% 路程的最高压力 / 全程峰值`, round(early / pacing.peak.v), early / pacing.peak.v <= T.warmupRatioMax, `≤ ${T.warmupRatioMax}`);
}

// Walkable area that cannot reach any extraction point (doors only, solids block).
const b = answer.meta.bounds;
let walkable = 0, unreachable = 0;
for (const floor of answer.floors || []) {
  const rooms = (answer.rooms || []).filter(room => room.floorId === floor.id && room.points?.length >= 3);
  if (!rooms.length) continue;
  const field = G.distanceField({
    rooms,
    doors: (answer.doors || []).filter(door => door.floorId === floor.id),
    solids: (answer.objects || []).filter(object => object.solid === true && object.floorId === floor.id && !object.states?.length),
    sources: (answer.objects || []).filter(object => object.kind === 'extract' && object.floorId === floor.id).map(object => ({ points: object.points })),
    bounds: b,
    cell: 0.4,
  });
  walkable += field.walkable;
  unreachable += field.unreachable;
}
const share = walkable ? unreachable / walkable : 1;
metric('reachable', '到不了撤离点的可走面积占比', round(share, 3), share <= T.unreachableMax, `≤ ${T.unreachableMax}`);

// Every optional route ends at something worth the detour.
// A reward is something the player gains (loot / interaction); an optional enemy alone is not one.
const rewards = (answer.objects || []).filter(object => ['loot', 'interaction'].includes(object.kind) && object.points?.length).map(object => centre(object.points));
const optional = (answer.routes || []).filter(route => route.kind === 'optional' && route.points?.length);
const gaps = optional.map(route => {
  const end = route.points[route.points.length - 1];
  return Math.min(Infinity, ...rewards.map(reward => Math.hypot(reward[0] - end[0], reward[1] - end[1])));
});
const worst = gaps.length ? Math.max(...gaps) : 0;
metric('optionalPayoff', '可选路线终点到最近回报的距离（米）', round(worst, 1), worst <= T.optionalPayoffRadius, `≤ ${T.optionalPayoffRadius}`);

// Nothing outside the defects was touched.
const before = entities(task), after = entities(answer);
const touched = [...before.keys()].filter(id => !question.mayChange.includes(id) && after.has(id) && JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)));
metric('collateral', '不该动却被改了的实体数', touched.length, touched.length === 0, '= 0');

const passed = metrics.filter(item => item.pass).length;
const score = gate.pass ? Math.round(passed / metrics.length * 100) : 0;
const report = { question: question.id, answer: path.basename(answerFile), gate, metrics, touched, design: `${passed}/${metrics.length}`, score };
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`\n${report.question} · ${report.answer}`);
  console.log(`  第一层 及格线：${gate.pass ? '通过' : '未通过'}（错误 ${gate.errors}，告警 ${gate.warnings}${gate.warningCodes.length ? ' ' + gate.warningCodes.join('/') : ''}，ID 一致 ${gate.sameIds}，外框一致 ${gate.sameBounds}）`);
  for (const item of metrics) console.log(`  ${item.pass ? '✓' : '✗'} ${item.label}：${item.value}（目标 ${item.target}）`);
  console.log(`  第二层 设计指标：${report.design}　总分：${score}${gate.pass ? '' : '（未过及格线，记 0 分）'}`);
}
