# Godot Daedalus Backend — AGENTS 指南

## 项目概览

这是 Godot Daedalus 的 TypeScript 后端，负责 WebSocket/RPC、DeepSeek 对话、workflow 调度、审批、会话持久化、MCP Host、Godot 项目工具、终端验证、自定义 MCP、EditorBridge 以及 Godot LSP/DAP 只读诊断。

运行时代码放在 `src/`，测试放在 `tests/`。不要提交 `node_modules/`、`dist/`、运行日志或本机配置缓存。

## 常用命令

```powershell
npm install
npm run dev
npm run ping
npm run typecheck
npm test
```

`npm test` 当前会先执行 TypeScript 类型检查，再用 Node 内置 test runner 跑 `tests/*.test.ts`。新增协议、MCP、审批、schema 或路径解析逻辑时，优先补 `tests/*.test.ts`。

## 目录约定

- `src/server/`：WebSocket、RPC、会话信息、事件发送。
- `src/protocol/`：zod schema 与协议类型；所有外部输入必须在边界校验。
- `src/providers/`：模型 provider、流式处理、loose XML 工具兼容。
- `src/workflow/`：固定 workflow 与 LLM planned workflow 调度。
- `src/tools/`：LLM tool 定义、tool policy、审批、幂等和事件展示。
- `src/mcp/`：内置 MCP server、MCP Host、custom MCP、Godot editor/diagnostics bridge。
- `src/prompts/`、`src/skills/`：系统提示和技能工具集合。

## 编码规范

- TypeScript 使用 `strict`，导出函数、RPC payload、工具参数和事件结构要显式类型。
- 命名使用 `camelCase` / `PascalCase` / `UPPER_SNAKE_CASE`。
- 文件使用 UTF-8 无 BOM、LF 行尾。
- 注释使用简洁中文，只解释非显而易见的安全边界、协议细节或恢复逻辑。
- 不新增依赖，除非已有标准库和当前依赖无法合理实现。
- 结构化数据优先用 zod、JSON、类型化解析；避免脆弱字符串拼接。

## MCP 与工具安全

- 新增 LLM 可见工具时必须同步更新：`llm-tools` 映射和 schema、`tool-policy`、workflow/skills 工具集合、tool event describer、必要的 loose XML 映射。
- 读工具标记 `read`，验证工具标记 `verify`，预览工具标记 `propose`，实际写入标记 `write`，破坏性操作标记 `destructive`。
- 所有写入磁盘、修改场景、执行写命令、外部自定义 MCP 工具调用都必须走现有审批边界。
- 自定义 MCP 的 env/header 属于敏感信息，只能存 keytar 或等效 secret store，日志和前端返回不得泄漏明文。
- Godot DAP 第一版仅只读；不要开放 `launch`、`continue`、`pause`、`step`、`setBreakpoints`、`evaluate`。

## 路径和持久化

- Daedalus 配置和会话默认放在 `%APPDATA%\.godot_daedalus`，不要回退到仓库内路径。
- Godot 项目路径只能来自 workspace/env/RPC 上下文，不能硬编码个人机器路径。
- 解析 `res://`、`user://`、绝对路径时必须校验最终路径位于允许根目录内。
- 遇到 `user://`、项目日志、Godot editor settings、`.godot/editor` 状态时，默认脱敏本机隐私路径；只有明确 raw 参数才返回原文。

## 验证要求

- 后端改动至少运行 `npm run typecheck`。
- 协议、MCP、诊断、审批、幂等、路径解析改动运行 `npm test`。
- 修改 LLM 工具暴露时手动检查工具是否进入正确 read/write/verify/summarize 阶段，并确认 read-only 模式不会绕过策略。
- 修复流式、审批、workflow 或事件日志时，确认事件能恢复并且不会重复执行写工具。
