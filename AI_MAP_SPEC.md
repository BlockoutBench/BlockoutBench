# AI 关卡设计输出规范（便携版）

**用途**：这是通用 HTML 工作台的原生地图格式。把这份文件和示例 JSON 一起交给任何 AI/智能体，让它直接输出工作台能打开、能校验的地图。  
工作台里所有地图都用这一种格式，不为某张地图单独维护页面或适配器。

## 怎么进工作台

1. 让 AI 只输出 JSON，保存为 `.json`。
2. 打开 `index.html`。
3. 点右上“导入 JSON”；校验通过后自动成为一张地图。
4. 如果校验报错，把错误交给 AI 修，不要直接改 `maps.js`。

## 给 AI 的硬规则

1. **只输出 JSON**，不要 Markdown 代码块、不要解释、不要前后缀。
2. 单位统一为**米**；坐标是平面 `X/Z`：`x` 越大越靠东（图上向右），`z` 越大越靠北（图上向上）。工作台 SVG 用 `y = -z` 画，所以北在上；3D 里标高是第三个轴，来自 `floors[].elevation`。
3. 顶层必须有 `schemaVersion`、`meta`、`floors`、`rooms`、`routes`。
4. 所有 ID 必须匹配 `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`，全文件唯一，新增后不要复用。
5. 每个房间/物件/敌人/门/路线都必须有存在的 `floorId`。
6. 房间是**有序多边形**，至少 3 个点；同层房间不要重叠。
7. 门是两个点组成的线段，必须落在房间边界上；`width` 是门洞宽度。
8. 必须有一条 `kind: "main"` 的路线；点按行进顺序排列，起终点在房间内。
9. 敌人 `center` 必须落在同层某个房间内，并用 `roomId` 指向它。
10. 不要写 Unity 字段（Prefab、MonoBehaviour、Transform、NavMesh 等）；这里只表达设计意图。

## 最小输出骨架

```json
{
  "schemaVersion": 1,
  "meta": {
    "title": "关卡名",
    "units": "m",
    "bounds": { "minX": 0, "minZ": 0, "maxX": 32, "maxZ": 24 },
    "provenance": {
      "kind": "design",
      "label": "AI 设计 · v1",
      "source": "AI_MAP_SPEC.md",
      "generatedAt": "2026-10-23"
    },
    "player": {
      "radius": 0.35,
      "height": 1.7,
      "walkSpeed": 4,
      "rollDistance": 3,
      "rollDuration": 0.3,
      "interactionRange": 2
    }
  },
  "floors": [
    { "id": "1F", "name": "1F", "elevation": 0, "height": 3.6 }
  ],
  "rooms": [
    {
      "id": "r_entry",
      "name": "入口门厅",
      "kind": "room",
      "status": "planned",
      "floorId": "1F",
      "color": "#e7dcc5",
      "points": [[2, 2], [10, 2], [10, 10], [2, 10]]
    }
  ],
  "objects": [],
  "enemies": [],
  "doors": [],
  "routes": [
    {
      "id": "main",
      "name": "主线",
      "kind": "main",
      "floorId": "1F",
      "points": [[3, 6], [10, 6], [16, 6], [26, 8]]
    }
  ],
  "reviewNotes": []
}
```

## 字段说明

### `meta`

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 关卡名 |
| `units` | 是 | 固定 `"m"` |
| `bounds` | 是 | `{minX,minZ,maxX,maxZ}`，所有几何必须落在里面 |
| `provenance.kind` | 是 | `design`（AI 设计）或 `scene-snapshot`（场景快照） |
| `provenance.label` | 是 | 人类可读来源名 |
| `provenance.source` | 是 | 来源文件/工具 |
| `provenance.generatedAt` | 是 | `design` 用生成日期；快照用 `snapshotDate` |
| `player` | 是 | 玩家尺度；用于校验门宽、路线净空 |
| `legendLabels` | 否 | 路线图例，如 `{ "main": "主线", "optional": "可选" }` |
| `proximity` | 否 | 邻近规则数组：某几类东西离得够近就算相连，见下方“邻近规则（meta.proximity）” |
| `kindLegend` | 否 | 种类说明表，object；键为 `kind` 或 `enemyType`，值为 `{ label, note? }`：`label` 必填、非空字符串，是显示名；`note` 可选，说明这个种类是什么、做什么 |

### `floors[]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 如 `B1` / `1F` / `2F` |
| `name` | 是 | 显示名 |
| `elevation` | 是 | 相对标高，米；可以负数 |
| `height` | 是 | 层高，米 |

