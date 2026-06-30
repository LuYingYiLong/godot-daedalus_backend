import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getDefaultWorkspaceConfigPath } from "../app-paths.js";
import type { WorkspaceConfig } from "./types.js";

let configuredWorkspaceCache: WorkspaceConfig[] | null = null;
const runtimeWorkspaces: Map<string, WorkspaceConfig> = new Map();

function loadConfiguredWorkspaces(): WorkspaceConfig[] {
	if (configuredWorkspaceCache) {
		return configuredWorkspaceCache;
	}

	const path: string = getDefaultWorkspaceConfigPath();

	if (!existsSync(path)) {
		console.warn(`[workspace] Config file not found: ${path}`);
		configuredWorkspaceCache = [];
		return configuredWorkspaceCache;
	}

	const raw: string = readFileSync(path, "utf8");
	const parsed: unknown = JSON.parse(raw) as unknown;

	if (!Array.isArray(parsed)) {
		throw new Error(`Workspace config must be a JSON array: ${path}`);
	}

	configuredWorkspaceCache = parsed as WorkspaceConfig[];
	return configuredWorkspaceCache;
}

export function createRuntimeWorkspace(rootPath: string, godotExecutablePath?: string | undefined): WorkspaceConfig {
	const normalizedRootPath: string = resolve(rootPath);
	const hash: string = createHash("sha1").update(normalizedRootPath.toLowerCase()).digest("hex").slice(0, 10);
	const name: string = basename(normalizedRootPath) || normalizedRootPath;

	return {
		id: `runtime-${hash}`,
		name,
		kind: "godot",
		rootPath: normalizedRootPath,
		godotExecutablePath
	};
}

export function upsertRuntimeWorkspace(workspace: WorkspaceConfig): WorkspaceConfig {
	const existing: WorkspaceConfig | undefined = runtimeWorkspaces.get(workspace.id);
	const next: WorkspaceConfig = {
		...existing,
		...workspace,
		godotExecutablePath: workspace.godotExecutablePath ?? existing?.godotExecutablePath
	};
	runtimeWorkspaces.set(next.id, next);
	return next;
}

function getEnvironmentWorkspace(): WorkspaceConfig | undefined {
	if (!process.env.GODOT_PROJECT_PATH) {
		return undefined;
	}

	return createRuntimeWorkspace(process.env.GODOT_PROJECT_PATH, process.env.GODOT_EXECUTABLE_PATH);
}

export function loadWorkspaces(): WorkspaceConfig[] {
	const byId: Map<string, WorkspaceConfig> = new Map();

	for (const workspace of loadConfiguredWorkspaces()) {
		byId.set(workspace.id, workspace);
	}

	const environmentWorkspace: WorkspaceConfig | undefined = getEnvironmentWorkspace();
	if (environmentWorkspace && !byId.has(environmentWorkspace.id)) {
		byId.set(environmentWorkspace.id, environmentWorkspace);
	}

	for (const workspace of runtimeWorkspaces.values()) {
		if (!byId.has(workspace.id)) {
			byId.set(workspace.id, workspace);
		}
	}

	return Array.from(byId.values());
}

export function findWorkspace(workspaceId: string): WorkspaceConfig | undefined {
	return loadWorkspaces().find((w: WorkspaceConfig): boolean => w.id === workspaceId);
}

export function getDefaultWorkspace(): WorkspaceConfig | undefined {
	const workspaces: WorkspaceConfig[] = loadWorkspaces();
	const defaultId: string | undefined = process.env.DEFAULT_WORKSPACE;

	if (defaultId) {
		const found: WorkspaceConfig | undefined = workspaces.find((w: WorkspaceConfig): boolean => w.id === defaultId);
		if (found) {
			return found;
		}
	}

	return workspaces[0];
}
