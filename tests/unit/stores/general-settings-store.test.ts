import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

test("general settings default auto expand todo list to false and persist updates", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-general-settings-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const store = await import(`../../../src/general-settings-store.js?case=${Date.now()}-${Math.random()}`);
		const appPaths = await import(`../../../src/app-paths.js?case=${Date.now()}-${Math.random()}`);

		assert.equal((await store.getGeneralSettings()).autoExpandTodoList, false);

		const saved = await store.updateGeneralSettings({ autoExpandTodoList: true });
		assert.equal(saved.schemaVersion, 2);
		assert.equal(saved.autoExpandTodoList, true);
		assert.equal(saved.godotExecutablePath, null);
		assert.equal(saved.godotExecutableStatus, "unconfigured");
		assert.notEqual(saved.updatedAt, "");

		const rawConfig: string = await readFile(appPaths.getGeneralSettingsConfigPath(), "utf8");
		assert.match(rawConfig, /"autoExpandTodoList": true/u);
		assert.equal(rawConfig.endsWith("\n"), true);
		assert.equal((await store.getGeneralSettings()).autoExpandTodoList, true);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
});

test("general settings fallback to defaults for invalid config without compatibility migration", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-general-settings-invalid-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const store = await import(`../../../src/general-settings-store.js?case=${Date.now()}-${Math.random()}`);
		const appPaths = await import(`../../../src/app-paths.js?case=${Date.now()}-${Math.random()}`);

		const configPath: string = appPaths.getGeneralSettingsConfigPath();
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, JSON.stringify({
			schemaVersion: 0,
			autoExpandTodoList: true
		}), "utf8");

		assert.deepEqual(await store.getGeneralSettings(), {
			schemaVersion: 2,
			autoExpandTodoList: false,
			godotExecutablePath: null,
			godotExecutableVersion: null,
			godotExecutableStatus: "unconfigured",
			godotExecutableError: null,
			updatedAt: ""
		});
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
});

test("general settings migrates v1 and rejects an invalid Godot executable", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-general-settings-v1-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const store = await import(`../../../src/general-settings-store.js?case=${Date.now()}-${Math.random()}`);
		const appPaths = await import(`../../../src/app-paths.js?case=${Date.now()}-${Math.random()}`);
		const configPath: string = appPaths.getGeneralSettingsConfigPath();
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, JSON.stringify({
			schemaVersion: 1,
			autoExpandTodoList: true,
			updatedAt: "2026-07-23T00:00:00.000Z"
		}), "utf8");

		const migrated = await store.getGeneralSettings();
		assert.equal(migrated.schemaVersion, 2);
		assert.equal(migrated.autoExpandTodoList, true);
		assert.equal(migrated.godotExecutablePath, null);
		await assert.rejects(
			() => store.updateGeneralSettings({ godotExecutablePath: join(appDataDir, "missing-godot.exe") }),
			/Godot executable/u
		);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
});
