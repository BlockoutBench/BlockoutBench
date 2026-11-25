# LevelWorkbench Benchmark 考题合集（盲测版 · L1～L6）

> **使用顺序**：
> 1. 先把仓库根目录单文件规范包 `AI_MAP_KIT.md` 交给受测智能体。
> 2. 逐题或整卷发送以下考题，要求每题只输出严格合法的纯 JSON（L4/L6 输出 `{ "patch": ... }` 增量补丁）。
> 3. 将输出存为 `<题号>.json` 放进目录 `<out>/` 后，执行 `python tools/run_benchmark.py --dir <out>` 自动评测。

---

# L1-01-gallery-loop · 单层展馆回环拼接 (L1)

## 任务说明
设计一座单层博物馆展厅（4～7 间房，bounds 清晰，player.radius=0.35m）。需要包含入口门厅、主展厅、侧翼回廊与离场廊，通过至少 1 条绕行回环连接主展厅与侧翼，不能出现孤立房或无回报死胡同；所有大型战斗厅（≥6×6m）需配置展台/掩体，敌人不要紧贴门洞刷新。输出符合 AI_MAP_SPEC v1 或相对贴靠格式（size/attach、door.between）的纯 JSON。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。

---

# L1-02-warehouse-extraction · 密集掩体仓库与多线撤离 (L1)

## 任务说明
设计一座单层中转仓库白盒（5～9 间房，player.radius=0.35m）。包含至少 5 处实体掩体（货箱/柱阵），交火区需有掩护且不得阻塞任何 main/exit 路线，也不要在门口贴脸刷怪；整体形成可绕行环路，没有无回报死胡同，并明确标出主攻与撤离路线（撤离点用 kind: "extract"）。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。

---

# L2-01-courtyard-threefloor · 三层中庭垂直对齐与跨层采光挑空 (L2)

## 任务说明
设计一座三层庭院遗迹（1F/2F/3F 或 B1/1F/2F，至少 5 间房）。1F 需包含真正的露天中庭（wallHeight: 0），上方 2F/3F 仅围绕中庭局部布置回廊与圣坛，禁止整块实心楼板把露天中庭全部盖死；上下层存在跨层投影叠合，使用至少 2 座标明 stairs.bottom（N/S/E/W）的楼梯连通三层。每个战斗区域应有合理陈设或掩体，不能出现无回报死胡同。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。

---

# L2-02-highground-overlook · 双层高台敞边真俯瞰与分支捷径 (L2)

## 任务说明
设计一座双层神殿高台白盒（至少 4 间房）。2F 观察走廊通过 openEdges 真实敞向下方 1F 主大厅形成低视距俯瞰（注意多边形顶点顺序与 openEdges 索引，不要把敞开边朝向建筑外侧空白或被实体墙堵死），使用写明 stairs.bottom 的楼梯连接上下层，密室/分支末端需有回报，同时给出主线与可选侦察路线。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。

---

# L3-01-dual-lock-relay · 双锁机关状态机与零死锁 (L3)

## 任务说明
设计一座带机关锁闭的密室关卡（至少 4 间房）：宝库门或石闸初始处于关闭/阻挡状态（initial: closed 或 states solid: true，若用 stone-gate 等高墙物件请写明合理高度），玩家需在可达前置分支中触发 2 个以上开关与联动 links 逐级解锁后才能进入终点宝库。严禁把开关锁在待开启的门后导致死锁，战斗房内不要贴门刷怪且需有掩护。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。

---

# L4-01-patch-fix-and-branch · 局部 { patch } 修缺陷并扩建有回报安全侧室 (L4)

## 任务说明
读取给定的残次地图与批注：1）把脱边北门 d_north 吸附回 r_entry 与 r_north 共享边；2）把挡住主线净空的展柜 o_case_block 挪到不阻挡路线的位置；3）在 r_entry 东侧新增 6×6 安全休整侧室 r_safe、连通门 d_safe 以及室内休整/补给物件与可选探索线，不能留下空壳无回报尽头。只输出 { "patch": ... } 增量 JSON，严禁改动 r_entry、r_north、e_guard 等无关既有实体。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。

