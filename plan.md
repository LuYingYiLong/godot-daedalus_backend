# Godot MCP 完善计划

## 背景

这次让 AI 生成“猜数字游戏”时暴露出一个关键缺口：当前 Godot MCP 能读取 `.tscn`，但不能安全创建或修改 `.tscn` 场景文件。AI 因此只能创建脚本或文本文件，无法完成“生成可运行 Godot 场景”的闭环。

目标不是简单放开 `.tscn` 写入，而是让后端提供可审批、可验证、可回滚的 Godot 场景操作能力。

## 当前能力盘点

- 可读：项目摘要、文件列表、场景列表、脚本列表、文本文件、文本搜索。
- 可写：`.gd`、`.tres`、`.json`、`.md`、`.txt` 的创建、覆盖、替换、删除。
- 审批：写入类工具会进入 Godot 客户端审批。
- 验证：可通过 terminal MCP 调用 `godot.check_only`。
- 缺口：`.tscn` 不在写入白名单；缺少“创建场景、添加节点、连接脚本、保存场景”的语义工具。

## 里程碑 1：安全支持 `.tscn` 文本写入

先把 `.tscn` 纳入受控写入范围，但只允许走 propose -> approve 流程。

任务：

- 将 `.tscn` 加入 `WRITABLE_EXTENSIONS`。
- 更新 `llm-tools.ts` 中相关工具描述，明确 `.tscn` 可写但需要审批。
- 更新 `tool-policy.ts`，保持 `.tscn` 实际写入为 `write` 风险。
- 为 `.tscn` 写入增加额外校验：必须包含 `[gd_scene ...]`，必须有根 `[node ...]`，禁止写入 `.godot/`、`addons/`。
- 写入后自动建议运行 `godot.check_only`。

验收：

- AI 能提出创建 `guess_number.tscn`。
- 用户审批后文件成功创建。
- Godot 无头检查不报语法错误。

## 里程碑 2：场景语义 MCP 工具

纯文本写 `.tscn` 容易出错。第二步增加更稳定的语义工具，让 AI 不必手写完整场景文本。

建议新增 MCP 工具：

- `create_scene`：创建基础场景，参数包含 `relativePath`、`rootNodeType`、`rootNodeName`。
- `add_node_to_scene`：向场景添加节点，参数包含 `scenePath`、`parentPath`、`nodeType`、`nodeName`、`properties`。
- `attach_script_to_node`：给节点挂脚本。
- `connect_signal_in_scene`：连接信号。
- `inspect_scene_tree`：解析 `.tscn`，返回节点树、脚本、信号连接。

实现建议：

- v1 可以用文本解析和模板生成。
- v2 更稳：调用 Godot headless 编辑器脚本，让 Godot 自己创建/保存 `PackedScene`。

## 里程碑 3：Godot Headless 场景操作器

新增一个 Godot 侧 helper 脚本，例如：

`res://addons/godot_daedalus/tools/scene_operator.gd`

后端通过终端 MCP 调用：

```powershell
Godot --headless --path <project> --script scene_operator.gd -- <operation-json>
```

优势：

- 场景保存由 Godot 完成，格式更可靠。
- 能检查节点类型、资源路径、脚本加载错误。
- 能天然生成正确的 `.tscn` 结构。

## 里程碑 4：审批与预览升级

场景操作审批不能只显示 JSON 参数，应显示用户能理解的变更摘要。

前端审批面板建议显示：

- 将创建/修改的文件路径。
- 节点树变更摘要。
- 将连接的脚本和信号。
- 风险等级：create / overwrite / destructive。
- 操作后建议执行的验证命令。

## 里程碑 5：完整生成游戏工作流

目标工作流：

1. 用户说：“帮我做一个猜数字游戏。”
2. AI 调用 `create_scene` 创建 `scenes/guess_number.tscn`。
3. AI 调用 `create_text_file` 创建 `scripts/guess_number.gd`。
4. AI 调用 `attach_script_to_node`。
5. AI 调用 `connect_signal_in_scene`。
6. 用户审批写入。
7. 后端自动运行 `godot.check_only`。
8. AI 总结创建了哪些文件、如何运行、下一步如何测试。

## 风险与边界

- 不允许默认写入 `addons/`，除非用户切换到插件开发工作区并显式允许。
- 不允许修改 `.godot/`。
- 场景覆盖必须走 propose/approval。
- 删除场景属于 destructive，始终需要审批。
- AI 生成的 `.tscn` 必须经过 Godot 校验，不能只靠文本检查。

## 推荐优先级

1. 先放开 `.tscn` 的受控 propose/create，并加基础结构校验。
2. 再做 `inspect_scene_tree`，让 AI 能理解现有场景。
3. 再做 headless `create_scene` / `add_node_to_scene`。
4. 最后做前端审批预览增强和自动验证闭环。
