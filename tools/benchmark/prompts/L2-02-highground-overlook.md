# L2-02-highground-overlook · 双层高台敞边真俯瞰与分支捷径 (L2)

## 任务说明
设计一座双层神殿高台白盒（至少 4 间房）。2F 观察走廊通过 openEdges 真实敞向下方 1F 主大厅形成低视距俯瞰（注意多边形顶点顺序与 openEdges 索引，不要把敞开边朝向建筑外侧空白或被实体墙堵死），使用写明 stairs.bottom 的楼梯连接上下层，密室/分支末端需有回报，同时给出主线与可选侦察路线。

## 输出格式要求
- 若为新建题（`create`），直接输出符合 `AI_MAP_SPEC v1` 或相对贴靠格式（`size`/`attach`、`door.between`）的完整纯 JSON。
- 若为局部修补题（`patch`），只输出 `{ "patch": { "upsertRooms": ..., "upsertDoors": ..., ... } }` 增量 JSON，严禁重写或误改未要求变更的既有实体。
