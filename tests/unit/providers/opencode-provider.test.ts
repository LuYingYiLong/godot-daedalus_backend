import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { chatWithOpenAICompatible, streamChatWithOpenAICompatible } from "../../../src/providers/provider-chat-completions-client.js";
import { runOpenAICompatibleAgent } from "../../../src/providers/openai-compatible-agent.js";
import { listProviderModels } from "../../../src/providers/provider-models.js";
import { ApprovalGateway } from "../../../src/tools/approval-gateway.js";

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

function writeSseChunk(response: ServerResponse, value: Record<string, unknown>): void {
	response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function createMockMcpHost(): McpHost {
	return {
		getActiveWorkspaceId(): string | undefined {
			return "workspace-1";
		},
		async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
			assert.equal(serverId, "godot_diagnostics");
			assert.equal(toolName, "lsp_get_status");
			assert.deepEqual(args, {});
			return {
				content: [{
					type: "text",
					text: "LSP is available."
				}]
			};
		}
	} as unknown as McpHost;
}

async function withOpenCodeMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.url === "/models") {
			assert.equal(request.headers.authorization, "Bearer opencode-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				data: [
					{ id: "kimi-k2.7-code", owned_by: "opencode", context_length: 256000 },
					{ id: "deepseek-v4-pro", owned_by: "opencode", context_length: 1000000 },
					{ id: "gpt-5.5", owned_by: "opencode", context_length: 400000 },
					{ id: "claude-sonnet-5", owned_by: "opencode", context_length: 200000 },
					{ id: "gemini-3.5-flash", owned_by: "opencode", context_length: 1000000 },
					{ id: "unsupported-extra-model", owned_by: "opencode", context_length: 8192 }
				]
			}));
			return;
		}

		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({
			url: request.url ?? "",
			authorization: request.headers.authorization,
			body
		});

		assert.equal(request.url, "/chat/completions");
		assert.equal(request.headers.authorization, "Bearer opencode-test-key");

		if (body.stream === true) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			writeSseChunk(response, {
				id: "chatcmpl-opencode-stream-1",
				object: "chat.completion.chunk",
				created: 1,
				model: "kimi-k2.7-code",
				choices: [{
					index: 0,
					delta: { content: "streamed " },
					finish_reason: null
				}]
			});
			writeSseChunk(response, {
				id: "chatcmpl-opencode-stream-2",
				object: "chat.completion.chunk",
				created: 1,
				model: "kimi-k2.7-code",
				choices: [{
					index: 0,
					delta: { content: "response" },
					finish_reason: null
				}]
			});
			response.end("data: [DONE]\n\n");
			return;
		}

		response.writeHead(200, { "Content-Type": "application/json" });
		if (JSON.stringify(body.messages).includes("tool_call_id")) {
			response.end(JSON.stringify({
				id: "chatcmpl-opencode-final",
				object: "chat.completion",
				created: 1,
				model: "kimi-k2.7-code",
				choices: [{
					index: 0,
					message: {
						role: "assistant",
						content: "LSP status checked."
					},
					finish_reason: "stop"
				}]
			}));
			return;
		}

		if (Array.isArray(body.tools)) {
			response.end(JSON.stringify({
				id: "chatcmpl-opencode-tool",
				object: "chat.completion",
				created: 1,
				model: "kimi-k2.7-code",
				choices: [{
					index: 0,
					message: {
						role: "assistant",
						content: "",
						tool_calls: [{
							id: "call-opencode-lsp",
							type: "function",
							function: {
								name: "mcp_godot_lsp_get_status",
								arguments: "{}"
							}
						}]
					},
					finish_reason: "tool_calls"
				}]
			}));
			return;
		}

		response.end(JSON.stringify({
			id: "chatcmpl-opencode",
			object: "chat.completion",
			created: 1,
			model: "kimi-k2.7-code",
			choices: [{
				index: 0,
				message: { role: "assistant", content: "OpenCode Zen response." },
				finish_reason: "stop"
			}]
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
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-opencode-provider-"));
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

test("OpenCode Zen OpenAI-compatible chat uses bearer auth", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withOpenCodeMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const text = await chatWithOpenAICompatible({
				message: "Hello"
			}, {
				provider: "opencode",
				apiKey: "opencode-test-key",
				baseUrl,
				model: "kimi-k2.7-code"
			}, [], "System prompt");

			assert.equal(text, "OpenCode Zen response.");
			assert.deepEqual(requests[0], {
				url: "/chat/completions",
				authorization: "Bearer opencode-test-key",
				body: {
					model: "kimi-k2.7-code",
					messages: [
						{ role: "system", content: "System prompt" },
						{ role: "user", content: "Hello" }
					]
				}
			});
		});
	});
});

test("OpenCode Zen streaming chat reads delta content", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withOpenCodeMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const chunks: string[] = [];
			for await (const chunk of streamChatWithOpenAICompatible({
				message: "Stream"
			}, {
				provider: "opencode",
				apiKey: "opencode-test-key",
				baseUrl,
				model: "kimi-k2.7-code"
			}, [], "System prompt")) {
				chunks.push(chunk);
			}

			assert.equal(chunks.join(""), "streamed response");
			assert.equal(requests[0]?.body.stream, true);
			assert.equal(requests[0]?.authorization, "Bearer opencode-test-key");
		});
	});
});

test("OpenCode Zen model refresh keeps only supported recommended chat-completions models", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withOpenCodeMockServer(async (baseUrl: string): Promise<void> => {
			const result = await listProviderModels("opencode", "opencode-test-key", baseUrl, true);

			assert.equal(result.source, "api");
			assert.equal(result.models.length, 6);
			assert.equal(result.models.find((model): boolean => model.id === "kimi-k2.7-code")?.capabilities.tools, true);
			assert.equal(result.models.find((model): boolean => model.id === "deepseek-v4-pro")?.contextWindowTokens, 1_000_000);
			assert.equal(result.models.find((model): boolean => model.id === "grok-4.5")?.capabilities.reasoning, true);
			assert.equal(result.models.some((model): boolean => model.id === "gpt-5.5"), false);
			assert.equal(result.models.some((model): boolean => model.id === "claude-sonnet-5"), false);
			assert.equal(result.models.some((model): boolean => model.id === "gemini-3.5-flash"), false);
			assert.equal(result.models.some((model): boolean => model.id === "unsupported-extra-model"), false);
		});
	});
});

test("OpenCode Zen agent tool calls use the OpenAI-compatible tool path", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withOpenCodeMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const result = await runOpenAICompatibleAgent(
				{ message: "Check LSP status" },
				{
					provider: "opencode",
					apiKey: "opencode-test-key",
					baseUrl,
					model: "kimi-k2.7-code"
				},
				[],
				"System prompt",
				createMockMcpHost(),
				new ApprovalGateway(),
				["mcp_godot_lsp_get_status"]
			);

			assert.deepEqual(result, {
				status: "completed",
				text: "LSP status checked."
			});
			assert.equal(requests.length, 2);
			const firstTools = requests[0]?.body.tools as Array<{ function?: { name?: string } }> | undefined;
			assert.equal(firstTools?.[0]?.function?.name, "mcp_godot_lsp_get_status");
			assert.match(JSON.stringify(requests[1]?.body.messages), /tool_call_id/u);
			assert.match(JSON.stringify(requests[1]?.body.messages), /mcp_godot_lsp_get_status/u);
		});
	});
});
