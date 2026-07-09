# Daedalus Automation MCP

Automation MCP 是仅用于开发、测试和 CI smoke 的外部 MCP server。它让 Codex 这类通用 AI 对话客户端通过 Daedalus 公开 WebSocket/RPC 协议驱动真实后端：创建会话、发送 Plan/Agent 消息、处理澄清、批准计划、审批 smoke 白名单工具、读取事件和断言结果。

它不是普通用户功能：

- 不会加入 `buildMcpServerConfigs()`。
- 不会出现在 Godot 插件的 MCP 设置菜单。
- 不会进入 Daedalus 产品内 LLM 的工具列表。
- 不提供任意 shell、任意文件写入或 approve-all。

## 前置条件

先启动 Daedalus WebSocket 后端：

```powershell
$env:PORT = "38180"
npm run dev
```

或者使用已安装的发布包：

```powershell
$env:PORT = "38180"
godot-daedalus-backend
```

Provider API key 应通过 Daedalus 正常配置流程保存到本机 secret store。不要把 API key 放进 Automation MCP 命令行、MCP 配置或日志。

## 启动

Automation MCP 默认拒绝启动，必须显式设置 `DAEDALUS_AUTOMATION_MCP=1`：

```powershell
$env:DAEDALUS_AUTOMATION_MCP = "1"
npm run automation:mcp -- --backend-url ws://localhost:38180
```

发布包安装后也可以直接运行 bin：

```powershell
$env:DAEDALUS_AUTOMATION_MCP = "1"
godot-daedalus-automation-mcp --backend-url ws://localhost:38180
```

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `DAEDALUS_AUTOMATION_MCP` | 无 | 必须为 `1`，否则 server 拒绝启动。 |
| `DAEDALUS_AUTOMATION_BACKEND_URL` | `ws://localhost:38180` | Daedalus 后端 WebSocket 地址。也可用 `--backend-url` 覆盖。 |
| `DAEDALUS_BACKEND_URL` | 无 | `DAEDALUS_AUTOMATION_BACKEND_URL` 未设置时的兼容后备。 |
| `DAEDALUS_AUTOMATION_CLIENT_NAME` | `daedalus-automation-mcp` | 发送给后端 `client.hello` 的客户端名。也可用 `--client-name` 覆盖。 |
| `DAEDALUS_AUTOMATION_REQUEST_TIMEOUT_MS` | `120000` | RPC 和事件等待默认超时。也可用 `--request-timeout-ms` 覆盖。 |
| `DAEDALUS_AUTOMATION_ALLOWED_TOOLS` | 内置 smoke 写工具白名单 | 逗号分隔的可自动批准 LLM tool 名称。 |
| `DAEDALUS_AUTOMATION_ALLOWED_PATH_PREFIXES` | `scripts/daedalus_smoke_,scenes/daedalus_smoke_` | 逗号分隔的项目相对路径前缀。审批必须命中这些前缀之一。 |

默认自动审批白名单只覆盖 smoke 文件相关的 Godot 写工具，例如创建/覆盖脚本、创建/patch 场景、挂载脚本、连接信号。`destructive` 风险、未知工具、路径穿越、绝对路径、非 smoke 前缀路径都会被拒绝。

## Codex 配置示例

本仓库开发时可以把下面的 MCP server 加到 Codex 配置中：

```toml
[mcp_servers.daedalus-automation]
command = "npm"
args = ["run", "automation:mcp", "--", "--backend-url", "ws://localhost:38180"]
env = { DAEDALUS_AUTOMATION_MCP = "1" }
```

如果使用全局安装的发布包：

```toml
[mcp_servers.daedalus-automation]
command = "godot-daedalus-automation-mcp"
args = ["--backend-url", "ws://localhost:38180"]
env = { DAEDALUS_AUTOMATION_MCP = "1" }
```

更严格的 smoke 审批范围示例：

```toml
[mcp_servers.daedalus-automation]
command = "npm"
args = ["run", "automation:mcp", "--", "--backend-url", "ws://localhost:38180"]
env = {
  DAEDALUS_AUTOMATION_MCP = "1",
  DAEDALUS_AUTOMATION_ALLOWED_TOOLS = "mcp_godot_create_text_file,mcp_godot_overwrite_text_file,mcp_godot_apply_scene_patch",
  DAEDALUS_AUTOMATION_ALLOWED_PATH_PREFIXES = "scripts/daedalus_smoke_,scenes/daedalus_smoke_"
}
```

## 工具清单

- `daedalus_backend_health`：读取 `backend.health`。
- `daedalus_create_session`：创建会话。
- `daedalus_open_session`：打开已有会话。
- `daedalus_send_chat`：发送 `ai.chat`，立即返回 `requestId`。
- `daedalus_wait_for_event`：按 `eventName`、`requestId`、`planId` 或 sequence 等待事件。
- `daedalus_get_session_events`：读取 `session.timeline`。
- `daedalus_get_plan`：读取计划全文和 metadata。
- `daedalus_submit_clarification`：提交 Plan 澄清。
- `daedalus_revise_plan`：反馈并修订 Plan。
- `daedalus_approve_plan`：批准 Plan 并启动执行。
- `daedalus_list_pending_approvals`：列出当前 pending approvals。
- `daedalus_approve_matching_tool`：只批准一个命中白名单的 smoke 写工具。
- `daedalus_get_file_edit_batch`：读取 inline diff 快照 batch。
- `daedalus_assert_session_state`：基于已观察事件做轻量断言。

`daedalus_submit_clarification` 和 `daedalus_revise_plan` 会真实等待后端调用 provider，耗时可能超过 30 秒。默认 RPC 超时是 120 秒；单次调用也可以传 `timeoutMs` 覆盖，例如：

```json
{
  "planId": "plan-...",
  "feedback": "请按本仓库 TypeScript WebSocket/RPC + zod schema 架构修订计划。",
  "timeoutMs": 180000
}
```

## 典型 smoke 流程

1. `daedalus_backend_health` 确认后端在线。
2. `daedalus_create_session` 创建测试会话。
3. `daedalus_send_chat` 发送 Plan 模式请求，拿到 `requestId`。
4. `daedalus_wait_for_event` 等待 `plan.clarification.required` 或 `plan.generated`。
5. 如需澄清，用 `daedalus_submit_clarification`；如计划已 ready，用 `daedalus_get_plan` 检查全文。
6. `daedalus_approve_plan` 启动执行。
7. 执行中用 `daedalus_list_pending_approvals` 和 `daedalus_approve_matching_tool` 只批准 smoke 白名单写入。
8. 等待 `fileEditBatch`、`agent.message.done` 或 `agent.run.error`。
9. `daedalus_assert_session_state` 和 `daedalus_get_file_edit_batch` 校验结果。

## 安全边界

Automation MCP 只通过正常 WebSocket/RPC 调用后端，不直接调用内部函数，也不绕过审批系统。所有返回值会对 secret-like 字段脱敏，例如 `apiKey`、`authorization`、`token`、`secret`、`password`。

自动审批只适合临时 smoke 文件。不要把 `DAEDALUS_AUTOMATION_ALLOWED_PATH_PREFIXES` 配成项目根目录，也不要把 destructive 工具加入白名单。
