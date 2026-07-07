import type { McpServerConfig } from "./types.js";
import { getDefaultWorkspace } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";

const defaultWs = getDefaultWorkspace();
const DEFAULT_GODOT_PROJECT_PATH: string | undefined = process.env.GODOT_PROJECT_PATH ?? defaultWs?.rootPath;
const DEFAULT_GODOT_EXECUTABLE_PATH: string | undefined = process.env.GODOT_EXECUTABLE_PATH ?? defaultWs?.godotExecutablePath;

export function buildMcpServerConfigs(workspace?: WorkspaceConfig): McpServerConfig[] {
	const projectPath: string | undefined = workspace?.rootPath ?? DEFAULT_GODOT_PROJECT_PATH;
	const godotPath: string | undefined = workspace?.godotExecutablePath ?? DEFAULT_GODOT_EXECUTABLE_PATH;

	if (!projectPath) {
		return [];
	}

	const terminalEnv: Record<string, string> = {
		BACKEND_DIR: process.cwd(),
		GODOT_PROJECT_PATH: projectPath
	};

	if (godotPath) {
		terminalEnv.GODOT_EXECUTABLE_PATH = godotPath;
	}

	return [
		{
			id: "godot",
			name: "Godot Project MCP",
			transport: "stdio",
			command: "npx",
			args: ["tsx", "src/mcp/godot/server.ts"],
			env: {
				GODOT_PROJECT_PATH: projectPath
			}
		},
		{
			id: "terminal",
			name: "Terminal MCP",
			transport: "stdio",
			command: "npx",
			args: ["tsx", "src/mcp/terminal/server.ts"],
			env: terminalEnv
		}
	];
}

export const mcpServerConfigs: McpServerConfig[] = buildMcpServerConfigs();
