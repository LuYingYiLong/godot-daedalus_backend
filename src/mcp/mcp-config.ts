import type { McpServerConfig } from "./types.js";
import { getDefaultWorkspace } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

	const configs: McpServerConfig[] = [];
	const isGodotProject: boolean = existsSync(join(projectPath, "project.godot"));
	if (isGodotProject) {
		configs.push({
			id: "godot",
			name: "Godot Project MCP",
			transport: "stdio",
			command: "npx",
			args: ["tsx", "src/mcp/godot/server.ts"],
			env: {
				GODOT_PROJECT_PATH: projectPath
			}
		});
	}

	configs.push({
		id: "terminal",
		name: "Terminal MCP",
		transport: "stdio",
		command: "npx",
		args: ["tsx", "src/mcp/terminal/server.ts"],
		env: terminalEnv
	});
	return configs;
}

export const mcpServerConfigs: McpServerConfig[] = buildMcpServerConfigs();
