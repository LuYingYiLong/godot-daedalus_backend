import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { mock } from "node:test";
import keytar from "keytar";
import { getProviderConfigStatus, loadProviderConfigWithSecret, saveProviderConfig } from "../src/providers/provider-config-store.js";
import { resolveProviderTaskModelOptions } from "../src/providers/task-model-routing.js";

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousAppData: string | undefined = process.env.APPDATA;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-provider-config-"));
	process.env.APPDATA = appDataDir;
	try {
		await run();
	} finally {
		if (previousAppData === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = previousAppData;
		}
		mock.restoreAll();
	}
}

test("provider config ignores legacy single-provider file and legacy keytar account", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const configDir: string = join(process.env.APPDATA!, ".godot_daedalus", "config");
		await mkdir(configDir, { recursive: true });
		await writeFile(join(configDir, "provider.json"), JSON.stringify({
			provider: "deepseek",
			model: "deepseek-v4-pro",
			baseUrl: "https://legacy.deepseek.example",
			keyStorage: "keytar",
			updatedAt: "2026-07-01T00:00:00.000Z"
		}), "utf8");

		const requestedAccounts: string[] = [];
		mock.method(keytar, "getPassword", async (_service: string, account: string): Promise<string | null> => {
			requestedAccounts.push(account);
			return account === "deepseek_api_key" ? "legacy-key" : null;
		});

		const config = await loadProviderConfigWithSecret();
		const status = await getProviderConfigStatus();

		assert.equal(config, null);
		assert.equal(status.configured, false);
		assert.equal(status.model, null);
		assert.deepEqual(status.modelRouting, {
			imageRecognition: null,
			workflowPlanner: null,
			sessionTitle: null
		});
		assert.equal(requestedAccounts.includes("deepseek_api_key"), false);
		assert.equal(requestedAccounts.includes("provider:deepseek:api_key"), true);
	});
});

test("provider config saves keys under provider-scoped keytar accounts", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		const savedAccounts: string[] = [];
		mock.method(keytar, "setPassword", async (_service: string, account: string, _password: string): Promise<void> => {
			savedAccounts.push(account);
		});
		mock.method(keytar, "getPassword", async (): Promise<string | null> => null);

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "new-key",
			model: "deepseek-v4-flash"
		});

		assert.deepEqual(savedAccounts, ["provider:deepseek:api_key"]);
	});
});

test("provider config persists cross-provider task model routing", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		mock.method(keytar, "setPassword", async (): Promise<void> => undefined);
		mock.method(keytar, "getPassword", async (_service: string, account: string): Promise<string | null> => {
			return account === "provider:moonshot:api_key" ? "moonshot-key" : "deepseek-key";
		});

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash",
			modelRouting: {
				imageRecognition: { provider: "moonshot", model: "kimi-k2.6" },
				workflowPlanner: { provider: "deepseek", model: "deepseek-v4-pro" },
				sessionTitle: null
			}
		});

		const status = await getProviderConfigStatus();
		assert.deepEqual(status.modelRouting, {
			imageRecognition: { provider: "moonshot", model: "kimi-k2.6" },
			workflowPlanner: { provider: "deepseek", model: "deepseek-v4-pro" },
			sessionTitle: null
		});
	});
});

test("provider config saves and clears custom request base url", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		mock.method(keytar, "setPassword", async (): Promise<void> => undefined);
		mock.method(keytar, "getPassword", async (): Promise<string | null> => "deepseek-key");

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash",
			baseUrl: "https://proxy.example/v1"
		});

		let status = await getProviderConfigStatus();
		assert.equal(status.baseUrl, "https://proxy.example/v1");
		assert.equal(status.providers.find((item) => item.provider === "deepseek")?.baseUrl, "https://proxy.example/v1");

		await saveProviderConfig({
			provider: "deepseek",
			baseUrl: null
		});

		status = await getProviderConfigStatus();
		assert.equal(status.baseUrl, null);
		assert.equal(status.providers.find((item) => item.provider === "deepseek")?.baseUrl, null);
	});
});

test("task model resolver falls back to current model or resolves configured provider secrets", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		mock.method(keytar, "setPassword", async (): Promise<void> => undefined);
		mock.method(keytar, "getPassword", async (_service: string, account: string): Promise<string | null> => {
			if (account === "provider:moonshot:api_key") {
				return "moonshot-key";
			}
			if (account === "provider:deepseek:api_key") {
				return "deepseek-key";
			}
			return null;
		});

		await saveProviderConfig({
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash",
			modelRouting: {
				imageRecognition: { provider: "moonshot", model: "kimi-k2.6" }
			}
		});

		const imageModel = await resolveProviderTaskModelOptions("imageRecognition", {
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash"
		});
		assert.equal(imageModel.source, "configured");
		assert.equal(imageModel.provider, "moonshot");
		assert.equal(imageModel.model, "kimi-k2.6");
		assert.equal(imageModel.options.apiKey, "moonshot-key");

		const titleModel = await resolveProviderTaskModelOptions("sessionTitle", {
			provider: "deepseek",
			apiKey: "deepseek-key",
			model: "deepseek-v4-flash"
		});
		assert.equal(titleModel.source, "current");
		assert.equal(titleModel.provider, "deepseek");
		assert.equal(titleModel.model, "deepseek-v4-flash");
	});
});
