import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("user prompt store persists one backend prompt with atomic json formatting", async (): Promise<void> => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-user-prompt-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const store = await import(`../src/user-prompt-store.js?case=${Date.now()}-${Math.random()}`);
		const appPaths = await import(`../src/app-paths.js?case=${Date.now()}-${Math.random()}`);

		assert.equal(await store.getUserPrompt(), "");

		const saved = await store.setUserPrompt("  请优先用中文回答。\n\n  ");
		assert.equal(saved.prompt, "请优先用中文回答。");
		assert.equal(await store.getUserPrompt(), "请优先用中文回答。");

		const rawConfig: string = await readFile(appPaths.getUserPromptConfigPath(), "utf8");
		assert.match(rawConfig, /"schemaVersion": 1/u);
		assert.match(rawConfig, /"prompt": "请优先用中文回答。"/u);
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
