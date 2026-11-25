# 修改约定（给人和 AI 编程助手）

先读 [README.md](README.md) 和 [FEATURES.md](FEATURES.md)。
**要设计 / 产出地图**：读 [AI_GUIDE.md](AI_GUIDE.md) 和 [AI_MAP_SPEC.md](AI_MAP_SPEC.md)（或直接读合成的 `AI_MAP_KIT.md`）。

1. 工作台是查看与评审工具：读地图 JSON，不写回任何游戏工程。
2. 所有地图都走 `AI_MAP_SPEC` v1；不写针对某张地图或某个项目的适配器，不在 JS 里加地图名分支。
3. 新显示 / 交互能力只进 `workbench.js`（2D 与外壳）、`workbench-3d.js`（3D）、`map-geometry.js`（2D / 3D 共用的纯几何、距离场与改图逻辑）、`workbench.css`，做成对任何地图都成立的通用能力。
4. `maps.js`、`AI_MAP_KIT.md`、`AI_GUIDE.html`、`AI_MAP_SPEC.html` 是生成物，改源文件后运行 `python tools/build.py`；`vendor/three.min.js` 不手改。
5. 契约变更要同时改 `AI_MAP_SPEC.md`、`AI_MAP_SPEC.schema.json`、`tools/validate_ai_map.py`、`map-validate.js`（两份校验器规则与 code 必须一致，`tools/check_validator_parity.cjs` 会比对），以及用到该字段的 `workbench.js` / `workbench-3d.js`。新规则要在 `tools/fixtures/bad-map.json` 里加一个触发样例，并补进 `AI_GUIDE.md` 第 7 节的 code 表。
6. 3D 从同一份 JSON 派生：不手搭第二套模型，不进入导出 / 打印；3D 失败必须不影响 2D。
7. `tools/check_workbench.cjs` 对示例地图做具体断言；其他地图只要求“能加载、无结构错误”。
8. 改完必须运行 `python tools/check_all.py`（只跑数据层加 `--no-browser`）；改了界面，桌面版（`desktop/`）也要打开看一遍，它有浏览器里没有的按钮。
