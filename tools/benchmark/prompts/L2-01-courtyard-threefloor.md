# L2-01-courtyard-threefloor · 三层中庭垂直对齐与跨层采光挑空 (L2)

## 任务说明
设计一座三层庭院遗迹（1F/2F/3F 或 B1/1F/2F，至少 5 间房）。1F 需包含真正的露天中庭（wallHeight: 0），上方 2F/3F 仅围绕中庭局部布置回廊与圣坛，禁止整块实心楼板把露天中庭全部盖死；上下层存在跨层投影叠合，使用至少 2 座标明 stairs.bottom（N/S/E/W）的楼梯连通三层。每个战斗区域应有合理陈设或掩体，不能出现无回报死胡同。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。
