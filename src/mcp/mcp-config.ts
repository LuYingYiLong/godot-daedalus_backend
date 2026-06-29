import type { McpServerConfig } from "./types.js";

const DEFAULT_GODOT_PROJECT_PATH: string = "D:\\GodotProjects\\example";
const DEFAULT_GODOT_EXECUTABLE_PATH: string = "D:\\Godot_v4.7-stable_win64.exe\\Godot_v4.7-stable_win64.exe";

export const mcpServerConfigs: McpServerConfig[] = [
	{
		id: "godot",
		name: "Godot Project MCP",
		command: "npx",
		args: ["tsx", "src/mcp/godot-mcp-server.ts"],
		env: {
			GODOT_PROJECT_PATH: process.env.GODOT_PROJECT_PATH ?? DEFAULT_GODOT_PROJECT_PATH
		}
	},
	{
		id: "terminal",
		name: "Terminal MCP",
		command: "npx",
		args: ["tsx", "src/mcp/terminal-mcp-server.ts"],
		env: {
			BACKEND_DIR: process.cwd(),
			GODOT_EXECUTABLE_PATH: process.env.GODOT_EXECUTABLE_PATH ?? DEFAULT_GODOT_EXECUTABLE_PATH,
			GODOT_PROJECT_PATH: process.env.GODOT_PROJECT_PATH ?? DEFAULT_GODOT_PROJECT_PATH
		}
	}
];
