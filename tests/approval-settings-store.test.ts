import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("approval settings persist one global approval mode", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-approval-settings-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const settings = await import(`../src/approval-settings-store.js?case=${Date.now()}-${Math.random()}`);
		const appPaths = await import(`../src/app-paths.js?case=${Date.now()}-${Math.random()}`);

		assert.equal(await settings.getApprovalMode(), "manual");

		const saved = await settings.setApprovalMode("auto-safe");
		assert.equal(saved.mode, "auto-safe");
		assert.equal(await settings.getApprovalMode(), "auto-safe");

		const rawConfig: string = await readFile(appPaths.getApprovalConfigPath(), "utf8");
		assert.match(rawConfig, /"schemaVersion": 1/u);
		assert.match(rawConfig, /"mode": "auto-safe"/u);
		assert.equal(rawConfig.endsWith("\n"), true);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
});
