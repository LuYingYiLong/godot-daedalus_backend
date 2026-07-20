import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

async function withTempAppData<T>(fn: (registry: typeof import("../../../src/workspace/registry.js"), appDataDir: string) => Promise<T>): Promise<T> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const previousGodotProjectPath: string | undefined = process.env.GODOT_PROJECT_PATH;
	const previousGodotExecutablePath: string | undefined = process.env.GODOT_EXECUTABLE_PATH;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-workspace-appdata-"));
	process.env.USERPROFILE = appDataDir;
	delete process.env.GODOT_PROJECT_PATH;
	delete process.env.GODOT_EXECUTABLE_PATH;

	try {
		const registry = await import(`../../../src/workspace/registry.js?case=${Date.now()}-${Math.random()}`);
		return await fn(registry, appDataDir);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (previousGodotProjectPath === undefined) {
			delete process.env.GODOT_PROJECT_PATH;
		} else {
			process.env.GODOT_PROJECT_PATH = previousGodotProjectPath;
		}
		if (previousGodotExecutablePath === undefined) {
			delete process.env.GODOT_EXECUTABLE_PATH;
		} else {
			process.env.GODOT_EXECUTABLE_PATH = previousGodotExecutablePath;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
	}
}

test("workspace registry persists runtime workspaces", async (): Promise<void> => {
	await withTempAppData(async (registry, appDataDir): Promise<void> => {
		const projectDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-project-"));
		const workspace = registry.upsertRuntimeWorkspace(registry.createRuntimeWorkspace(projectDir, "D:/Godot/Godot.exe"));
		const configPath: string = path.join(appDataDir, ".daedalus", "config", "workspaces.json");
		const rawConfig: string = await fs.readFile(configPath, "utf8");
		const persisted = JSON.parse(rawConfig) as Array<Record<string, unknown>>;

		assert.equal(rawConfig.endsWith("\n"), true);
		assert.deepEqual((await fs.readdir(path.dirname(configPath))).sort(), ["workspaces.json"]);
		assert.equal(persisted.length, 1);
		assert.equal(persisted[0]?.id, workspace.id);
		assert.equal(persisted[0]?.name, workspace.name);
		assert.equal(persisted[0]?.kind, "godot");
		assert.equal(persisted[0]?.rootPath, workspace.rootPath);
		assert.equal(persisted[0]?.godotExecutablePath, "D:/Godot/Godot.exe");

		const reloadedRegistry = await import(`../../../src/workspace/registry.js?case=reload-${Date.now()}-${Math.random()}`);
		const loaded: WorkspaceConfig[] = reloadedRegistry.loadWorkspaces();
		assert.equal(loaded.some((item: WorkspaceConfig): boolean => item.id === workspace.id && item.rootPath === workspace.rootPath), true);

		await fs.rm(projectDir, { recursive: true, force: true });
	});
});

test("workspace registry deletes persisted runtime workspaces", async (): Promise<void> => {
	await withTempAppData(async (registry, appDataDir): Promise<void> => {
		const projectDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-project-"));
		const workspace = registry.upsertRuntimeWorkspace(registry.createRuntimeWorkspace(projectDir));
		const deleted: WorkspaceConfig | undefined = registry.deleteWorkspace(workspace.id);
		const configPath: string = path.join(appDataDir, ".daedalus", "config", "workspaces.json");
		const persisted = JSON.parse(await fs.readFile(configPath, "utf8")) as Array<Record<string, unknown>>;

		assert.equal(deleted?.id, workspace.id);
		assert.equal(registry.findWorkspace(workspace.id), undefined);
		assert.equal(registry.loadWorkspaces().some((item: WorkspaceConfig): boolean => item.id === workspace.id), false);
		assert.deepEqual(persisted, []);
		assert.equal(await fs.stat(projectDir).then((stats): boolean => stats.isDirectory()), true);

		await fs.rm(projectDir, { recursive: true, force: true });
	});
});

test("workspace registry hydrates missing runtime workspaces from session metadata", async (): Promise<void> => {
	await withTempAppData(async (registry): Promise<void> => {
		const hydrated: WorkspaceConfig[] = registry.hydrateWorkspacesFromSessionMetadata([
			{
				workspaceId: "runtime-680ece18e3",
				workspaceName: "example",
				workspaceKind: "godot",
				workspaceRoot: "D:/GodotProjects/example",
				godotExecutablePath: "D:/Godot/Godot.exe"
			}
		]);
		const loaded: WorkspaceConfig[] = registry.loadWorkspaces();

		assert.equal(hydrated.length, 1);
		assert.equal(hydrated[0]?.id, "runtime-680ece18e3");
		assert.equal(hydrated[0]?.name, "example");
		assert.equal(loaded.some((item: WorkspaceConfig): boolean => item.id === "runtime-680ece18e3" && item.name === "example"), true);

		const duplicateHydrated: WorkspaceConfig[] = registry.hydrateWorkspacesFromSessionMetadata([
			{
				workspaceId: "runtime-680ece18e3",
				workspaceName: "example",
				workspaceRoot: "D:/GodotProjects/example"
			}
		]);
		assert.equal(duplicateHydrated.length, 0);
	});
});
