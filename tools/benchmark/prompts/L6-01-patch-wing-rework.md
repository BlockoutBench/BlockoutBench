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
