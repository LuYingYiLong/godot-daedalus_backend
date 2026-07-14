import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getDefaultWorkspaceConfigPath } from "../app-paths.js";
import { writeJsonFileAtomicSync } from "../json-file-store.js";
import type { WorkspaceConfig } from "./types.js";
import { logger } from "../logger.js";

let configuredWorkspaceCache: WorkspaceConfig[] | null = null;
const runtimeWorkspaces: Map<string, WorkspaceConfig> = new Map();

export type WorkspaceMetadataSource = {
	workspaceId?: string | undefined;
	workspaceName?: string | undefined;
	workspaceKind?: "godot" | undefined;
	workspaceRoot?: string | undefined;
	godotExecutablePath?: string | undefined;
};

function loadConfiguredWorkspaces(): WorkspaceConfig[] {
	if (configuredWorkspaceCache) {
		return configuredWorkspaceCache;
	}

	const path: string = getDefaultWorkspaceConfigPath();

	if (!existsSync(path)) {
		logger.info("workspace", "config_missing", {
			path
		});
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

function saveConfiguredWorkspaces(workspaces: WorkspaceConfig[]): void {
	const configPath: string = getDefaultWorkspaceConfigPath();
	writeJsonFileAtomicSync(configPath, workspaces);
	configuredWorkspaceCache = workspaces;
}

function sameWorkspace(left: WorkspaceConfig, right: WorkspaceConfig): boolean {
	return left.id === right.id
		&& left.name === right.name
		&& left.kind === right.kind
		&& left.rootPath === right.rootPath
		&& left.godotExecutablePath === right.godotExecutablePath;
}

function persistRuntimeWorkspace(workspace: WorkspaceConfig): void {
	try {
		const currentWorkspaces: WorkspaceConfig[] = [...loadConfiguredWorkspaces()];
		const existingIndex: number = currentWorkspaces.findIndex((item: WorkspaceConfig): boolean => item.id === workspace.id);
		const existingWorkspace: WorkspaceConfig | undefined = existingIndex >= 0 ? currentWorkspaces[existingIndex] : undefined;
		const persistedWorkspace: WorkspaceConfig = {
			...existingWorkspace,
			...workspace,
			godotExecutablePath: workspace.godotExecutablePath ?? existingWorkspace?.godotExecutablePath
		};

		if (existingWorkspace !== undefined && sameWorkspace(existingWorkspace, persistedWorkspace)) {
			return;
		}

		if (existingIndex >= 0) {
			currentWorkspaces[existingIndex] = persistedWorkspace;
		} else {
			currentWorkspaces.push(persistedWorkspace);
		}

		saveConfiguredWorkspaces(currentWorkspaces);
		logger.info("workspace", "runtime_persisted", {
			workspaceId: persistedWorkspace.id,
			rootPath: persistedWorkspace.rootPath
		});
	} catch (error: unknown) {
		logger.warn("workspace", "runtime_persist_failed", {
			workspaceId: workspace.id,
			rootPath: workspace.rootPath,
			error: error instanceof Error ? error.message : String(error)
		});
	}
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
	persistRuntimeWorkspace(next);
	return next;
}

export function hydrateWorkspacesFromSessionMetadata(metadataList: WorkspaceMetadataSource[]): WorkspaceConfig[] {
	const hydrated: WorkspaceConfig[] = [];
	for (const metadata of metadataList) {
		if (metadata.workspaceId === undefined || metadata.workspaceRoot === undefined) {
			continue;
		}

		if (findWorkspace(metadata.workspaceId) !== undefined) {
			continue;
		}

		const fallbackName: string = basename(metadata.workspaceRoot) || metadata.workspaceRoot;
		hydrated.push(upsertRuntimeWorkspace({
			id: metadata.workspaceId,
			name: metadata.workspaceName ?? fallbackName,
			kind: metadata.workspaceKind ?? "godot",
			rootPath: metadata.workspaceRoot,
			godotExecutablePath: metadata.godotExecutablePath
		}));
	}

	return hydrated;
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
		persistRuntimeWorkspace(environmentWorkspace);
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
