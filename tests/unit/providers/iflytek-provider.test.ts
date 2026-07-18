import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import type { McpHost } from "../src/mcp/mcp-host.js";
import { chatWithOpenAICompatible } from "../src/providers/provider-chat-completions-client.js";
import { runOpenAICompatibleAgent } from "../src/providers/openai-compatible-agent.js";
import { listProviderModels } from "../src/providers/provider-models.js";
import { ApprovalGateway } from "../src/tools/approval-gateway.js";

type RecordedRequest = {
	url: string;
	authorization: string | undefined;
	body: Record<string, unknown>;
};

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	for await (const chunk of request) {
		text += String(chunk);
	}
	return JSON.parse(text) as Record<string, unknown>;
}

function createMockMcpHost(): McpHost {
	return {
		getActiveWorkspaceId(): string | undefined {
			return "workspace-1";
		},
		async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
			assert.equal(serverId, "godot_diagnostics");
			assert.equal(toolName, "lsp_get_file_diagnostics");
			assert.deepEqual(args, { resourcePath: "res://player.gd" });
			return {
				content: [{
					type: "text",
					text: "No diagnostics."
				}]
			};
		}
	} as unknown as McpHost;
}

async function withIFlytekMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.url === "/models") {
			response.writeHead(500, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: "iflytek catalog-only test should not request models" }));
			return;
		}

		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({
			url: request.url ?? "",
			authorization: request.headers.authorization,
			body
		});

		assert.equal(request.url, "/chat/completions");
		assert.equal(request.headers.authorization, "Bearer iflytek-api-password");
		response.writeHead(200, { "Content-Type": "application/json" });

		if (JSON.stringify(body.messages).includes("tool_call_id")) {
			response.end(JSON.stringify({
				code: 0,
				message: "Success",
				sid: "cha-iflytek-final",
				choices: [{
					index: 0,
					message: {
						role: "assistant",
						content: "诊断已读取，没有发现问题。"
					}
				}],
				usage: {
					prompt_tokens: 20,
					completion_tokens: 8,
					total_tokens: 28
				}
			}));
			return;
		}

		if (Array.isArray(body.tools)) {
			response.end(JSON.stringify({
				code: 0,
				message: "Success",
				sid: "cha-iflytek-tool",
				choices: [{
					index: 0,
					message: {
						role: "assistant",
						content: "",
						tool_calls: [{
							id: "Call_iflytek_1",
							type: "function",
							function: {
								name: "lsp_get_file_diagnostics",
								arguments: "{\"resourcePath\":\"res://player.gd\"}"
							}
						}]
					}
				}],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 6,
					total_tokens: 16
				}
			}));
			return;
		}

		response.end(JSON.stringify({
			code: 0,
			message: "Success",
			sid: "cha-iflytek-text",
			choices: [{
				index: 0,
				message: {
					role: "assistant",
					content: "你好，我是讯飞星火。"
				}
			}],
			usage: {
				prompt_tokens: 5,
				completion_tokens: 7,
				total_tokens: 12
			}
		}));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Mock server did not expose a TCP port");
	}

	try {
		await run(`http://127.0.0.1:${address.port}`, requests);
	} finally {
		server.close();
		await once(server, "close");
	}
}

async function withTempAppData(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-iflytek-provider-"));
	try {
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		mock.restoreAll();
	}
}

test("iFlytek Spark OpenAI-compatible chat uses APIPassword bearer auth", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withIFlytekMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const text = await chatWithOpenAICompatible({
				message: "你好"
			}, {
				provider: "iflytek",
				apiKey: "iflytek-api-password",
				baseUrl,
				model: "4.0Ultra"
			}, [], "System prompt");

			assert.equal(text, "你好，我是讯飞星火。");
			assert.deepEqual(requests[0], {
				url: "/chat/completions",
				authorization: "Bearer iflytek-api-password",
				body: {
					model: "4.0Ultra",
					messages: [
						{ role: "system", content: "System prompt" },
						{ role: "user", content: "你好" }
					]
				}
			});
		});
	});
});

test("iFlytek Spark model list is catalog-only even when refresh is requested", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withIFlytekMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const result = await listProviderModels("iflytek", "iflytek-api-password", baseUrl, true);

			assert.equal(result.source, "fallback");
			assert.equal(result.stale, false);
			assert.equal(result.models.length, 4);
			assert.equal(result.models.find((model): boolean => model.id === "4.0Ultra")?.capabilities.tools, true);
			assert.equal(requests.length, 0);
		});
	});
});

test("iFlytek Spark tool requests enable tool_calls_switch and map long tool names through aliases", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withIFlytekMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const result = await runOpenAICompatibleAgent(
				{ message: "检查脚本诊断" },
				{
					provider: "iflytek",
					apiKey: "iflytek-api-password",
					baseUrl,
					model: "4.0Ultra"
				},
				[],
				"System prompt",
				createMockMcpHost(),
				new ApprovalGateway(),
				["mcp_godot_lsp_get_file_diagnostics"]
			);

			assert.deepEqual(result, {
				status: "completed",
				text: "诊断已读取，没有发现问题。"
			});
			assert.equal(requests.length, 2);
			assert.equal(requests[0]?.body.tool_calls_switch, true);
			const firstTools = requests[0]?.body.tools as Array<{ function?: { name?: string; description?: string } }> | undefined;
			assert.equal(firstTools?.[0]?.function?.name, "lsp_get_file_diagnostics");
			assert.match(firstTools?.[0]?.function?.description ?? "", /Original tool name: mcp_godot_lsp_get_file_diagnostics/u);
			assert.match(JSON.stringify(requests[1]?.body.messages), /lsp_get_file_diagnostics/u);
			assert.doesNotMatch(JSON.stringify(requests[1]?.body.messages), /mcp_godot_lsp_get_file_diagnostics/u);
		});
	});
});