## 输入局部上下文（邻域 + reviewNotes + 校验问题）
```json
{
  "focusRoomIds": [
    "r_north",
    "r_entry"
  ],
  "neighborRoomIds": [],
  "issues": [
    {
      "level": "warning",
      "code": "door-off-boundary",
      "id": "d_north",
      "msg": "门 d_north: 中点不在任何房间边上"
    },
    {
      "level": "warning",
      "code": "route-clearance",
      "id": "main",
      "msg": "路线 main: 离阻挡物件 o_case_block 不足玩家半径 0.4m"
    }
  ],
  "notes": [
    {
      "id": "n1",
      "text": "d_north 脱边了，需贴回 r_entry 与 r_north 共享边；o_case_block 挡在主线上了请移开；并在 r_entry 东侧补一间 6x6 安全侧室 r_safe 与门 d_safe。",
      "status": "open",
      "targetId": "o_case_block"
    }
  ],
  "contextData": {
    "schemaVersion": 1,
    "meta": {
      "title": "L4 基准残次图 · 门脱边与通道受阻",
      "bounds": {
        "minX": 0,
        "minZ": 0,
        "maxX": 26,
        "maxZ": 26
      },
      "player": {
        "radius": 0.4,
        "height": 1.8,
        "walkSpeed": 4,
        "rollDistance": 3,
        "rollDuration": 0.3,
        "interactionRange": 2
      }
    },
    "floors": [
      {
        "id": "1F",
        "name": "1F",
        "elevation": 0,
        "height": 3.6
      }
    ],
    "rooms": [
      {
        "id": "r_entry",
        "name": "入口门厅",
        "kind": "entry",
        "status": "planned",
        "floorId": "1F",
        "points": [
          [
            2,
            2
          ],
          [
            10,
            2
          ],
          [
            10,
            10
          ],
          [
            2,
            10
          ]
        ]
      },
      {
        "id": "r_north",
        "name": "北侧主厅",
        "kind": "gallery",
        "status": "planned",
        "floorId": "1F",
        "points": [
          [
            2,
            10
          ],
          [
            10,
            10
          ],
          [
            10,
            20
          ],
          [
            2,
            20
          ]
        ]
      }
    ],
    "doors": [
      {
        "id": "d_north",
        "name": "脱边北门",
        "floorId": "1F",
        "points": [
          [
            5,
            10.6
          ],
          [
            7,
            10.6
          ]
        ],
        "width": 2
      }
    ],
    "objects": [
      {
        "id": "o_case_block",
        "name": "挡路展柜",
        "kind": "display",
        "floorId": "1F",
        "solid": true,
        "points": [
          [
            5.5,
            13.5
          ],
          [
            7.5,
            13.5
          ],
          [
            7.5,
            15.5
          ],
          [
            5.5,
            15.5
          ]
        ]
      }
    ],
    "enemies": [
      {
        "id": "e_guard",
        "name": "主厅守卫",
        "enemyType": "melee",
        "tier": "normal",
        "branch": "main",
        "floorId": "1F",
        "roomId": "r_north",
        "center": [
          4,
          17
        ]
      }
    ],
    "routes": [
      {
        "id": "main",
        "name": "主线",
        "kind": "main",
        "floorId": "1F",
        "points": [
          [
            6,
            4
          ],
          [
            6,
            15
          ],
          [
            6,
            18
          ]
        ]
      }
    ],
    "stairs": []
  },
  "proximity": []
}
```

---

# L5-01-sunken-gallery-complex · 三层非矩形采光中庭与立体交火综合体 (L5)

## 任务说明
设计一座完整的商业级三层建筑白盒（B1/1F/2F，至少 10 间房，player.radius=0.4m）：1）1F 中心设置大型露天中庭（wallHeight: 0），要求至少 2 个房间采用 L 形/U 形/多边形等非矩形设计，其中 2F 围绕中庭一侧或两侧做挑空回廊（openEdges 真正朝向中庭内部向下俯瞰，保留大面积露天采光井，绝不能把中庭上方完全封死）；2）3 座以上标明 stairs.bottom 的跨层楼梯分别连通 B1 地下秘库与 2F 圣坛，全图形成多条立体回环且无任何无回报死胡同；3）至少 5 名敌人形成“前厅冷静入场与热身 → 中段探索与喘息 → 2F Boss 高潮决战 → 撤离坪脱出”的节奏起伏，大型战斗区全配掩体、严禁贴门刷怪，明确标出 main / optional（地下秘库含圣遗物等回报）/ exit 三类路线。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。

---

# L5-02-clockwork-lock-citadel · 双阶联动机关+状态桥闸+节奏Boss要塞 (L5)

