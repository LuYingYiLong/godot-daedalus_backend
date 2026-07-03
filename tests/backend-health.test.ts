import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBackendHealthResult, getBackendPackageVersion } from "../src/server/backend-health.js";
import { DEVELOPMENT_BACKEND_PORT, getDefaultBackendPort, PUBLISHED_BACKEND_PORT } from "../src/server/backend-runtime.js";

type PackageManifest = {
	version?: unknown;
};

test("backend health reports the package version", async (): Promise<void> => {
	const manifest: PackageManifest = JSON.parse(await readFile("package.json", "utf8")) as PackageManifest;
	assert.equal(typeof manifest.version, "string");
	assert.equal(getBackendPackageVersion(), manifest.version);

	const health = createBackendHealthResult();
	assert.equal(health.name, "godot-daedalus-backend");
	assert.equal(health.version, manifest.version);
	assert.equal(typeof health.pid, "number");
	assert.ok(health.mode === "development" || health.mode === "runtime");
	assert.equal(typeof health.port, "number");
	assert.equal(getDefaultBackendPort("runtime"), PUBLISHED_BACKEND_PORT);
	assert.equal(getDefaultBackendPort("development"), DEVELOPMENT_BACKEND_PORT);
});