### `rooms[]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `name` | 是 | 唯一 ID / 显示名 |
| `kind` | 是 | 推荐 `room` / `corridor` / `atrium` / `gallery` |
| `status` | 是 | `existing` / `planned` / `adjusted` / `preview` / `annotation` |
| `floorId` | 是 | 所属楼层 |
| `points` | 是 | 有序多边形，至少 3 个 `[x,z]` |
| `color` | 否 | `#rrggbb`，仅显示用 |
| `code` | 否 | 图上编号，如 `01` / `III` |
| `label` | 否 | 房间名放置点 `[x,z]`；省略则用多边形中心 |
| `wallHeight` | 否 | 3D 墙高，米；`0` = 露天/开放空间（中庭、庭院、广场），这条边不生成墙；省略则约为层高×0.8（上限 2.4） |
| `openEdges` | 否 | 整数数组：不砌墙的边的序号。第 `i` 条边 = `points[i]` → `points[(i+1) % n]`，从 0 起 |

### `objects[]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `name` | 是 | 唯一 ID / 显示名 |
| `kind` | 是 | 推荐 `altar` / `display` / `cover` / `bench` / `column` / `water` / `artifact` / `other`；撤离点用 `extract` |
| `floorId` | 是 | 所属楼层 |
| `points` | 是 | 占地多边形，至少 3 个 `[x,z]` |
| `solid` | 否 | 是否阻挡通行，默认 `false` |
| `color` | 否 | `#rrggbb`，仅显示用 |
| `height` | 否 | 体块高度，米；默认按类型估算 |
| `baseHeight` | 否 | number ≥ 0，默认 `0`。物件底面高出所属楼层标高多少米。`0` = 落地 |
| `walkable` | 否 | boolean，默认 `false`。顶面能否站人。顶面标高 = 楼层标高 + `baseHeight` + `height` |
| `states` | 否 | array，至少 2 项。该物件可处于的状态，见下方“状态（objects[].states）” |
| `initialState` | 否 | string。初始状态的 `id`；省略则取 `states[0]` |

### `enemies[]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `name` | 是 | 唯一 ID / 显示名 |
| `enemyType` | 是 | 稳定类型，如 `melee` / `ranged` / `elite` / `boss` |
| `tier` | 是 | `normal` / `elite` / `boss` |
| `branch` | 是 | `main` 或 `optional`；`optional` 不进入主线压力 |
| `floorId` | 是 | 所属楼层 |
| `roomId` | 是 | 必须存在，且与敌人同层 |
| `center` | 是 | `[x,z]`，必须落在 `roomId` 的多边形内 |

### `doors[]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `name` | 是 | 唯一 ID / 显示名 |
| `floorId` | 是 | 所属楼层 |
| `points` | 是 | 正好 2 个点，线段落在房间边界 |
| `width` | 是 | 门洞宽度，米，必须大于 0 |
| `initial` | 否 | `"open"` \| `"closed"`，默认 `"open"`。门的初始状态。门固定只有这两个状态 |
| `height` | 否 | number > 0，默认见 `AI_GUIDE.md` 第 12 节（门洞净高）。门洞净高，米 |

### `routes[]`

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `name` | 是 | 唯一 ID / 显示名 |
| `kind` | 是 | 必须有一条 `main`；可选 `optional` / `exit` / `secret` |
| `floorId` | 是 | 所属楼层 |
| `points` | 是 | 有序折线，至少 2 个点，按行进顺序。点可写 `[x,z]`，或 `[x,z,y]`：`y` 是该点的绝对标高（米），用于跨层路线（走楼梯上下）；省略 `y` 则用 `floorId` 的标高 |
| `color` | 否 | `#rrggbb`，仅显示用 |

### `stairs[]`（可选，多层）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `name` | 是 | 唯一 ID / 显示名 |
| `points` | 是 | 矩形四角 `[x,z]`，表示楼梯占地 |
| `fromFloorId` / `toFloorId` | 是 | 两端楼层，必须存在 |
| `direction` | 否 | `up` / `down`，仅显示箭头 |
| `bottom` | 否 | 楼梯**低端**在占地矩形的哪一侧：`N` / `S` / `E` / `W`（N = z 大的一侧，E = x 大的一侧）。3D 据此决定台阶朝向；省略时工作台按相邻房间推测 |

### `water[]`（可选）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` / `name` | 是 | 唯一 ID / 显示名 |
| `floorId` | 是 | 所属楼层 |
| `points` | 是 | 水面多边形，至少 3 个 `[x,z]` |
| `kind` | 否 | `pool` / `fountain` / `impluvium` 等 |

