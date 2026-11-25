# UE5 Agent 选区与历史桥接套件（`tools/ue_agent_bridge/`）

完全独立于 LevelWorkbench 工作台（零第三方依赖、纯 Python 标准库），用于在 **UE5 编辑器** 内部实时感知单选 / 按点击顺序保序的多选 / 选择历史记录，并通过 **本地 JSON 文件 + 本地 HTTP API + 标准 stdio MCP Server** 三合一通道交给外部 Agent（Claude Code、Cursor、Codex、Antigravity 等）。

---

## 目录结构

| 文件 | 用途 |
|---|---|
| `selection_tracker.py` | 核心引擎：点击顺序保序多选、多选合并包围盒/质心统计、50 步历史环形缓冲、`add/remove/replace/clear` 分类、去重最近触碰表、原子写盘（`os.replace`） |
| `ue_editor_bridge.py` | UE5 编辑器内部插件入口：在 UE Game Thread 上通过 `SlatePostTick` 监听选中与周边空间扫描，在后台线程提供 `127.0.0.1:18136` HTTP 接口；在无 UE 环境下支持 `--mock` 模拟交互 |
| `mcp_server.py` | 零依赖标准 stdio MCP Server（同时兼容换行 JSON 与 `Content-Length` 帧），优先走 HTTP 实时读取、断网时自动降级读取磁盘 `selection_state.json` |
| `client_cli.py` | 命令行调试/查询工具（方便人类或非 MCP 脚本查看当前选区与历史） |
| `mock_scene.py` | 模拟 UE 关卡场景（含柱子、蓝图门、点光源、掩体、属性与包围盒） |
| `test_bridge.py` | 全流程离线自动化单测 + 真实子进程 MCP 端到端测试 |

---

## 1. 先在无 UE 环境下立刻试跑（2 分钟体验）

### A. 跑通自动化验证套件
```bash
python tools/ue_agent_bridge/test_bridge.py -v
```

### B. 开一个带默认多选历史步骤的 Mock 终端
```bash
python tools/ue_agent_bridge/ue_editor_bridge.py --mock --demo-steps
```
然后在交互提示符里可输入：`select SM_Pillar_West_01`、`add PointLight_Altar_Warm`、`remove ...`、`current`、`history`。

在另一个终端用 CLI 查询：
```bash
python tools/ue_agent_bridge/client_cli.py current --nearby 1000
python tools/ue_agent_bridge/client_cli.py history --limit 5
python tools/ue_agent_bridge/client_cli.py recent --class PointLight
python tools/ue_agent_bridge/client_cli.py diff
```

---

## 2. 放进真实 UE5 编辑器怎么用

### 方式一：单句临时启动（推荐先试）
在 UE5 编辑器的 **Output Log → Cmd 切到 Python** 后执行：
```python
py "<工作台目录>/tools/ue_agent_bridge/ue_editor_bridge.py"
```
或直接把 `tools/ue_agent_bridge/` 整个文件夹复制到你的 UE 工程 `Content/Python/ue_agent_bridge/` 下，并在 `Content/Python/init_unreal.py` 里加上这两行实现开编辑器自动启动：
```python
from ue_agent_bridge.ue_editor_bridge import start_bridge
start_bridge(port=18136)  # 默认状态文件为 ~/.ue_agent_bridge/selection_state.json，UE 与外部 Agent 无需配路径即可共享
```

> 再次运行 `start_bridge()` 会自动安全注销旧的 Slate tick 回调并释放旧端口，不会端口冲突，也不会堵死 UE 主线程。

---

## 3. 外部 Agent 如何接入（MCP 配置）

在任意支持 MCP 的客户端（Claude Code / Cursor / Codex / Antigravity）里添加以下 MCP 配置：

```json
{
  "mcpServers": {
    "ue-selection": {
      "command": "python",
      "args": ["<工作台目录>/tools/ue_agent_bridge/mcp_server.py"],
      "env": {
        "UE_AGENT_BRIDGE_URL": "http://127.0.0.1:18136",
        "UE_AGENT_BRIDGE_STATE_FILE": "~/.ue_agent_bridge/selection_state.json"
      }
    }
  }
}
```

接入后暴露给 Agent 的工具清单：
* `ue_get_selection`：读当前单选或保序多选（`items[0]` 为先选锚点，`items[-1]` 为后选目标）、总包围盒 `unionBoundsCm`、质心、资产路径，可选 `includeNearby: true` 顺带查周边未选中物件。
* `ue_get_selection_history`：按时间倒序查历史（支持 `offset=1` 查“上一次选的”，支持 `query` 关键词和 `classFilter` 过滤，默认自动跳过空白点击）。
* `ue_get_recent_actors`：去重后的“近期触碰过的 Actor 列表”及选中次数。
* `ue_diff_selection`：对比两次选择之间的新增 / 移出 / 保留及位移差 `deltaCm`。
* `ue_bookmark_selection`：给当前选区打书签备注，方便稍后召回。
* `ue_bridge_status`：查看当前是实时 HTTP 通道还是磁盘状态文件回退通道。

---

## 4. HTTP 端点速查（直接用脚本/自定义工具也能读）

* `GET http://127.0.0.1:18136/health`
* `GET http://127.0.0.1:18136/selection?nearbyRadiusCm=1500`
* `GET http://127.0.0.1:18136/history?limit=10&offset=0&nonEmpty=1&q=Pillar`
* `GET http://127.0.0.1:18136/history/diff`
* `GET http://127.0.0.1:18136/recent-actors?limit=20`
* `POST http://127.0.0.1:18136/selection/bookmark` `{"label":"对齐基准","note":"两根柱子"}`
