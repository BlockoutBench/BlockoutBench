# 关卡工作台 · Level Workbench（桌面版）

把一份关卡布局 JSON 画成 2D 平面图和 3D 模型，自动检查结构错误，并把节奏、撤离、机关连通这些“凭感觉”的东西量化出来。适合关卡策划评审方案，也适合给 AI 出图当“考官”。本发布包仅提供**本地离线桌面版**（不提供网页/HTTP 服务版）。

- **看图**：2D 示意 / 平面图两种画法，3D 透视与俯览，多楼层、跨层楼梯与路线。
- **挑错**：63 条结构与可玩性规则（门比角色窄、路线擦着障碍、敌人卡墙、楼梯接错层……），桌面端与命令行结果一致，点一条问题跳到出问题的位置。
- **量化**：主线压力节奏曲线、压力热力图、到撤离点的步行距离、房间统计。
- **机关**：悬空物件、可移动卡位、开合的门与闸、谁触发谁的连线、按距离自动成立的邻近连通，并能切换状态预览。
- **评审**：测量、批注、版本对比、链接分享、导出 SVG 与 UE 白盒包。
- **和 AI 一起用**：一份单文件包让任何 AI 按规范出图；导入前自动校验；评审批注一键整理成发给 AI 的修改意见，改完用版本对比看差异。

完整功能清单见 [FEATURES.md](FEATURES.md)。

## 快速开始（桌面版）

* **绿色免安装桌面包（若包内已附带 `关卡工作台.exe`）**：直接双击根目录 **`关卡工作台.exe`** 即可本地离线运行，无需额外安装浏览器或 Node。
* **源码包自行构建桌面版（若包内仅含源码）**：
  ```bash
  cd desktop
  npm install
  npm start
  ```
  想要根目录一键双击启动的 `关卡工作台.exe`：装好 Visual Studio C++ 工具后在根目录运行 `python tools/build_exe.py`。

**第一次用**：打开后已自动为你载入 4 张内置示例（默认展示「示例 · 功能导览：雾港信号站」），对照 [FEATURES.md](FEATURES.md) 逐项看，一张图就能走遍全部功能；如果清空过列表，随时可在左栏「打开内置示例…」一键重新调出。

## 加自己的地图

- **临时看**：左栏点“打开 JSON”、把 `.json` 文件直接拖进窗口，或使用“粘贴 AI 输出的 JSON”。结构错误会被拒绝并提示原因；打开的磁盘文件支持修改后自动热重载。
- **加入内置示例**：放进 `maps/`，在 `maps/manifest.json` 加一行 `{ "key": "...", "file": "maps/xxx.json" }`，运行 `python tools/build.py`。
- **让 AI 出图**：把 [AI_MAP_KIT.md](AI_MAP_KIT.md) 整个交给 AI，里面有设计指南、字段规范、示例和提示词模板。拿到结果后用 `python tools/validate_ai_map.py my-map.json` 校验，把输出交回 AI 修，直到 0 错误 0 告警。

格式说明：[AI_MAP_SPEC.md](AI_MAP_SPEC.md)（字段规范）· [AI_MAP_SPEC.schema.json](AI_MAP_SPEC.schema.json)（JSON Schema）· [AI_GUIDE.md](AI_GUIDE.md)（给 AI 的设计指南与校验代码表）。

## 内置示例地图

| 地图 | 用途 |
|---|---|
| `maps/showcase.json` 功能导览：雾港信号站 | 一张图覆盖全部功能，配合 FEATURES.md 看 |
| `AI_MAP_SAMPLE.json` AI 样本 · 双厅回廊 | 最小的完整示例，AI 出图的参考答案 |
| `maps/sample-multifloor.json` AI 样本 · 三层庭院 | 多楼层、楼梯朝向、露天房间、跨层路线 |
| `maps/sample-mechanisms.json` 扩展样本 · 隔渊传信 | 机关、状态、邻近连通的最小示例 |

## 目录

| 路径 | 作用 |
|---|---|
| `desktop/`、`关卡工作台.exe` | Electron 桌面外壳与 Windows 一键启动器 |
| `index.html`、`workbench.js`、`workbench-3d.js`、`workbench.css` | 桌面端内部渲染视图（2D / 3D / 样式） |
| `map-geometry.js` | 2D / 3D 共用的几何、距离场、邻近判定、相对布局展开与吸附修正 |
| `map-validate.js`、`tools/validate_ai_map.py` | 两份规则完全一致的校验器（桌面端 / 命令行） |
| `viewer-pacing.js` | 压力节奏计算 |
| `maps/`、`maps.js` | 示例地图与清单；`maps.js` 由 `tools/build.py` 生成 |
| `AI_MAP_KIT.md`、`AI_GUIDE.html`、`AI_MAP_SPEC.html` | 生成物，改源文件后运行 `python tools/build.py` |
| `tools/` | 构建、校验、桌面启动器构建、回归测试、UE 白盒导入导出与选区桥接、题库评分 |
| `benchmark/` | AI 出图题库样题与评分脚本 |
| `vendor/three.min.js` | three.js r128 |

## 开发与测试

```bash
npm install            # 仅测试回归需要（Playwright）
python tools/check_all.py          # 构建 + 校验全部地图 + 两份校验器比对 + 界面回归
python tools/check_all.py --no-browser   # 只跑数据层
```

修改约定见 [AGENTS.md](AGENTS.md)（人和 AI 编程助手都适用）。

## 许可证

Required Notice: Copyright 2026 关卡形态要乐奈 (lchm2th@foxmail.com)

本项目**免费用于非商业目的**：任何人都可以下载、使用、修改和分享，但需要保留上面这行署名和许可证，且不得用于商业用途。

- 代码：PolyForm Noncommercial 1.0.0
- 文档、规范、示例地图与图片：CC BY-NC 4.0

**商业使用**（包括在公司或商业项目中使用、用于开发商业游戏、集成到商业产品）需要另行取得授权，请联系作者：关卡形态要乐奈 · <lchm2th@foxmail.com>。

完整条款与适用范围见 [LICENSE.md](LICENSE.md)，第三方组件的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
