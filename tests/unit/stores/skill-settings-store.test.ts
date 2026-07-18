import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getSkillSettingsPath } from "../../../src/app-paths.js";

async function withTempAppData<T>(fn: () => Promise<T>): Promise<T> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-skill-settings-"));
	process.env.USERPROFILE = appDataDir;

	try {
		return await fn();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		await rm(appDataDir, { recursive: true, force: true });
	}
}

test("skill settings persist enablement with atomic json formatting", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const settings = await import(`../../../src/skills/settings-store.js?case=${Date.now()}-${Math.random()}`);
		assert.equal(await settings.isSkillEnabled("workspace-a", "personal:demo", "personal"), false);

		await settings.setSkillEnabled("workspace-a", "personal:demo", true);

		assert.equal(await settings.isSkillEnabled("workspace-a", "personal:demo", "personal"), true);
		assert.deepEqual(await settings.getWorkspaceSkillEnablement("workspace-a"), {
			"personal:demo": true
		});

		const settingsPath: string = getSkillSettingsPath();
		const rawConfig: string = await readFile(settingsPath, "utf8");
		assert.equal(rawConfig.endsWith("\n"), true);
		assert.deepEqual((await readdir(join(process.env.USERPROFILE!, ".daedalus", "config"))).sort(), ["skill-settings.json"]);
	});
});