## 任务说明
设计一座双层高难机关要塞白盒（至少 8 间房，至少含 1 间非矩形 Boss 圣殿与 2F 俯瞰走廊 openEdges，至少 2 座标明 bottom 的楼梯）：构建两阶段零死锁机关进度（至少 4 条 links 串联，至少 2 个带 states 的石闸/可动机关物件以及 initial: "closed" 锁门）：第一阶段需在两侧可达偏殿先后或协同激活双开关，一边打开内院封门，一边开启回归中枢的捷径回环减少无效折返；第二阶段登上 2F 经俯瞰廊与中继厅激活核心开关解锁封闭的 Boss 圣殿，击败 Boss 后再联动解锁战利品宝箱。节奏需先热身、中段解谜喘息、高潮集中在后半程 Boss 战，所有战斗区均配掩体且无开门杀、无空壳死胡同。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。

---

# L6-01-patch-wing-rework · 复杂双层遗迹多缺陷联合诊断与无副作用局部重构 (L6)

## 任务说明
审阅给定双层遗迹的局部上下文与 reviewNotes：当前存在多类隐蔽设计与规范缺陷（包括窄门、二层门脱边、石柱挡住主线、前厅误放 Boss 而二层王座厅只有普通小兵的节奏倒置、西殿精英贴门刷怪的开门杀，以及二层书房无回报空置）。请只输出 { "patch": ... } 增量 JSON：一并修复上述全部问题，并在西殿西南侧（不超出 bounds）扩建一间 L 形非矩形秘宝侧室 r_vault_l、门 d_vault_l、室内部署战利品与探索支线。严禁改动与修复无关的东翼、北侧神龛、前厅/主庭/楼梯等既有实体的坐标或属性！

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。

