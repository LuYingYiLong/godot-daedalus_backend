# 文件结构与测试目录规范

## 生产代码边界

`src/` 只放运行时代码，不放 `*.test.ts`。测试、测试 fixture 与测试 helper 统一放在 `tests/` 下。

后端目录职责：

- `src/server/`：WebSocket、RPC、会话连接、事件分发。
- `src/protocol/`：协议 schema 与类型边界。
- `src/providers/`：LLM provider、模型目录、token 估算、图片生成与搜索适配。
- `src/tools/`：LLM 可见工具、审批策略、幂等、结果解析。
- `src/workflow/`：workflow 规划、执行、修复与 todo。
- `src/mcp/`：内置 MCP、Godot bridge、自定义 MCP、终端 MCP。
- `src/session/`：会话持久化、timeline、附件、压缩。

## 测试目录

测试按测试类型分层，再按领域分组：

- `tests/unit/providers/`：provider catalog、模型过滤、token budget、provider client 纯逻辑。
- `tests/unit/stores/`：配置 store、path registry、workspace registry。
- `tests/unit/session/`：会话 store、timeline、附件、标题、上下文估算。
- `tests/unit/tools/`：工具目录、工具策略、结果解析、文件编辑快照。
- `tests/unit/workflow/`：workflow planner、scheduler、repair、outcome。
- `tests/unit/prompts/`：prompt 组合与模板。
- `tests/unit/skills/`：skill catalog、skill 事件展示。
- `tests/contract/protocol/`：协议 schema、dispatcher、envelope 合约。
- `tests/integration/mcp/`：MCP host、外部 MCP、Godot tool 注册、多客户端边界。
- `tests/integration/runtime/`：manager、terminal、Godot runtime/diagnostics、backend health。
- `tests/integration/websocket/`：WebSocket 与 session runtime 集成。
- `tests/helpers/`：仅测试可用的 helper，不被生产代码引用。

## 新增测试规则

- 不在 `src/` 中新增测试文件。
- 单模块纯逻辑优先放 `tests/unit/<domain>/`。
- 协议输入输出、schema、dispatcher 行为放 `tests/contract/protocol/`。
- 需要跨多个 runtime 边界、文件系统、MCP host、WebSocket 或进程行为时放 `tests/integration/<domain>/`。
- 测试导入生产代码使用从测试文件到仓库根的显式相对路径，例如 `../../../src/...`。
- 如果测试必须访问私有实现，优先把逻辑抽成明确导出的内部 helper，而不是把测试搬回源码目录。

## 命令

`npm run typecheck` 使用 TypeScript 默认 include 规则，覆盖仓库内 `src/**/*.ts` 与 `tests/**/*.ts`。

`npm test` 显式递归运行：

```powershell
node --import tsx --test "tests/**/*.test.ts"
```
