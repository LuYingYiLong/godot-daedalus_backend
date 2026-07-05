# Prompt 书写与管理规范

本目录是 Godot Daedalus 后端 prompt 的唯一规范入口。所有长期稳定规则、模式边界和可复用片段都应放在 `src/prompts/templates/` 下，并通过 `src/prompts/registry.ts` 组合。

## 核心原则

- 稳定规则放在 `instructions` / system prompt 层；用户本轮消息、编辑器上下文、文件片段、图片说明和工具结果放在 input / user 层。
- 指令必须前置，先说明角色、边界、工具能力、输出要求，再注入动态上下文。
- 动态上下文需要用清晰标题和分隔符隔开；必要时使用 `###` 或 `"""` 区分指令与上下文。
- 优先写正向规则，例如“先说明将要读取哪些上下文”，再写必要的禁止项。
- 模板只描述长期有效的行为规则，禁止硬编码临时项目事实、模型名、用户机器路径、版本号或一次性任务目标。
- 大模板默认使用中文；只有专门面向代码/API 英文上下文的片段才使用英文。

## API 映射

当前 DeepSeek / Moonshot 供应商仍走 OpenAI-compatible Chat Completions，不在本轮切换 API。

Chat Completions 映射：

- 稳定规则、模式 overlay、工具沟通约定和指令优先级组合成 system/developer-like message。
- 用户本轮消息、编辑器上下文、项目上下文和工具结果保留在 user/input 层。
- Settings 自定义提示词追加在稳定规则之后，但优先级低于 Runtime 安全边界、项目指令和用户当前消息。

未来接 OpenAI Responses API 时的映射：

- 稳定规则进入 `instructions`。
- 用户消息、图片、文件片段、编辑器上下文和工具结果进入 `input`。
- 不把动态上下文拼进长期 `instructions`，避免一次性事实污染后续行为。

## 目录结构

- `templates/base/`：长期角色模板，例如 Godot assistant、GDScript reviewer、scene architect、backend helper。
- `templates/modes/`：模式 overlay，例如 Ask mode，未来 Plan mode 放这里。
- `templates/fragments/`：可复用系统片段，例如工具沟通约定、指令优先级、Settings 自定义提示词边界。
- `templates/internal/`：内部任务模板，例如 session compressor。
- `TOOLS.md`：工具能力说明，代码源头仍是 `src/tools/llm-tools.ts`、`src/workflow/planner.ts`、`src/tools/tool-policy.ts`。

## 模板格式

每个非 fragment prompt 文件顶部必须包含：

- `## 模板用途`
- `## 适用范围`
- `## 工具边界`
- `## 输出要求`

模板正文使用 `##` 分节。动态上下文由代码注入，不应在模板内假设具体文件、路径或用户机器环境。

## 组合顺序

`composeSystemPrompt()` 当前按以下顺序组合：

1. base 模板。
2. Runtime 当前模型上下文。
3. mode overlay，例如 Ask 模式。
4. 工具调用沟通约定 fragment。
5. 指令优先级 fragment。
6. Settings 用户提示词边界 fragment。
7. Settings 用户提示词正文。

Ask 模式等安全边界必须出现在 Settings 用户提示词之前，且不得被自定义提示词覆盖。
