import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagerError } from "../src/manager/manager-error.js";
import { assertInside } from "../src/manager/paths.js";
import { isVersionNewer, parseSemver } from "../src/manager/semver.js";
import { validateFrontendManifest } from "../src/manager/frontend.js";
import { readJsonFile, writeJsonFile } from "../src/manager/json-file.js";
import type { BackendCurrentFile } from "../src/manager/types.js";
import { installBackend, rollbackBackend } from "../src/manager/backend.js";
import { getCachedOrFetchLatestVersion } from "../src/manager/latest-cache.js";

test("manager semver parser compares stable versions", (): void => {
	assert.deepEqual(parseSemver("v1.2.3"), [1, 2, 3]);
	assert.equal(isVersionNewer("1.2.4", "1.2.3"), true);
	assert.equal(isVersionNewer("1.2.3", "1.2.3"), false);
	assert.equal(isVersionNewer("1.2.3", "1.3.0"), false);
	assert.equal(isVersionNewer("bad", "1.3.0"), false);
});

test("manager path guard rejects traversal", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-path-"));
	assert.equal(assertInside(root, join(root, "backend", "current.json")), join(root, "backend", "current.json"));
	assert.throws((): void => {
		assertInside(root, join(root, "..", "outside"));
	}, ManagerError);
	await rm(root, { recursive: true, force: true });
});

test("frontend manifest validation rejects unsafe metadata", (): void => {
	validateFrontendManifest({
		version: "1.0.0",
		tag: "v1.0.0",
		assetName: "godot-daedalus-plugin-v1.0.0.zip",
		sha256: "a".repeat(64),
		minGodotVersion: "4.4"
	});
	assert.throws((): void => {
		validateFrontendManifest({
			version: "1.0",
			tag: "v1.0",
			assetName: "plugin.zip",
			sha256: "a".repeat(64)
		});
	}, ManagerError);
	assert.throws((): void => {
		validateFrontendManifest({
			version: "1.0.0",
			tag: "v1.0.1",
			assetName: "plugin.zip",
			sha256: "a".repeat(64)
		});
	}, ManagerError);
});

test("manager json file writes atomically readable current metadata", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-json-"));
	const filePath: string = join(root, "backend", "current.json");
	const value: BackendCurrentFile = {
		version: "1.0.4",
		path: join(root, "backend", "versions", "1.0.4"),
		previousVersion: "1.0.3",
		updatedAt: new Date(0).toISOString()
	};
	await writeJsonFile(filePath, value);
	assert.deepEqual(await readJsonFile<BackendCurrentFile>(filePath), value);
	assert.equal(await readFile(filePath, "utf8"), `${JSON.stringify(value, null, 2)}\n`);
	await rm(root, { recursive: true, force: true });
});

test("manager latest cache avoids repeated network checks", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-cache-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	try {
		let fetchCount: number = 0;
		const firstVersion: string | null = await getCachedOrFetchLatestVersion("frontend", async (): Promise<string> => {
			fetchCount += 1;
			return "1.0.0";
		});
		const secondVersion: string | null = await getCachedOrFetchLatestVersion("frontend", async (): Promise<string> => {
			fetchCount += 1;
			return "1.0.1";
		});
		assert.equal(firstVersion, "1.0.0");
		assert.equal(secondVersion, "1.0.0");
		assert.equal(fetchCount, 1);
	} finally {
		if (previousAppDir === undefined) {
			delete process.env.GODOT_DAEDALUS_APP_DIR;
		} else {
			process.env.GODOT_DAEDALUS_APP_DIR = previousAppDir;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test("manager latest cache can skip network entirely", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-cache-skip-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	try {
		let fetchCount: number = 0;
		const version: string | null = await getCachedOrFetchLatestVersion("backend", async (): Promise<string> => {
			fetchCount += 1;
			return "1.0.4";
		}, { skipNetwork: true });
		assert.equal(version, null);
		assert.equal(fetchCount, 0);
	} finally {
		if (previousAppDir === undefined) {
			delete process.env.GODOT_DAEDALUS_APP_DIR;
		} else {
			process.env.GODOT_DAEDALUS_APP_DIR = previousAppDir;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test("manager latest cache falls back to cached version when network throws", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-cache-error-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	try {
		const firstVersion: string | null = await getCachedOrFetchLatestVersion("frontend", async (): Promise<string> => "1.0.1");
		const secondVersion: string | null = await getCachedOrFetchLatestVersion("frontend", async (): Promise<string> => {
			throw new Error("fetch failed");
		}, { forceRefresh: true });
		assert.equal(firstVersion, "1.0.1");
		assert.equal(secondVersion, "1.0.1");
	} finally {
		if (previousAppDir === undefined) {
			delete process.env.GODOT_DAEDALUS_APP_DIR;
		} else {
			process.env.GODOT_DAEDALUS_APP_DIR = previousAppDir;
		}
		await rm(root, { recursive: true, force: true });
	}
});

test("frontend package fixture has addon layout", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-addon-"));
	const pluginCfgPath: string = join(root, "addons", "godot_daedalus", "plugin.cfg");
	await mkdir(join(root, "addons", "godot_daedalus"), { recursive: true });
	await writeFile(pluginCfgPath, "[plugin]\nversion=\"1.0.0\"\n", "utf8");
	assert.match(await readFile(pluginCfgPath, "utf8"), /version="1\.0\.0"/);
	await rm(root, { recursive: true, force: true });
});

test("backend install stages local packages and rollback switches current version", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-manager-install-"));
	const previousAppDir: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	const previousNpmDryRun: string | undefined = process.env.npm_config_dry_run;
	process.env.GODOT_DAEDALUS_APP_DIR = join(root, "app");
	process.env.npm_config_dry_run = "true";
	try {
		const package103: string = await createFakeBackendPackage(root, "1.0.3");
		const package104: string = await createFakeBackendPackage(root, "1.0.4");
		assert.equal((await installBackend(package103)).version, "1.0.3");
		assert.equal((await installBackend(package104)).version, "1.0.4");
		const rolledBack: BackendCurrentFile = await rollbackBackend();
		assert.equal(rolledBack.version, "1.0.3");
		assert.equal(rolledBack.previousVersion, "1.0.4");
	} finally {
		if (previousAppDir === undefined) {
			delete process.env.GODOT_DAEDALUS_APP_DIR;
		} else {
			process.env.GODOT_DAEDALUS_APP_DIR = previousAppDir;
		}
		if (previousNpmDryRun === undefined) {
			delete process.env.npm_config_dry_run;
		} else {
			process.env.npm_config_dry_run = previousNpmDryRun;
		}
		await rm(root, { recursive: true, force: true });
	}
});

async function createFakeBackendPackage(root: string, version: string): Promise<string> {
	const packageDir: string = join(root, `fake-${version}`);
	await mkdir(packageDir, { recursive: true });
	await writeFile(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: "godot-daedalus_backend",
			version,
			type: "module",
			bin: {
				"godot-daedalus-backend": "bin/backend.js",
				"godot-daedalus-manager": "bin/manager.js"
			}
		}, null, 2),
		"utf8"
	);
	await mkdir(join(packageDir, "bin"), { recursive: true });
	await writeFile(join(packageDir, "bin", "backend.js"), "#!/usr/bin/env node\n", "utf8");
	await writeFile(join(packageDir, "bin", "manager.js"), "#!/usr/bin/env node\n", "utf8");
	return packageDir;
}
