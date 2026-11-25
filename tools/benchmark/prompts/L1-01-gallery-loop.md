# L1-01-gallery-loop · 单层展馆回环拼接 (L1)

## 任务说明
设计一座单层博物馆展厅（4～7 间房，bounds 清晰，player.radius=0.35m）。需要包含入口门厅、主展厅、侧翼回廊与离场廊，通过至少 1 条绕行回环连接主展厅与侧翼，不能出现孤立房或无回报死胡同；所有大型战斗厅（≥6×6m）需配置展台/掩体，敌人不要紧贴门洞刷新。输出符合 AI_MAP_SPEC v1 或相对贴靠格式（size/attach、door.between）的纯 JSON。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。
