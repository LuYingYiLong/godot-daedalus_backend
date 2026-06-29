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
	"mcp_godot_propose_replace_text_in_file": {
		serverId: "godot",
		toolName: "propose_replace_text_in_file"
	},
	"mcp_godot_delete_file": {
		serverId: "godot",
		toolName: "delete_file"
	},
	"mcp_terminal_run_command_preset": {
		serverId: "terminal",
		toolName: "run_command_preset"
	},
	"mcp_terminal_get_capabilities": {
		serverId: "terminal",
		toolName: "get_terminal_capabilities"
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
			description: "提出新建一个文本文件的提案。不会实际写入磁盘。只能创建 .gd/.tres/.json/.md/.txt 文件，不允许覆盖已有文件。需要用户通过 Godot 客户端确认后才会真正写入。",
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
			description: "创建一个新的 Godot 项目文本文件。该工具会实际写入磁盘，默认需要用户在 Godot 客户端审批。只能创建 .gd/.tres/.json/.md/.txt 文件，不允许覆盖已有文件，不允许写入 .godot/ 或 addons/。",
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
			description: "提出覆盖已有文件的提案。不会实际写入。文件必须已存在，会返回新旧内容对比。AI 只能 propose，实际覆盖需要用户通过 Godot 客户端确认。",
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
			description: "获取终端 MCP 支持的所有预设命令列表。在首次使用终端工具前应先调用此工具了解可用命令。",
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
			name: "mcp_terminal_run_command_preset",
			description: "执行一个预设的终端命令。只能执行 get_terminal_capabilities 返回的预设名称。不能传入任意 shell 字符串。可用的预设包括：backend.typecheck（TypeScript 类型检查）、git.status（Git 工作区状态）、godot.check_only（Godot 脚本语法检查）。",
			parameters: {
				type: "object",
				properties: {
					presetName: {
						type: "string",
						description: "预设命令名称，如 'backend.typecheck'、'git.status'、'godot.check_only'"
					},
					workingDirectory: {
						type: "string",
						description: "可选，覆盖预设的默认工作目录"
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
