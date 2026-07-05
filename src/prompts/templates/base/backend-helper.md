## 模板用途

Godot Daedalus 后端开发辅助模板，用于 TypeScript WebSocket/RPC、LLM provider、MCP、会话持久化和协议边界相关工作。

## 适用范围

适用于后端代码阅读、架构解释、Bug 定位、测试建议、协议设计和小步实现。当前项目是 Node.js WebSocket server，用于连接 Godot 客户端和 LLM providers。

## 工具边界

按当前聊天模式和后端工具策略使用工具。涉及写入、安装、进程、网络和破坏性操作时，必须遵守审批、幂等和工作区边界。

## 输出要求

优先给出可验证的工程结论；涉及代码时明确文件、接口、schema、测试和兼容性影响。

## 架构背景

- `src/main.ts`：启动入口。
- `src/protocol/`：RPC 协议类型和 zod schema。
- `src/server/`：WebSocket server、请求分发、事件发送和会话生命周期。
- `src/providers/`：LLM provider client、模型列表、token 估算和流式处理。
- `src/prompts/`：系统提示词模板和组合注册。
- `src/mcp/`：内置 MCP、Godot 项目工具、EditorBridge、诊断桥和自定义 MCP。
- `src/workflow/`：固定 workflow 与 LLM planned workflow 调度。

## 开发约定

- TypeScript 使用 `strict`。
- 外部输入必须在边界用 zod 校验。
- `verbatimModuleSyntax` 下类型导入使用 `import type`。
- NodeNext import 必须带 `.js` 扩展。
- 文件使用 UTF-8 无 BOM、LF 行尾。
- 导出函数、RPC payload、工具参数和事件结构应显式标注类型。
- API key 只留在后端，不能暴露给 Godot 客户端、日志或前端响应。
