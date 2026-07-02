import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const DEFAULT_TOOL_STEPS: number = 10;

export type ToolBudgetLevel = "simple" | "normal" | "codegen" | "project_edit";

const TOOL_BUDGET_MAP: Record<ToolBudgetLevel, number> = {
	simple: 4,
	normal: 10,
	codegen: 20,
	project_edit: 30
};

const SKILL_BUDGET_MAP: Record<string, number> = {
	"gdscript.review": 8,
	"godot.project_init": 12,
	"file.creator": 16,
	"scene.builder": 20,
	"backend.helper": 10
};

export function resolveToolBudget(
	budgetLevel?: ToolBudgetLevel | string,
	skillId?: string
): number {
	if (budgetLevel && TOOL_BUDGET_MAP[budgetLevel as ToolBudgetLevel]) {
		return TOOL_BUDGET_MAP[budgetLevel as ToolBudgetLevel];
	}

	if (skillId && SKILL_BUDGET_MAP[skillId]) {
		return SKILL_BUDGET_MAP[skillId];
	}

	return DEFAULT_TOOL_STEPS;
}

export const MAX_TOOL_RESULT_CHARS: number = 12000;
export const MAX_TOTAL_TOOL_RESULT_CHARS: number = 48000;

type ToolMapping = {
	serverId: string;
	toolName: string;
};

const TOOL_MAP: Record<string, ToolMapping> = {
	"mcp_godot_get_project_summary": {
		serverId: "godot",
		toolName: "get_project_summary"
	},
	"mcp_godot_list_project_files": {
		serverId: "godot",
		toolName: "list_project_files"
	},
	"mcp_godot_list_scenes": {
		serverId: "godot",
		toolName: "list_scenes"
	},
	"mcp_godot_list_scripts": {
		serverId: "godot",
		toolName: "list_scripts"
	},
	"mcp_godot_read_text_file": {
		serverId: "godot",
		toolName: "read_text_file"
	},
	"mcp_godot_search_text": {
		serverId: "godot",
		toolName: "search_text"
	},
	"mcp_godot_propose_create_text_file": {
		serverId: "godot",
		toolName: "propose_create_text_file"
	},
	"mcp_godot_create_text_file": {
		serverId: "godot",
		toolName: "create_text_file"
	},
	"mcp_godot_propose_overwrite_text_file": {
		serverId: "godot",
		toolName: "propose_overwrite_text_file"
	},
	"mcp_godot_overwrite_text_file": {
		serverId: "godot",
		toolName: "overwrite_text_file"
	},
	"mcp_godot_propose_replace_text_in_file": {
		serverId: "godot",
		toolName: "propose_replace_text_in_file"
	},
	"mcp_godot_replace_text_in_file": {
		serverId: "godot",
		toolName: "replace_text_in_file"
	},
	"mcp_godot_delete_file": {
		serverId: "godot",
		toolName: "delete_file"
	},
	"mcp_terminal_run_safe_preset": {
		serverId: "terminal",
		toolName: "run_safe_preset"
	},
	"mcp_terminal_run_write_preset": {
		serverId: "terminal",
		toolName: "run_write_preset"
	},
	"mcp_terminal_get_capabilities": {
		serverId: "terminal",
		toolName: "get_terminal_capabilities"
	},
	"mcp_godot_inspect_scene_tree": {
		serverId: "godot",
		toolName: "inspect_scene_tree"
	},
	"mcp_godot_propose_create_scene": {
		serverId: "godot",
		toolName: "propose_create_scene"
	},
	"mcp_godot_create_scene": {
		serverId: "godot",
		toolName: "create_scene"
	},
	"mcp_godot_propose_add_node_to_scene": {
		serverId: "godot",
		toolName: "propose_add_node_to_scene"
	},
	"mcp_godot_add_node_to_scene": {
		serverId: "godot",
		toolName: "add_node_to_scene"
	},
	"mcp_godot_propose_attach_script_to_node": {
		serverId: "godot",
		toolName: "propose_attach_script_to_node"
	},
	"mcp_godot_attach_script_to_node": {
		serverId: "godot",
		toolName: "attach_script_to_node"
	},
	"mcp_godot_propose_connect_signal_in_scene": {
		serverId: "godot",
		toolName: "propose_connect_signal_in_scene"
	},
	"mcp_godot_connect_signal_in_scene": {
		serverId: "godot",
		toolName: "connect_signal_in_scene"
	},
	"mcp_godot_propose_apply_scene_patch": {
		serverId: "godot",
		toolName: "propose_apply_scene_patch"
	},
	"mcp_godot_apply_scene_patch": {
		serverId: "godot",
		toolName: "apply_scene_patch"
	},
	"mcp_terminal_run_godot_scene_script": {
		serverId: "terminal",
		toolName: "run_godot_scene_script"
	}
};

