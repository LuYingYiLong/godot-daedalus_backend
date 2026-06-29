import type { McpServerConfig } from "./types.js";
import { getDefaultWorkspace } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";

const defaultWs = getDefaultWorkspace();
const DEFAULT_GODOT_PROJECT_PATH: string = process.env.GODOT_PROJECT_PATH ?? defaultWs?.rootPath ?? "D:\\GodotProjects\\example";
const DEFAULT_GODOT_EXECUTABLE_PATH: string = process.env.GODOT_EXECUTABLE_PATH ?? defaultWs?.godotExecutablePath ?? "D:\\Godot_v4.7-stable_win64.exe\\Godot_v4.7-stable_win64.exe";

export function buildMcpServerConfigs(workspace?: WorkspaceConfig): McpServerConfig[] {
	const projectPath: string = workspace?.rootPath ?? DEFAULT_GODOT_PROJECT_PATH;
	const godotPath: string = workspace?.godotExecutablePath ?? DEFAULT_GODOT_EXECUTABLE_PATH;

	return [
		{
			id: "godot",
			name: "Godot Project MCP",
			command: "npx",
			args: ["tsx", "src/mcp/godot-mcp-server.ts"],
			env: {
				GODOT_PROJECT_PATH: projectPath
			}
		},
		{
			id: "terminal",
			name: "Terminal MCP",
			command: "npx",
			args: ["tsx", "src/mcp/terminal-mcp-server.ts"],
			env: {
				BACKEND_DIR: process.cwd(),
				GODOT_EXECUTABLE_PATH: godotPath,
				GODOT_PROJECT_PATH: projectPath
			}
		}
	];
}

export const mcpServerConfigs: McpServerConfig[] = buildMcpServerConfigs();
