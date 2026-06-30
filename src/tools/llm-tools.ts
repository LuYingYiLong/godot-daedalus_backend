import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const MAX_TOOL_STEPS: number = 4;
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
			name: "mcp_godot_propose_create_text_file",
			description: "提出新建一个文本文件的提案。不会实际写入磁盘。只能创建 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。不允许覆盖已有文件。需要用户通过 Godot 客户端确认后才会真正写入。",
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
			description: "提出覆盖已有文件的提案。不会实际写入。支持 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。文件必须已存在，会返回新旧内容对比。AI 只能 propose，实际覆盖需要用户通过 Godot 客户端确认。",
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
			description: "提出替换文件中指定文本的提案。不会实际写入。oldText 必须精确匹配（含空白和缩进），只替换首次出现。AI 只能 propose，实际替换需要用户确认。",
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
			description: "执行安全的（read/verify 风险）终端预设命令，自动允许。包括：backend.typecheck（TypeScript 类型检查）、git.status（Git 工作区状态）、git.diff（Git 差异）、godot.check_only（Godot 脚本语法检查）。",
			parameters: {
				type: "object",
				properties: {
					presetName: {
						type: "string",
						description: "安全预设名称，如 'backend.typecheck'、'git.status'、'git.diff'、'godot.check_only'"
					}
				},
				required: ["presetName"]
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
