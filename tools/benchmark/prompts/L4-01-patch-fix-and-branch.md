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
