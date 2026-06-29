import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkspaceConfig } from "./types.js";

const DEFAULT_CONFIG_PATH: string = resolve("config/workspaces.json");

let workspaceCache: WorkspaceConfig[] | null = null;

export function loadWorkspaces(configPath?: string): WorkspaceConfig[] {
	if (workspaceCache) {
		return workspaceCache;
	}

	const path: string = configPath ?? process.env.WORKSPACES_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;

	if (!existsSync(path)) {
		console.warn(`[workspace] Config file not found: ${path}`);
		workspaceCache = [];
		return workspaceCache;
	}

	const raw: string = readFileSync(path, "utf8");
	const parsed: unknown = JSON.parse(raw) as unknown;

	if (!Array.isArray(parsed)) {
		throw new Error(`Workspace config must be a JSON array: ${path}`);
	}

	workspaceCache = parsed as WorkspaceConfig[];
	return workspaceCache;
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