## 输入局部上下文（邻域 + reviewNotes + 校验问题）
```json
{
  "focusRoomIds": [
    "r_hub",
    "r_foyer",
    "r_west_wing",
    "r_2f_east",
    "r_2f_overlook"
  ],
  "neighborRoomIds": [
    "r_east_hall",
    "r_north_shrine",
    "r_2f_study",
    "r_2f_throne"
  ],
  "issues": [
    {
      "level": "warning",
      "code": "door-narrow",
      "id": "d_west_wing",
      "msg": "门 d_west_wing: 宽 0.6m 小于玩家直径 0.80m"
    },
    {
      "level": "warning",
      "code": "door-off-boundary",
      "id": "d_2f_balcony",
      "msg": "门 d_2f_balcony: 中点不在任何房间边上"
    },
    {
      "level": "warning",
      "code": "route-clearance",
      "id": "rt_main",
      "msg": "路线 rt_main: 离阻挡物件 o_pillar_block 不足玩家半径 0.4m"
    }
  ],
  "notes": [
    {
      "id": "rn1",
      "text": "1) d_west_wing 门宽仅 0.6m 过窄请拓宽到 >=1.6m；2) d_2f_balcony 脱离了 x=22 边界请贴回 r_2f_east 与 r_2f_overlook 共享边；3) o_pillar_block 挡住了主线请移到不阻挡主线的位置。",
      "status": "open",
      "targetId": "o_pillar_block"
    },
    {
      "id": "rn2",
      "text": "4) 节奏倒置且开门杀：前厅 e_boss_front 应改为普通热身守卫，真正 Boss 应在二层王座厅(把 e_throne_guard 升格调整为 Boss)；西殿 e_camp_west 离门太近请退到石案掩体后方；5) r_2f_study 无回报请放入战利品箱；6) 在 r_west_wing 西侧(2..8, 2..16) 扩建 L 形非矩形藏宝室 r_vault_l 及连通门 d_vault_l 与探索支线。严禁改动东翼、北侧神龛、前厅与主庭房间轮廓！",
      "status": "open",
      "targetId": "e_boss_front"
    }
  ],
  "contextData": {
    "schemaVersion": 1,
    "meta": {
      "title": "L6 复杂双层遗迹残次基准图 · 待局部重构",
      "bounds": {
        "minX": 0,
        "minZ": 0,
        "maxX": 36,
        "maxZ": 30
      },
      "player": {
        "radius": 0.4,
        "height": 1.8,
        "walkSpeed": 4,
        "rollDistance": 3,
        "rollDuration": 0.3,
        "interactionRange": 2
      }
    },
    "floors": [
      {
        "id": "1F",
        "name": "1F 底层遗迹",
        "elevation": 0,
        "height": 3.6
      },
      {
        "id": "2F",
        "name": "2F 上层王座",
        "elevation": 3.6,
        "height": 3.6
      }
    ],
    "rooms": [
      {
        "id": "r_foyer",
        "name": "入口前厅",
        "kind": "entry",
        "status": "planned",
        "floorId": "1F",
        "points": [
          [
            14,
            2
          ],
          [
            22,
            2
          ],
          [
            22,
            8
          ],
          [
            14,
            8
          ]
        ]
      },
      {
        "id": "r_hub",
        "name": "中央主庭",
        "kind": "hall",
        "status": "planned",
        "floorId": "1F",
        "points": [
          [
            14,
            8
          ],
          [
            22,
            8
          ],
          [
            22,
            18
          ],
          [
            14,
            18
          ]
        ]
      },
      {
        "id": "r_east_hall",
        "name": "东翼长廊",
        "kind": "gallery",
        "status": "planned",
        "floorId": "1F",
        "points": [
          [
            22,
            8
          ],
          [
            32,
            8
          ],
          [
            32,
            18
          ],
          [
            22,
            18
          ]
        ]
      },
      {
        "id": "r_north_shrine",
        "name": "北侧神龛",
        "kind": "shrine",
        "status": "planned",
        "floorId": "1F",
        "points": [
          [
            14,
            18
          ],
          [
            22,
            18
          ],
          [
            22,
            26
          ],
          [
            14,
            26
          ]
        ]
      },
      {
        "id": "r_west_wing",
        "name": "西侧旧殿",
        "kind": "room",
        "status": "planned",
        "floorId": "1F",
        "points": [
          [
            8,
            8
          ],
          [
            14,
            8
          ],
          [
            14,
            18
          ],
          [
            8,
            18
          ]
        ]
      },
      {
        "id": "r_2f_east",
        "name": "二层东廊",
        "kind": "gallery",
        "status": "planned",
        "floorId": "2F",
        "points": [
          [
            22,
            8
          ],
          [
            32,
            8
          ],
          [
            32,
            18
          ],
          [
            22,
            18
          ]
        ]
      },
      {
        "id": "r_2f_overlook",
        "name": "二层俯瞰台",
        "kind": "gallery",
        "status": "planned",
        "floorId": "2F",
        "openEdges": [
          0
        ],
        "points": [
          [
            14,
            14
          ],
          [
            22,
            14
          ],
          [
            22,
            18
          ],
          [
            14,
            18
          ]
        ]
      },
      {
        "id": "r_2f_study",
        "name": "二层空置书房",
        "kind": "room",
        "status": "planned",
        "floorId": "2F",
        "points": [
          [
            22,
            18
          ],
          [
            30,
            18
          ],
          [
            30,
            24
          ],
          [
            22,
            24
          ]
        ]
      },
      {
        "id": "r_2f_throne",
        "name": "二层王座厅",
        "kind": "boss",
        "status": "planned",
        "floorId": "2F",
        "points": [
          [
            14,
            18
          ],
          [
            22,
            18
          ],
          [
            22,
            26
          ],
          [
            14,
            26
          ]
        ]
      }
    ],
    "doors": [
      {
        "id": "d_foyer_hub",
        "name": "前厅门",
        "floorId": "1F",
        "points": [
          [
            17,
            8
          ],
          [
            19,
            8
          ]
        ],
        "width": 2
      },
      {
        "id": "d_hub_east",
        "name": "东翼门",
        "floorId": "1F",
        "points": [
          [
            22,
            12
          ],
          [
            22,
            14
          ]
        ],
        "width": 2
      },
      {
        "id": "d_hub_north",
        "name": "神龛门",
        "floorId": "1F",
        "points": [
          [
            17,
            18
          ],
          [
            19,
            18
          ]
        ],
        "width": 2
      },
      {
        "id": "d_west_wing",
        "name": "西殿窄门",
        "floorId": "1F",
        "points": [
          [
            14,
            12.7
          ],
          [
            14,
            13.3
          ]
        ],
        "width": 0.6
      },
      {
        "id": "d_2f_balcony",
        "name": "二层脱边门",
        "floorId": "2F",
        "points": [
          [
            22.5,
            15
          ],
          [
            22.5,
            17
          ]
        ],
        "width": 2
      },
      {
        "id": "d_2f_study",
        "name": "书房门",
        "floorId": "2F",
        "points": [
          [
            25,
            18
          ],
          [
            27,
            18
          ]
        ],
        "width": 2
      },
      {
        "id": "d_2f_throne",
        "name": "王座门",
        "floorId": "2F",
        "points": [
          [
            17,
            18
          ],
          [
            19,
            18
          ]
        ],
        "width": 2
      }
    ],
    "objects": [
      {
        "id": "o_foyer_pillar",
        "name": "前厅方柱",
        "kind": "column",
        "floorId": "1F",
        "solid": true,
        "height": 3.6,
        "points": [
          [
            15,
            3
          ],
          [
            16.5,
            3
          ],
          [
            16.5,
            4.2
          ],
          [
            15,
            4.2
          ]
        ]
      },
      {
        "id": "o_pillar_block",
        "name": "挡路石柱",
        "kind": "column",
        "floorId": "1F",
        "solid": true,
        "height": 3.6,
        "points": [
          [
            17.2,
            9.5
          ],
          [
            18.8,
            9.5
          ],
          [
            18.8,
            11
          ],
          [
            17.2,
            11
          ]
        ]
      },
      {
        "id": "o_east_col",
        "name": "东廊立柱",
        "kind": "column",
        "floorId": "1F",
        "solid": true,
        "height": 3.6,
        "points": [
          [
            25,
            11
          ],
          [
            26.5,
            11
          ],
          [
            26.5,
            12.5
          ],
          [
            25,
            12.5
          ]
        ]
      },
      {
        "id": "o_shrine_altar",
        "name": "北龛祭台",
        "kind": "altar",
        "floorId": "1F",
        "solid": true,
        "height": 1.1,
        "points": [
          [
            17,
            23
          ],
          [
            19,
            23
          ],
          [
            19,
            24.5
          ],
          [
            17,
            24.5
          ]
        ]
      },
      {
        "id": "o_west_table",
        "name": "西殿石案",
        "kind": "table",
        "floorId": "1F",
        "solid": true,
        "height": 0.9,
        "points": [
          [
            10,
            14.5
          ],
          [
            12,
            14.5
          ],
          [
            12,
            16
          ],
          [
            10,
            16
          ]
        ]
      },
      {
        "id": "o_throne_col",
        "name": "王座柱",
        "kind": "column",
        "floorId": "2F",
        "solid": true,
        "height": 3.6,
        "points": [
          [
            15,
            21
          ],
          [
            16.2,
            21
          ],
          [
            16.2,
            22.2
          ],
          [
            15,
            22.2
          ]
        ]
      }
    ],
    "enemies": [
      {
        "id": "e_boss_front",
        "name": "错位Boss(在前厅)",
        "enemyType": "boss",
        "tier": "boss",
        "branch": "main",
        "floorId": "1F",
        "roomId": "r_foyer",
        "center": [
          18,
          5
        ]
      },
      {
        "id": "e_east",
        "name": "东廊守卫",
        "enemyType": "melee",
        "tier": "normal",
        "branch": "main",
        "floorId": "1F",
        "roomId": "r_east_hall",
        "center": [
          26,
          15
        ]
      },
      {
        "id": "e_north",
        "name": "神龛哨兵",
        "enemyType": "ranged",
        "tier": "normal",
        "branch": "optional",
        "floorId": "1F",
        "roomId": "r_north_shrine",
        "center": [
          18,
          21
        ]
      },
      {
        "id": "e_camp_west",
        "name": "贴门伏击精英",
        "enemyType": "elite",
        "tier": "elite",
        "branch": "optional",
        "floorId": "1F",
        "roomId": "r_west_wing",
        "center": [
          12.6,
          13
        ]
      },
      {
        "id": "e_throne_guard",
        "name": "王座弱兵(节奏倒置)",
        "enemyType": "melee",
        "tier": "normal",
        "branch": "main",
        "floorId": "2F",
        "roomId": "r_2f_throne",
        "center": [
          18,
          23
        ]
      }
    ],
    "routes": [
      {
        "id": "rt_main",
        "name": "主线",
        "kind": "main",
        "floorId": "1F",
        "points": [
          [
            18,
            4,
            0
          ],
          [
            18,
            13,
            0
          ],
          [
            27,
            13,
            0
          ],
          [
            30,
            9.5,
            0
          ],
          [
            30,
            14.5,
            3.6
          ],
          [
            27,
            16,
            3.6
          ],
          [
            18,
            16,
            3.6
          ],
          [
            18,
            22,
            3.6
          ]
        ]
      },
      {
        "id": "rt_east_opt",
        "name": "北龛探索",
        "kind": "optional",
        "floorId": "1F",
        "points": [
          [
            21,
            13,
            0
          ],
          [
            18,
            18,
            0
          ],
          [
            18,
            22,
            0
          ]
        ]
      }
    ],
    "stairs": [
      {
        "id": "st_east_up",
        "name": "东廊登楼阶梯",
        "fromFloorId": "1F",
        "toFloorId": "2F",
        "bottom": "S",
        "points": [
          [
            29,
            9
          ],
          [
            31,
            9
          ],
          [
            31,
            15
          ],
          [
            29,
            15
          ]
        ]
      }
    ]
  },
  "proximity": []
}
```

---
