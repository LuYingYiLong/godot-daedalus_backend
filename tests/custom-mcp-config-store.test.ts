import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import keytar from "keytar";
import { getMcpServersConfigPath } from "../src/app-paths.js";
import {
	addCustomMcpServerConfig,
	buildCustomMcpServerConfigs,
	listStoredCustomMcpServerConfigs,
	updateCustomMcpServerConfig
} from "../src/mcp/custom-mcp-config-store.js";
import type { McpServerConfig } from "../src/mcp/types.js";
import type { WorkspaceConfig } from "../src/workspace/types.js";

async function withTempAppData(run: (secrets: Map<string, string>) => Promise<void>): Promise<void> {
	const previousAppData: string | undefined = process.env.APPDATA;
	const appDataDir: string = await mkdtemp(join(tmpdir(), "daedalus-custom-mcp-"));
	const secrets: Map<string, string> = new Map();
	process.env.APPDATA = appDataDir;
	mock.method(keytar, "setPassword", async (_service: string, account: string, password: string): Promise<void> => {
		secrets.set(account, password);
	});
	mock.method(keytar, "getPassword", async (_service: string, account: string): Promise<string | null> => {
		return secrets.get(account) ?? null;
	});
	mock.method(keytar, "deletePassword", async (_service: string, account: string): Promise<boolean> => {
		secrets.delete(account);
		return true;
	});

	try {
		await run(secrets);
	} finally {
		if (previousAppData === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = previousAppData;
		}
		mock.restoreAll();
		await rm(appDataDir, { recursive: true, force: true });
	}
}

test("custom MCP config update preserves identity and applies secret update semantics", async (): Promise<void> => {
	await withTempAppData(async (secrets: Map<string, string>): Promise<void> => {
		const added = await addCustomMcpServerConfig({
			name: "Demo Tools",
			description: "Original",
			transport: "stdio",
			command: "npx",
			args: ["-y", "old-mcp"],
			env: {
				TOKEN: "old-token",
				DROP_ME: "drop-token"
			}
		});
		const serverId: string = added.id;
		const createdAt: string = added.createdAt;

		const updated = await updateCustomMcpServerConfig({
			serverId,
			description: "Updated",
			transport: "stdio",
			enabled: false,
			command: "uvx",
			args: ["new-mcp"],
			env: {
				TOKEN: "",
				NEW_TOKEN: "new-token"
			}
		});

		assert.notEqual(updated, null);
		assert.equal(updated?.id, serverId);
		assert.equal(updated?.name, "Demo Tools");
		assert.equal(updated?.createdAt, createdAt);
		assert.equal(updated?.description, "Updated");
		assert.equal(updated?.enabled, false);
		assert.equal(updated?.command, "uvx");
		assert.deepEqual(updated?.args, ["new-mcp"]);
		assert.deepEqual(updated?.envNames, ["NEW_TOKEN", "TOKEN"]);
		assert.equal(secrets.get(`mcp:${serverId}:env:TOKEN`), "old-token");
		assert.equal(secrets.get(`mcp:${serverId}:env:NEW_TOKEN`), "new-token");
		assert.equal(secrets.has(`mcp:${serverId}:env:DROP_ME`), false);

		await assert.rejects(
			updateCustomMcpServerConfig({
				serverId,
				transport: "stdio",
				command: "uvx",
				env: {
					NEW_BLANK: ""
				}
			}),
			/Secret value is required for new env: NEW_BLANK/
		);
		assert.equal(secrets.get(`mcp:${serverId}:env:TOKEN`), "old-token");

		const workspace: WorkspaceConfig = {
			id: "workspace-a",
			name: "Workspace A",
			kind: "godot",
			rootPath: "D:/Projects/Game"
		};
		const configs: McpServerConfig[] = await buildCustomMcpServerConfigs(workspace);
		assert.equal(configs.length, 0, "disabled custom MCP is not launched");

		const rawConfig: string = await readFile(getMcpServersConfigPath(), "utf8");
		assert.doesNotMatch(rawConfig, /old-token|new-token|drop-token/);

		const stored = await listStoredCustomMcpServerConfigs();
		assert.equal(stored[0]?.id, serverId);
		assert.equal(stored[0]?.name, "Demo Tools");
	});
});

test("custom MCP config update can switch transports and preserve existing header secrets", async (): Promise<void> => {
	await withTempAppData(async (secrets: Map<string, string>): Promise<void> => {
		const added = await addCustomMcpServerConfig({
			name: "HTTP Tools",
			transport: "stdio",
			command: "npx",
			env: {
				TOKEN: "old-token"
			}
		});
		const serverId: string = added.id;

		const switched = await updateCustomMcpServerConfig({
			serverId,
			transport: "http",
			enabled: true,
			url: "https://example.com/mcp",
			headers: {
				Authorization: "Bearer first"
			}
		});
		assert.equal(switched?.transport, "http");
		assert.equal(switched?.url, "https://example.com/mcp");
		assert.deepEqual(switched?.headerNames, ["Authorization"]);
		assert.equal(secrets.has(`mcp:${serverId}:env:TOKEN`), false);
		assert.equal(secrets.get(`mcp:${serverId}:header:Authorization`), "Bearer first");

		const preserved = await updateCustomMcpServerConfig({
			serverId,
			transport: "http",
			url: "https://example.com/next",
			headers: {
				Authorization: ""
			}
		});
		assert.equal(preserved?.url, "https://example.com/next");
		assert.deepEqual(preserved?.headerNames, ["Authorization"]);
		assert.equal(secrets.get(`mcp:${serverId}:header:Authorization`), "Bearer first");
	});
});
