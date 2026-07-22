import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import keytar from "keytar";

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-web-search-settings-"));
	process.env.USERPROFILE = appDataDir;
	try {
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		mock.restoreAll();
		await rm(appDataDir, { recursive: true, force: true });
	}
}

test("web search settings expose supported catalog models", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		mock.method(keytar, "getPassword", async (): Promise<string | null> => null);
		const store = await import(`../../../src/web-search-settings-store.js?case=${Date.now()}-${Math.random()}`);

		const status = await store.getWebSearchSettingsStatus();

		assert.equal(status.provider, "zhipu");
		assert.equal(status.model, "glm-5.2");
		assert.equal(status.enabled, false);
		assert.equal(status.maxResults, 5);
		assert.equal(status.available, false);
		assert.equal(status.configured, false);
		assert.equal(status.models.length, 1);
		assert.equal(status.models[0]?.provider, "zhipu");
		assert.equal(status.models[0]?.model, "glm-5.2");
	});
});

test("web search settings persist search model and report configured availability", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		mock.method(keytar, "getPassword", async (_service: string, account: string): Promise<string | null> => {
			return account === "provider:zhipu:api_key" ? "zhipu-test-key" : null;
		});
		const store = await import(`../../../src/web-search-settings-store.js?case=${Date.now()}-${Math.random()}`);
		const appPaths = await import(`../../../src/app-paths.js?case=${Date.now()}-${Math.random()}`);

		const saved = await store.updateWebSearchSettings({
			enabled: true,
			provider: "zhipu",
			model: "glm-5.2",
			maxResults: 20
		});

		assert.equal(saved.available, true);
		assert.equal(saved.enabled, true);
		assert.equal(saved.configured, true);
		assert.equal(saved.maxResults, 20);
		assert.equal(saved.apiKeyMasked, "zhi...-key");
		const rawConfig: string = await readFile(appPaths.getWebSearchSettingsConfigPath(), "utf8");
		assert.match(rawConfig, /"enabled": true/u);
		assert.match(rawConfig, /"provider": "zhipu"/u);
		assert.match(rawConfig, /"model": "glm-5\.2"/u);
		assert.match(rawConfig, /"maxResults": 20/u);
	});
});

test("web search settings disable runtime config until globally enabled", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		mock.method(keytar, "getPassword", async (_service: string, account: string): Promise<string | null> => {
			return account === "provider:zhipu:api_key" ? "zhipu-test-key" : null;
		});
		const store = await import(`../../../src/web-search-settings-store.js?case=${Date.now()}-${Math.random()}`);

		assert.equal(await store.resolveWebSearchRuntimeConfig(), null);

		await store.updateWebSearchSettings({ enabled: true });

		const runtimeConfig = await store.resolveWebSearchRuntimeConfig();
		assert.equal(runtimeConfig?.provider, "zhipu");
		assert.equal(runtimeConfig?.model, "glm-5.2");
	});
});

test("web search settings clamp persisted search result count", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		mock.method(keytar, "getPassword", async (): Promise<string | null> => null);
		const store = await import(`../../../src/web-search-settings-store.js?case=${Date.now()}-${Math.random()}`);

		assert.equal((await store.updateWebSearchSettings({ maxResults: -1 })).maxResults, 0);
		assert.equal((await store.updateWebSearchSettings({ maxResults: 101 })).maxResults, 100);
		assert.equal((await store.updateWebSearchSettings({ maxResults: 12.8 })).maxResults, 12);
	});
});

test("web search settings reject unsupported providers and models", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		mock.method(keytar, "getPassword", async (): Promise<string | null> => null);
		const store = await import(`../../../src/web-search-settings-store.js?case=${Date.now()}-${Math.random()}`);

		await assert.rejects(
			async (): Promise<void> => {
				await store.updateWebSearchSettings({ provider: "openai", model: "gpt-5.5" });
			},
			/Provider does not support Daedalus web search/u
		);

		await assert.rejects(
			async (): Promise<void> => {
				await store.updateWebSearchSettings({ provider: "zhipu", model: "glm-image" });
			},
			/Model does not support Daedalus web search/u
		);
	});
});
