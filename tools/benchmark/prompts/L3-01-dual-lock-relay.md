# L3-01-dual-lock-relay · 双锁机关状态机与零死锁 (L3)

## 任务说明
设计一座带机关锁闭的密室关卡（至少 4 间房）：宝库门或石闸初始处于关闭/阻挡状态（initial: closed 或 states solid: true，若用 stone-gate 等高墙物件请写明合理高度），玩家需在可达前置分支中触发 2 个以上开关与联动 links 逐级解锁后才能进入终点宝库。严禁把开关锁在待开启的门后导致死锁，战斗房内不要贴门刷怪且需有掩护。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。
