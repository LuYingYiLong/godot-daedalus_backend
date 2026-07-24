import type { McpServerConfig } from "./types.js";
import { getDefaultWorkspace } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createGlobalSkillWorkspace } from "../skills/runtime.js";
import { createSelfInvocation } from "../runtime/self-invocation.js";

export const TERMINAL_MCP_SERVER_ID: string = "terminal";
export const WORKSPACE_MCP_SERVER_ID: string = "workspace";

const defaultWs = getDefaultWorkspace();
const DEFAULT_GODOT_PROJECT_PATH: string | undefined = process.env.GODOT_PROJECT_PATH ?? defaultWs?.rootPath;
const DEFAULT_GODOT_EXECUTABLE_PATH: string | undefined = process.env.GODOT_EXECUTABLE_PATH ?? defaultWs?.godotExecutablePath;

export function buildGlobalMcpServerConfigs(defaultGodotExecutablePath?: string | undefined): McpServerConfig[] {
	const terminalInvocation = createSelfInvocation(["mcp", "terminal"]);
	const skillsInvocation = createSelfInvocation(["mcp", "skills"]);
	const terminalEnv: Record<string, string> = {
		BACKEND_DIR: process.cwd()
	};
	const globalSkillWorkspace = createGlobalSkillWorkspace();

	if (DEFAULT_GODOT_PROJECT_PATH !== undefined) {
		terminalEnv.GODOT_PROJECT_PATH = DEFAULT_GODOT_PROJECT_PATH;
	}
	const effectiveExecutablePath: string | undefined = defaultGodotExecutablePath ?? DEFAULT_GODOT_EXECUTABLE_PATH;
	if (effectiveExecutablePath !== undefined) {
		terminalEnv.GODOT_EXECUTABLE_PATH = effectiveExecutablePath;
	}

	return [
		{
			id: TERMINAL_MCP_SERVER_ID,
			name: "Terminal MCP",
			transport: "stdio",
			command: terminalInvocation.command,
			args: terminalInvocation.args,
			env: terminalEnv
		},
		{
			id: "skills",
			name: "Daedalus Skills MCP",
			transport: "stdio",
			command: skillsInvocation.command,
			args: skillsInvocation.args,
			env: {
				DAEDALUS_WORKSPACE_ID: globalSkillWorkspace.id,
				GODOT_PROJECT_PATH: globalSkillWorkspace.rootPath
			}
		}
	];
}

export function buildMcpServerConfigs(workspace?: WorkspaceConfig, defaultGodotExecutablePath?: string | undefined): McpServerConfig[] {
	const projectPath: string | undefined = workspace?.rootPath;

	if (!projectPath) {
		return [];
	}

	const configs: McpServerConfig[] = [];
	const workspaceInvocation = createSelfInvocation(["mcp", "workspace"]);
	const godotInvocation = createSelfInvocation(["mcp", "godot"]);
	const skillsInvocation = createSelfInvocation(["mcp", "skills"]);
	configs.push({
		id: WORKSPACE_MCP_SERVER_ID,
		name: "Workspace MCP",
		transport: "stdio",
		command: workspaceInvocation.command,
		args: workspaceInvocation.args,
		env: {
			WORKSPACE_ID: workspace?.id ?? "default",
			WORKSPACE_ROOT: projectPath
		}
	});

	const isGodotProject: boolean = existsSync(join(projectPath, "project.godot"));
	if (isGodotProject) {
		const godotExecutablePath: string | undefined = workspace?.godotExecutablePath ?? defaultGodotExecutablePath;
		configs.push({
			id: "godot",
			name: "Godot Project MCP",
			transport: "stdio",
			command: godotInvocation.command,
			args: godotInvocation.args,
			env: {
				GODOT_PROJECT_PATH: projectPath,
				...(godotExecutablePath === undefined ? {} : { GODOT_EXECUTABLE_PATH: godotExecutablePath })
			}
		});
	}

	configs.push({
		id: "skills",
		name: "Daedalus Skills MCP",
		transport: "stdio",
		command: skillsInvocation.command,
		args: skillsInvocation.args,
		env: {
			DAEDALUS_WORKSPACE_ID: workspace?.id ?? "default",
			GODOT_PROJECT_PATH: projectPath
		}
	});

	return configs;
}