### `links[]`（可选）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | ID | 是 | 全局唯一 |
| `name` | string | 是 | 显示名 |
| `from` | ID 数组，至少 1 项 | 是 | 触发源。可以是物件、敌人或房间的 ID |
| `to` | 数组，至少 1 项 | 是 | 目标及其要进入的状态 |
| `to[].id` | ID | 是 | 带 `states` 的物件，或一扇门 |
| `to[].state` | string | 是 | 物件：它的某个状态 `id`；门：`open` 或 `closed` |
| `require` | `"all"` \| `"any"` | 否，默认 `"all"` | 多个触发源时，要全部满足还是任一满足 |
| `trigger` | string | 否 | 触发源发生了什么，仅作说明。推荐值：`activated`（开关被激活）、`defeated`（敌人被击败；写房间 ID 表示该房间敌人全灭）、`entered`（玩家进入房间） |
| `note` | string | 否 | 备注 |

```json
{ "id": "lk_vault", "name": "双接收器开宝库门", "trigger": "activated", "require": "all",
  "from": ["o_receiver_1", "o_receiver_2"], "to": [{ "id": "d_vault", "state": "open" }] }
```

一对多 = `to` 写多项；条件组合 = `from` 写多项加 `require`；计时、可否复位等运行细节不进 JSON。

### 状态（`objects[].states`）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `states` | array，至少 2 项 | 否 | 该物件可处于的状态 |
| `states[].id` | string，同 ID 正则 | 是 | **只需在本物件内唯一**，不占全局 ID |
| `states[].name` | string | 否 | 显示名 |
| `states[].points` | polygon | 否 | 覆盖占地（可移动物件的卡位） |
| `states[].solid` | boolean | 否 | 覆盖是否挡路 |
| `states[].baseHeight` | number ≥ 0 | 否 | 覆盖离地高度（升降台） |
| `states[].height` | number > 0 | 否 | 覆盖厚度 |
| `states[].present` | boolean | 否，默认 `true` | `false` = 此状态下物件不在场（打开的闸、收起的桥） |
| `initialState` | string | 否 | 初始状态的 `id`；省略则取 `states[0]` |

状态里没写的属性，沿用物件本体的值。

```json
{ "id": "o_gate", "name": "闸门", "kind": "gate", "floorId": "1F", "solid": true, "height": 4,
  "points": [[23.25, 5], [24.75, 5], [24.75, 7], [23.25, 7]],
  "initialState": "closed",
  "states": [ { "id": "closed", "name": "关闭" }, { "id": "open", "name": "打开", "present": false } ] }
```

```json
{ "id": "o_crate", "name": "中继箱", "kind": "relay-crate", "floorId": "1F", "solid": true, "height": 1,
  "points": [[9.5, 12.5], [10.5, 12.5], [10.5, 13.5], [9.5, 13.5]],
  "initialState": "slot_n",
  "states": [
    { "id": "slot_n", "name": "北卡位", "points": [[9.5, 12.5], [10.5, 12.5], [10.5, 13.5], [9.5, 13.5]] },
    { "id": "slot_s", "name": "南卡位", "points": [[9.5, 7.5], [10.5, 7.5], [10.5, 8.5], [9.5, 8.5]] } ] }
```

规则：

- 物件本体的 `points` 等属性应与初始状态一致，这样不认识 `states` 的旧工具仍能画出初始样子。
- 带 `states` 的物件不参与 `route-clearance` 和距离场的阻挡：它在某个状态下可能让开。
- 谁来切换状态：没有 `links[]` 指向它 → 玩家直接操作；有 → 由机关驱动。

### 邻近规则（`meta.proximity`）

用途：声明"某几类东西只要离得够近就算相连"。这类关系由位置决定，不应逐条手写，否则挪一下物件就和数据对不上。通用场景包括连锁机关、信号中继、光环范围。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | ID | 是 | 全局唯一 |
| `name` | string | 是 | 显示名 |
| `radius` | number > 0 | 是 | 连通距离，米 |
| `kinds` | string 数组 | `kinds` 与 `enemyTypes` 至少一个非空 | 参与的物件 `kind` |
| `enemyTypes` | string 数组 | 同上 | 参与的敌人 `enemyType` |
| `lineOfSight` | boolean | 否，默认 `true` | 是否要求两点之间无遮挡 |

```json
"proximity": [ { "id": "signal", "name": "信号中继", "radius": 6,
  "kinds": ["relay-pole", "relay-crate", "relay-lamp", "relay-receiver"],
  "enemyTypes": ["drone"], "lineOfSight": true } ]
```

判定定义（工作台与 UE 侧必须一致）：

