import type { McpServerConfig } from "./types.js";

export const mcpServerConfigs: McpServerConfig[] = [
	{
		id: "godot",
		name: "Godot Project MCP",
		command: "npx",
		args: ["tsx", "src/mcp/godot-mcp-server.ts"],
		env: {
			GODOT_PROJECT_PATH: "D:\\GodotProjects\\example"
		}
	}
];
