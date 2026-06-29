import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const MAX_TOOL_STEPS: number = 4;
export const MAX_TOOL_RESULT_CHARS: number = 12000;

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
	}
];

export function getToolDefinitions(): ChatCompletionTool[] {
	return TOOL_DEFINITIONS;
}

export function resolveToolMapping(llmToolName: string): ToolMapping {
	const mapping: ToolMapping | undefined = TOOL_MAP[llmToolName];

	if (!mapping) {
		throw new Error(`Unknown tool: ${llmToolName}`);
	}

	return mapping;
}