1. **锚点**：物件 = 占地各顶点的平均点，高度 = 楼层标高 + `baseHeight` + `height / 2`（`height` 缺省时用按 `kind` 估算的值）。敌人 = `center`，高度 = 楼层标高 + `meta.player.height / 2`。
2. **距离**：两个锚点之间的三维直线距离 ≤ `radius` 即满足距离条件。
3. **遮挡**（`lineOfSight: true` 时）：按平面判定。两锚点连线的平面投影不得穿过：
   - 两端所在楼层的墙段（门洞处、开放边处可穿过）；
   - `solid` 且不属于本规则节点的物件在其**当前状态**下的占地。不在场的状态不算；物件的竖向范围（底面到顶面）与两端锚点之间的高度区间不重叠时不算，也就是整个在连线上方的悬空物件、整个在连线下方的矮物件都不挡。
   - 已知局限：楼板不参与遮挡判定。上下两层之间隔着楼板的一对节点，会被判为无遮挡。设计时不要让两个节点隔着楼板落在 6 米以内。
4. 带 `states` 的节点按当前状态的占地和高度取锚点。默认显示初始状态下的结果。

设计建议：想连通的一对，距离控制在 `radius − 0.5` 以内；想断开的一对，距离控制在 `radius + 0.5` 以上。不要把关键关系卡在临界值上。

### `reviewNotes[]`（可选）

```json
{ "id": "note-1", "text": "这里需要确认门宽", "status": "open", "targetId": "r_entry" }
```

`status`：`open` / `confirmed` / `resolved`；`targetId` 必须指向真实 ID。

可选位置：`at: [x, z]` 表示批注所在的点（没有对应对象时使用，必须在 `bounds` 内），多层地图再加 `floorId` 说明在哪一层。工作台“批注”工具导出的评审意见就是这种格式：

```json
{ "id": "rn-1", "text": "这里加一处掩体", "status": "open", "at": [18, 9], "floorId": "1F" }
```

### 可选内容字段（工作台会显示）

为了让地图不止是轮廓，可加：

- `meta.pacing`：可选 `{ lambda, aggro, step, weights }`，工作台用它画压力曲线；不填则用默认 5.5/8/1 与普通1、精英3、Boss6；
- `meta.subtitle`、`meta.concept`、`meta.mainLength`、`meta.area`、`meta.enemySummary`、`meta.designNotes[]`；
- `floors[].note`（竖向分层说明）；
- `rooms[].beat` / `role` / `preset` / `flow` / `area` / `note`（节奏、职责、预设、动线、面积、备注）；`short` 是图上短名；
- `objects[].note` / `assets[]`；
- `enemies[].hp` / `speed` / `mechanic` / `note`；
- `routes[].note` / `length`；
- `stairs[].note` / `water[].note`。

3D 相关的可选字段（`rooms[].wallHeight`、`stairs[].bottom`、路线点的 `y`）见上方各表；不填也能显示，只是 3D 靠推测。

这些字段只影响工作台展示，不影响结构校验。

## 设计约束

- **同层不重叠**：房间多边形不要互相压盖；相邻房间共用边界可以。
- **门在墙上**：门线段的中点必须落在某个房间的边上（允许 0.08m 误差）；门宽不小于玩家直径。
- **路线有净空**：路线离 `solid: true` 的物件至少一个玩家半径（`meta.player.radius`），否则校验告警。带标高的路线从物件上方或下方越过时不算。
- **主路线连通**：主线从入口房间出发，穿过门，经过主要房间，最后到出口/离场房间。
- **敌人放在房间里**：不要在墙里、房间外或未定义楼层。
- **多楼层**：每层有独立 `elevation`；`2F` 在 `1F` 上方，`B1` 为负；跨层请加 `stairs[]`（写上 `bottom`），跨层路线的点用 `[x,z,y]` 写出标高。
- **不要填历史版本**：这份格式只有当前设计，不包含 v09/v11/v12。
- **不要写实现细节**：不要写 Unity 坐标转换、Prefab 路径、碰撞体、NavMesh。

## 输出前自检

1. JSON 能直接解析，没有注释/尾逗号。
2. 所有 ID 唯一且符合正则。
3. 每个 `floorId` / `roomId` 都能找到。
4. 房间至少 3 点，面积 > 0。
5. 敌人都在房间内。
6. 有一条 `main` 路线，点按顺序。
7. 门正好 2 点，宽度 > 0。
8. 所有坐标在 `bounds` 内。
9. 没有 Unity 字段。
10. 只输出 JSON。

## 文件

- 单文件包（推荐直接给 AI）：[AI_MAP_KIT.md](AI_MAP_KIT.md)
- 机器契约：[AI_MAP_SPEC.schema.json](AI_MAP_SPEC.schema.json)
- 完整示例：[AI_MAP_SAMPLE.json](AI_MAP_SAMPLE.json)
- 校验器：`python tools/validate_ai_map.py AI_MAP_SAMPLE.json`

## 一句话提示词

```text
你是关卡设计师。请严格按 AI_MAP_SPEC.md 输出一份 JSON 关卡：
32×24 米，三个房间（入口、中央展厅、离场廊），一条主线，
一个祭台、两个敌人、两扇门；不要输出 JSON 以外的任何文字。
```
