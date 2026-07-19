import type { McpServerConfig } from "./types.js";
import { getDefaultWorkspace } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const TERMINAL_MCP_SERVER_ID: string = "terminal";
export const WORKSPACE_MCP_SERVER_ID: string = "workspace";

const defaultWs = getDefaultWorkspace();
const DEFAULT_GODOT_PROJECT_PATH: string | undefined = process.env.GODOT_PROJECT_PATH ?? defaultWs?.rootPath;
const DEFAULT_GODOT_EXECUTABLE_PATH: string | undefined = process.env.GODOT_EXECUTABLE_PATH ?? defaultWs?.godotExecutablePath;

export function buildGlobalMcpServerConfigs(): McpServerConfig[] {
	const terminalEnv: Record<string, string> = {
		BACKEND_DIR: process.cwd()
	};

	if (DEFAULT_GODOT_PROJECT_PATH !== undefined) {
		terminalEnv.GODOT_PROJECT_PATH = DEFAULT_GODOT_PROJECT_PATH;
	}
	if (DEFAULT_GODOT_EXECUTABLE_PATH !== undefined) {
		terminalEnv.GODOT_EXECUTABLE_PATH = DEFAULT_GODOT_EXECUTABLE_PATH;
	}

	return [{
		id: TERMINAL_MCP_SERVER_ID,
		name: "Terminal MCP",
		transport: "stdio",
		command: "npx",
		args: ["tsx", "src/mcp/terminal/server.ts"],
		env: terminalEnv
	}];
}

export function buildMcpServerConfigs(workspace?: WorkspaceConfig): McpServerConfig[] {
	const projectPath: string | undefined = workspace?.rootPath;

	if (!projectPath) {
		return [];
	}

	const configs: McpServerConfig[] = [];
	configs.push({
		id: WORKSPACE_MCP_SERVER_ID,
		name: "Workspace MCP",
		transport: "stdio",
		command: "npx",
		args: ["tsx", "src/mcp/workspace/server.ts"],
		env: {
			WORKSPACE_ID: workspace?.id ?? "default",
			WORKSPACE_ROOT: projectPath
		}
	});

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
		id: "skills",
		name: "Daedalus Skills MCP",
		transport: "stdio",
		command: "npx",
		args: ["tsx", "src/mcp/skills/server.ts"],
		env: {
			DAEDALUS_WORKSPACE_ID: workspace?.id ?? "default",
			GODOT_PROJECT_PATH: projectPath
		}
	});

	return configs;
}
