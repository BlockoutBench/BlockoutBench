# L1-02-warehouse-extraction · 密集掩体仓库与多线撤离 (L1)

## 任务说明
设计一座单层中转仓库白盒（5～9 间房，player.radius=0.35m）。包含至少 5 处实体掩体（货箱/柱阵），交火区需有掩护且不得阻塞任何 main/exit 路线，也不要在门口贴脸刷怪；整体形成可绕行环路，没有无回报死胡同，并明确标出主攻与撤离路线（撤离点用 kind: "extract"）。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。