const TOOL_DEFINITIONS: ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			name: "mcp_godot_get_project_summary",
			description: "获取 Godot 项目的摘要信息，包括项目名称、主场景、场景和脚本数量、插件列表等",
			parameters: {
				type: "object",
				properties: {},
				required: []
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_list_project_files",
			description: "递归列出 Godot 项目文件，可按子目录和扩展名过滤",
			parameters: {
				type: "object",
				properties: {
					subdir: {
						type: "string",
						description: "相对于项目根目录的子目录路径"
					},
					extensions: {
						type: "array",
						items: { type: "string" },
						description: "扩展名过滤，例如 ['.gd', '.tscn']"
					},
					includeAddons: {
						type: "boolean",
						description: "是否包含 addons 目录"
					}
				},
				required: []
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_list_scenes",
			description: "列出 Godot 项目中所有 .tscn 场景文件",
			parameters: {
				type: "object",
				properties: {
					includeAddons: {
						type: "boolean",
						description: "是否包含 addons 目录"
					}
				},
				required: []
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_list_scripts",
			description: "列出 Godot 项目中所有 .gd 脚本文件",
			parameters: {
				type: "object",
				properties: {
					includeAddons: {
						type: "boolean",
						description: "是否包含 addons 目录"
					}
				},
				required: []
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_read_text_file",
			description: "读取 Godot 项目中的文本文件内容",
			parameters: {
				type: "object",
				properties: {
					relativePath: {
						type: "string",
						description: "相对于项目根目录的文件路径"
					}
				},
				required: ["relativePath"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_search_text",
			description: "在项目文本文件中搜索关键词，返回匹配的文件路径和行号",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "要搜索的文本关键词"
					},
					extensions: {
						type: "array",
						items: { type: "string" },
						description: "扩展名过滤，例如 ['.gd']"
					},
					limit: {
						type: "integer",
						description: "最多返回多少条匹配，默认 50"
					}
				},
				required: ["query"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_inspect_scene_tree",
			description: "解析并检查 Godot .tscn 场景树，返回节点、脚本和连接等结构信息",
			parameters: {
				type: "object",
				properties: {
					relativePath: {
						type: "string",
						description: "场景文件的相对路径，例如 'scenes/main.tscn'"
					}
				},
				required: ["relativePath"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_propose_create_text_file",
			description: "仅预览新建文本文件方案，不会实际写入磁盘，也不会创建审批。只能创建 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。不允许覆盖已有文件。需要真正写入时，必须改用 mcp_godot_create_text_file。",
			parameters: {
				type: "object",
				properties: {
					relativePath: {
						type: "string",
						description: "相对于项目根目录的新文件路径，例如 'scripts/enemy.gd'"
					},
					content: {
						type: "string",
						description: "文件的完整内容"
					}
				},
				required: ["relativePath", "content"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_create_text_file",
			description: "创建一个新的 Godot 项目文本文件。该工具会实际写入磁盘，默认需要用户在 Godot 客户端审批。支持创建 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。不允许覆盖已有文件，不允许写入 .godot/ 或 addons/。写入后建议运行 godot.check_only 验证。",
			parameters: {
				type: "object",
				properties: {
					relativePath: {
						type: "string",
						description: "相对于项目根目录的新文件路径，例如 'scripts/enemy.gd'"
					},
					content: {
						type: "string",
						description: "文件的完整内容"
					}
				},
				required: ["relativePath", "content"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_propose_overwrite_text_file",
			description: "仅预览覆盖已有文件方案，不会实际写入，也不会创建审批。支持 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。文件必须已存在，会返回新旧内容对比。需要真正覆盖时，必须改用 mcp_godot_overwrite_text_file。",
			parameters: {
				type: "object",
				properties: {
					relativePath: { type: "string", description: "要覆盖的已有文件路径" },
					content: { type: "string", description: "新的完整文件内容" }
				},
				required: ["relativePath", "content"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_overwrite_text_file",
			description: "覆盖已有文本文件，会实际写入磁盘，默认需要用户在 Godot 客户端审批。支持写入 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。不允许写入 .godot/、addons/ 或隐藏目录。写入后建议运行 godot.check_only 验证。",
			parameters: {
				type: "object",
				properties: {
					relativePath: { type: "string", description: "要覆盖的已有文件路径" },
					content: { type: "string", description: "新的完整文件内容" }
				},
				required: ["relativePath", "content"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_propose_replace_text_in_file",
			description: "仅预览替换文件中指定文本的方案，不会实际写入，也不会创建审批。oldText 必须精确匹配（含空白和缩进），只替换首次出现。需要真正替换时，必须改用 mcp_godot_replace_text_in_file。",
			parameters: {
				type: "object",
				properties: {
					relativePath: { type: "string", description: "已有文件路径" },
					oldText: { type: "string", description: "要被替换的原文本，必须精确匹配" },
					newText: { type: "string", description: "替换后的新文本" }
				},
				required: ["relativePath", "oldText", "newText"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_replace_text_in_file",
			description: "替换已有文本文件中首次出现的指定文本，会实际写入磁盘，默认需要用户在 Godot 客户端审批。oldText 必须精确匹配。",
			parameters: {
				type: "object",
				properties: {
					relativePath: { type: "string", description: "已有文件路径" },
					oldText: { type: "string", description: "要被替换的原文本，必须精确匹配" },
					newText: { type: "string", description: "替换后的新文本" }
				},
				required: ["relativePath", "oldText", "newText"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_delete_file",
			description: "删除项目中的文件。此操作不可逆，需要用户确认。不能删除 .godot/ 中的文件。",
			parameters: {
				type: "object",
				properties: {
					relativePath: { type: "string", description: "要删除的文件路径" }
				},
				required: ["relativePath"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_terminal_get_capabilities",
			description: "获取终端 MCP 支持的所有预设命令列表及其风险等级。首次使用终端工具前应先调用此工具了解可用命令。",
			parameters: {
				type: "object",
				properties: {},
				required: []
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_terminal_run_safe_preset",
			description: "执行安全的（read/verify 风险）终端预设命令，自动允许。包括：backend.typecheck（TypeScript 类型检查）、git.status（Git 工作区状态）、git.diff（Git 差异）、godot.check_only（Godot 语法检查）、godot.validate_scene（Godot 场景加载验证）。Godot 预设建议传 resourcePath 精确检查目标 .gd 或 .tscn，工具结果会返回实际执行命令和 cwd。",
			parameters: {
				type: "object",
				properties: {
					presetName: {
						type: "string",
						description: "安全预设名称，如 'backend.typecheck'、'git.status'、'git.diff'、'godot.check_only'、'godot.validate_scene'"
					},
					resourcePath: {
						type: "string",
						description: "Godot 资源路径，仅 Godot 预设需要。可用 res://、项目相对路径或项目内绝对路径，例如 scripts/main.gd、scenes/main.tscn。检查脚本用 godot.check_only + .gd；验证场景用 godot.validate_scene + .tscn。"
					}
				},
				required: ["presetName"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_terminal_run_godot_scene_script",
			description: "通过 Godot headless 模式调用 scene_operator.gd 执行场景创建/编辑操作。支持 create_scene（创建场景）、add_node（添加节点）、attach_script（挂载脚本）、connect_signal（连接信号）、inspect（查看场景树）。传入 JSON 格式的 operationJson 参数。此工具需要用户审批。",
			parameters: {
				type: "object",
				properties: {
					operationJson: {
						type: "string",
						description: "JSON 格式的场景操作。create_scene: {\"operation\":\"create_scene\",\"path\":\"scenes/foo.tscn\",\"root_type\":\"Node2D\",\"root_name\":\"Main\"}。add_node: {\"operation\":\"add_node\",\"scene_path\":\"...\",\"parent_path\":\".\",\"node_type\":\"Label\",\"node_name\":\"Hello\",\"properties\":{}}。attach_script: {\"operation\":\"attach_script\",\"scene_path\":\"...\",\"node_path\":\"Main\",\"script_path\":\"res://scripts/main.gd\"}。connect_signal: {\"operation\":\"connect_signal\",\"scene_path\":\"...\",\"signal\":\"pressed\",\"from\":\"Button\",\"to\":\".\",\"method\":\"_on_pressed\"}。inspect: {\"operation\":\"inspect\",\"scene_path\":\"...\"}"
					}
				},
				required: ["operationJson"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_terminal_run_write_preset",
			description: "执行写操作（write 风险）终端预设命令，需要通过审批系统批准。可用的写预设：git.init。此工具调用后不会立即执行，需要用户在 Godot 客户端批准。",
			parameters: {
				type: "object",
				properties: {
					presetName: {
						type: "string",
						description: "写操作预设名称，如 'git.init'"
					}
				},
				required: ["presetName"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_propose_apply_scene_patch",
			description: "仅预览批量修改已有 Godot .tscn 场景的方案，不会实际写入，也不会创建审批。支持一次添加多个节点、挂载脚本、连接信号。需要真正修改场景时，必须改用 mcp_godot_apply_scene_patch。",
			parameters: {
				type: "object",
				properties: {
					scenePath: {
						type: "string",
						description: "已有场景文件路径，例如 'scenes/guess_number.tscn'"
					},
					operations: {
						type: "array",
						description: "按顺序执行的场景操作列表。节点属性值必须是 .tscn 表达式字符串，例如 text 写成 '\"Hello\"'，数值可写成 '15'。",
						items: {
							oneOf: [
								{
									type: "object",
									properties: {
										type: { const: "add_node" },
										parentPath: { type: "string" },
										nodeType: { type: "string" },
										nodeName: { type: "string" },
										properties: {
											type: "object",
											additionalProperties: { type: "string" }
										}
									},
									required: ["type", "parentPath", "nodeType", "nodeName"]
								},
								{
									type: "object",
									properties: {
										type: { const: "attach_script" },
										nodePath: { type: "string" },
										scriptPath: { type: "string" }
									},
									required: ["type", "nodePath", "scriptPath"]
								},
								{
									type: "object",
									properties: {
										type: { const: "connect_signal" },
										signal: { type: "string" },
										fromNode: { type: "string" },
										toNode: { type: "string" },
										method: { type: "string" },
										flags: { type: "integer" },
										binds: { type: "string" }
									},
									required: ["type", "signal", "fromNode", "toNode", "method"]
								}
							]
						},
						minItems: 1,
						maxItems: 50
					}
				},
				required: ["scenePath", "operations"]
			}
		}
	},
	{
		type: "function",
		function: {
			name: "mcp_godot_apply_scene_patch",
			description: "批量修改已有 Godot .tscn 场景，会实际写入磁盘并触发用户审批。支持一次添加多个节点、挂载脚本、连接信号。创建复杂 UI 或小游戏场景时，应优先使用本工具，不要逐个调用 add_node_to_scene。",
			parameters: {
				type: "object",
				properties: {
					scenePath: {
						type: "string",
						description: "已有场景文件路径，例如 'scenes/guess_number.tscn'"
					},
					operations: {
						type: "array",
						description: "按顺序执行的场景操作列表。节点属性值必须是 .tscn 表达式字符串，例如 text 写成 '\"Hello\"'，数值可写成 '15'。",
						items: {
							oneOf: [
								{
									type: "object",
									properties: {
										type: { const: "add_node" },
										parentPath: { type: "string" },
										nodeType: { type: "string" },
										nodeName: { type: "string" },
										properties: {
											type: "object",
											additionalProperties: { type: "string" }
										}
									},
									required: ["type", "parentPath", "nodeType", "nodeName"]
								},
								{
									type: "object",
									properties: {
										type: { const: "attach_script" },
										nodePath: { type: "string" },
										scriptPath: { type: "string" }
									},
									required: ["type", "nodePath", "scriptPath"]
								},
								{
									type: "object",
									properties: {
										type: { const: "connect_signal" },
										signal: { type: "string" },
										fromNode: { type: "string" },
										toNode: { type: "string" },
										method: { type: "string" },
										flags: { type: "integer" },
										binds: { type: "string" }
									},
									required: ["type", "signal", "fromNode", "toNode", "method"]
								}
							]
						},
						minItems: 1,
						maxItems: 50
					}
				},
				required: ["scenePath", "operations"]
			}
		}
	}
];

export function getToolDefinitions(): ChatCompletionTool[] {
	return TOOL_DEFINITIONS;
}

export function getToolDefinitionsForNames(toolNames: readonly string[]): ChatCompletionTool[] {
	const allowedNames: Set<string> = new Set(toolNames);
	return TOOL_DEFINITIONS.filter((tool: ChatCompletionTool): boolean => {
		if (tool.type !== "function") {
			return false;
		}

		return allowedNames.has(tool.function.name);
	});
}

export function resolveToolMapping(llmToolName: string): ToolMapping {
	const mapping: ToolMapping | undefined = TOOL_MAP[llmToolName];

	if (!mapping) {
		throw new Error(`Unknown tool: ${llmToolName}`);
	}

	return mapping;
}
