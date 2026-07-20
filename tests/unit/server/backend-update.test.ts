import assert from "node:assert/strict";
import test from "node:test";
import { createBackendUpdateCheckResult, createBackendUpdateInstallResult } from "../../../src/server/backend-update.js";

test("backend update check reports unavailable when latest version is missing", (): void => {
	const result = createBackendUpdateCheckResult({
		currentVersion: "1.0.8",
		installedVersion: "1.0.8",
		latestVersion: null,
		checkedAt: "2026-07-20T10:00:00.000Z",
		errorMessage: "network failed"
	});

	assert.equal(result.updateAvailable, false);
	assert.equal(result.latestVersion, null);
	assert.equal(result.errorMessage, "network failed");
});

test("backend update check detects newer stable versions", (): void => {
	const result = createBackendUpdateCheckResult({
		currentVersion: "1.0.8",
		installedVersion: "1.0.8",
		latestVersion: "1.0.9",
		checkedAt: "2026-07-20T10:00:00.000Z",
		errorMessage: null
	});

	assert.equal(result.updateAvailable, true);
});

test("backend update check ignores older or equal versions", (): void => {
	assert.equal(createBackendUpdateCheckResult({
		currentVersion: "1.0.8",
		installedVersion: "1.0.8",
		latestVersion: "1.0.8",
		checkedAt: "2026-07-20T10:00:00.000Z",
		errorMessage: null
	}).updateAvailable, false);

	assert.equal(createBackendUpdateCheckResult({
		currentVersion: "1.0.8",
		installedVersion: "1.0.8",
		latestVersion: "1.0.7",
		checkedAt: "2026-07-20T10:00:00.000Z",
		errorMessage: null
	}).updateAvailable, false);
});

test("backend update install result does not expose local package paths", (): void => {
	const result = createBackendUpdateInstallResult("1.0.9", "1.0.8", "2026-07-20T10:00:00.000Z");

	assert.deepEqual(Object.keys(result).sort(), ["installed", "installedAt", "previousVersion", "version"]);
	assert.equal(result.installed, true);
	assert.equal(result.version, "1.0.9");
	assert.equal(result.previousVersion, "1.0.8");
});
