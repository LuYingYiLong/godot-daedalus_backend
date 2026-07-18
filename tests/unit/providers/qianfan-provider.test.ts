import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { runOpenAICompatibleAgent } from "../../../src/providers/openai-compatible-agent.js";
import { chatWithOpenAICompatible, streamChatWithOpenAICompatible } from "../../../src/providers/provider-chat-completions-client.js";
import { modelSupportsImageInput } from "../../../src/providers/provider-image-content.js";
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

async function withQianfanMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.url === "/models") {
			assert.equal(request.headers.authorization, "Bearer qianfan-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				data: [
					{ id: "ernie-5.1", owned_by: "baidu", context_length: 131072 },
					{ id: "ernie-5.0", owned_by: "baidu", context_length: 131072 },
					{ id: "ernie-4.5-turbo-vl", owned_by: "baidu", context_length: 131072 },
					{ id: "deepseek-v3", owned_by: "deepseek", context_length: 64000 },
					{ id: "qwen3-235b-a22b", owned_by: "alibaba", context_length: 131072 },
					{ id: "bce-embedding-base_v1", owned_by: "baidu", context_length: 8192 },
					{ id: "unsupported-ocr-model", owned_by: "baidu", context_length: 4096 }
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
		assert.equal(request.headers.authorization, "Bearer qianfan-test-key");

		if (body.stream === true) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			writeSseChunk(response, {
				id: "chatcmpl-qianfan-stream-1",
				object: "chat.completion.chunk",
				created: 1,
				model: "ernie-5.1",
				choices: [{
					index: 0,
					delta: { content: "streamed " },
					finish_reason: null
				}]
			});
			writeSseChunk(response, {
				id: "chatcmpl-qianfan-stream-2",
				object: "chat.completion.chunk",
				created: 1,
				model: "ernie-5.1",
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
				id: "chatcmpl-qianfan-final",
				object: "chat.completion",
				created: 1,
				model: "ernie-5.1",
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

		if (body.model === "ernie-5.0-thinking-latest") {
			response.end(JSON.stringify({
				id: "chatcmpl-qianfan-reasoning",
				object: "chat.completion",
				created: 1,
				model: "ernie-5.0-thinking-latest",
				choices: [{
					index: 0,
					message: {
						role: "assistant",
						reasoning_content: "先判断用户目标。",
						content: "这是千帆文心的回复。"
					},
					finish_reason: "stop"
				}]
			}));
			return;
		}

		if (Array.isArray(body.tools) && body.tools.length > 0) {
			response.end(JSON.stringify({
				id: "chatcmpl-qianfan-tool",
				object: "chat.completion",
				created: 1,
				model: "ernie-5.1",
				choices: [{
					index: 0,
					message: {
						role: "assistant",
						content: "",
						tool_calls: [{
							id: "call-qianfan-lsp",
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
			id: "chatcmpl-qianfan",
			object: "chat.completion",
			created: 1,
			model: "ernie-5.0",
			choices: [{
				index: 0,
				message: { role: "assistant", content: "image understood" },
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
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-qianfan-provider-"));
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

test("Baidu Qianfan OpenAI-compatible requests preserve image input and recommended model listing", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withQianfanMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const text = await chatWithOpenAICompatible({
				message: "Describe this image",
				additionalContext: [{
					id: "image-1",
					kind: "image",
					title: "Scene",
					source: "manual",
					data: {
						mimeType: "image/png",
						dataUrl: "data:image/png;base64,AAAA",
						byteSize: 3
					}
				}]
			}, {
				provider: "qianfan",
				apiKey: "qianfan-test-key",
				baseUrl,
				model: "ernie-5.0"
			}, [], "System prompt");

			assert.equal(text, "image understood");
			assert.deepEqual(requests[0], {
				url: "/chat/completions",
				authorization: "Bearer qianfan-test-key",
				body: {
					model: "ernie-5.0",
					messages: [
						{ role: "system", content: "System prompt" },
						{
							role: "user",
							content: [
								{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
								{ type: "text", text: "Describe this image" }
							]
						}
					]
				}
			});
			assert.equal(await modelSupportsImageInput("qianfan", "ernie-5.0"), true);
			assert.equal(await modelSupportsImageInput("qianfan", "ernie-4.5-turbo-vl"), true);

			const result = await listProviderModels("qianfan", "qianfan-test-key", baseUrl, true);
			assert.equal(result.source, "api");
			assert.equal(result.models.length, 7);
			assert.equal(result.models.find((model): boolean => model.id === "ernie-5.1")?.capabilities.tools, true);
			assert.equal(result.models.find((model): boolean => model.id === "ernie-5.0")?.capabilities.vision, true);
			assert.equal(result.models.find((model): boolean => model.id === "ernie-4.5-turbo-vl")?.capabilities.imageInput, true);
			assert.equal(result.models.some((model): boolean => model.id === "deepseek-v3"), false);
			assert.equal(result.models.some((model): boolean => model.id === "qwen3-235b-a22b"), false);
			assert.equal(result.models.some((model): boolean => model.id === "bce-embedding-base_v1"), false);
			assert.equal(result.models.some((model): boolean => model.id === "unsupported-ocr-model"), false);
		});
	});
});

test("Baidu Qianfan streaming chat reads delta content", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withQianfanMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const chunks: string[] = [];
			for await (const chunk of streamChatWithOpenAICompatible({
				message: "Stream"
			}, {
				provider: "qianfan",
				apiKey: "qianfan-test-key",
				baseUrl,
				model: "ernie-5.1"
			}, [], "System prompt")) {
				chunks.push(chunk);
			}

			assert.equal(chunks.join(""), "streamed response");
			assert.equal(requests[0]?.body.stream, true);
			assert.equal(requests[0]?.authorization, "Bearer qianfan-test-key");
		});
	});
});

test("Baidu Qianfan reasoning_content is emitted through the OpenAI-compatible agent", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withQianfanMockServer(async (baseUrl: string): Promise<void> => {
			const thinking: string[] = [];
			const result = await runOpenAICompatibleAgent(
				{ message: "Say hello" },
				{
					provider: "qianfan",
					apiKey: "qianfan-test-key",
					baseUrl,
					model: "ernie-5.0-thinking-latest"
				},
				[],
				"System prompt",
				createMockMcpHost(),
				new ApprovalGateway(),
				[],
				(event): void => {
					if (event.type === "ai.thinking.delta") {
						thinking.push(event.text);
					}
				}
			);

			assert.deepEqual(thinking, ["先判断用户目标。"]);
			assert.deepEqual(result, {
				status: "completed",
				text: "这是千帆文心的回复。"
			});
		});
	});
});

test("Baidu Qianfan agent tool calls use the OpenAI-compatible tool path", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withQianfanMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const result = await runOpenAICompatibleAgent(
				{ message: "Check LSP status" },
				{
					provider: "qianfan",
					apiKey: "qianfan-test-key",
					baseUrl,
					model: "ernie-5.1"
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
