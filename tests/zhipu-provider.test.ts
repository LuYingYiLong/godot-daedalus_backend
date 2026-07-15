import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import keytar from "keytar";
import { runDeepSeekAgent } from "../src/providers/deepseek-agent.js";
import { chatWithOpenAICompatible, streamChatWithOpenAICompatible } from "../src/providers/provider-chat-completions-client.js";
import { fetchOpenAICompatibleModels, listProviderModels } from "../src/providers/provider-models.js";
import { saveProviderConfig } from "../src/providers/provider-config-store.js";
import type { McpHost } from "../src/mcp/mcp-host.js";
import type { AiChatParams } from "../src/protocol/types.js";
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

async function withZhipuMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.url === "/generated.png") {
			response.writeHead(200, { "Content-Type": "image/png" });
			response.end(Buffer.from("zhipu-generated-image", "utf8"));
			return;
		}
		if (request.url === "/models") {
			assert.equal(request.headers.authorization, "Bearer zhipu-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "glm-5.2", owned_by: "zhipu" }] }));
			return;
		}

		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({
			url: request.url ?? "",
			authorization: request.headers.authorization,
			body
		});
		if (request.url === "/images/generations") {
			assert.equal(request.headers.authorization, "Bearer zhipu-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				created: 1,
				data: [{ url: `http://${request.headers.host}/generated.png` }]
			}));
			return;
		}
		assert.equal(request.url, "/chat/completions");
		assert.equal(request.headers.authorization, "Bearer zhipu-test-key");
		if (body.stream === true) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.write("data: {\"id\":\"chatcmpl-zhipu\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"glm-5.2\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"stream\"},\"finish_reason\":null}]}\n\n");
			response.end("data: [DONE]\n\n");
			return;
		}

		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			id: "chatcmpl-zhipu",
			object: "chat.completion",
			created: 1,
			model: "glm-5v-turbo",
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
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-zhipu-image-"));
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

test("Zhipu OpenAI-compatible requests preserve image input, streaming, and model listing", async (): Promise<void> => {
	await withZhipuMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const options = { provider: "zhipu" as const, apiKey: "zhipu-test-key", baseUrl, model: "glm-5v-turbo" };
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
		}, options, [], "System prompt");
		assert.equal(text, "image understood");
		assert.deepEqual(requests[0], {
			url: "/chat/completions",
			authorization: "Bearer zhipu-test-key",
			body: {
				model: "glm-5v-turbo",
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

		const agentParams: AiChatParams = {
			message: "请读取项目中的一个文件。",
			options: {
				stream: false
			}
		};
		(agentParams.options as Record<string, unknown>).requireToolCallOnFirstStep = true;
		const agentResult = await runDeepSeekAgent(
			agentParams,
			{ ...options, model: "glm-5.2" },
			[],
			"System prompt",
			{} as McpHost,
			new ApprovalGateway(),
			["mcp_godot_read_text_file"]
		);
		assert.equal(agentResult.status, "completed");
		assert.equal(requests[1]?.body.tool_choice, "auto");

		const chunks: string[] = [];
		for await (const chunk of streamChatWithOpenAICompatible({ message: "Stream this" }, { ...options, model: "glm-5.2" }, [], "System prompt")) {
			chunks.push(chunk);
		}
		assert.deepEqual(chunks, ["stream"]);
		assert.equal(requests[2]?.body.stream, true);

		const models = await fetchOpenAICompatibleModels({ provider: "zhipu", apiKey: "zhipu-test-key", baseUrl });
		assert.equal(models[0]?.id, "glm-5.2");
		assert.equal(models[0]?.ownedBy, "zhipu");
	});
});

test("Zhipu image generation uses the configured image model and saves a session artifact", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withZhipuMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			mock.method(keytar, "setPassword", async (): Promise<void> => undefined);
			mock.method(keytar, "getPassword", async (_service: string, account: string): Promise<string | null> => {
				return account === "provider:zhipu:api_key" ? "zhipu-test-key" : null;
			});

			await saveProviderConfig({
				provider: "zhipu",
				apiKey: "zhipu-test-key",
				baseUrl,
				model: "glm-5.2",
				modelRouting: {
					imageGeneration: { provider: "zhipu", model: "glm-image" }
				}
			});

			const sessionStore = await import("../src/session/session-store.js");
			const { generateImage } = await import("../src/providers/image-generation.js");
			const session = await sessionStore.createSession("Zhipu image generation");
			const result = await generateImage({
				sessionId: session.id,
				prompt: "生成一张蓝色机器人图标",
				aspectRatio: "16:9"
			});

			const imageRequest = requests.find((request: RecordedRequest): boolean => request.url === "/images/generations");
			assert.equal(imageRequest?.authorization, "Bearer zhipu-test-key");
			assert.deepEqual(imageRequest?.body, {
				model: "glm-image",
				prompt: "生成一张蓝色机器人图标",
				size: "1728x960",
				watermark_enabled: false
			});
			assert.equal(result.provider, "zhipu");
			assert.equal(result.model, "glm-image");
			assert.equal(result.artifacts.length, 1);
			assert.equal(result.artifacts[0]?.byteSize, Buffer.byteLength("zhipu-generated-image"));
			assert.equal(result.artifacts[0]?.storagePath, `attachments/images/${result.artifacts[0]?.imageId}.png`);
			await assert.rejects(
				async (): Promise<void> => {
					await generateImage({
						sessionId: session.id,
						prompt: "把源图改成像素风",
						sourceImages: [{ type: "attachment", id: "image-test" }]
					});
				},
				/Zhipu's official image API does not currently expose/u
			);

			const { executeLlmToolWithIdempotency } = await import("../src/tools/tool-idempotency.js");
			const toolResult = await executeLlmToolWithIdempotency(
				{} as never,
				"mcp_image_generate",
				{ prompt: "生成一张红色机器人图标", aspectRatio: "1:1" },
				undefined,
				undefined,
				session.id
			);
			const toolContent = JSON.parse(toolResult.content) as {
				artifacts: Array<{ imageId: string; localPath: string; storagePath: string }>;
			};
			assert.match(toolContent.artifacts[0]?.localPath ?? "", /attachments[\\/]images[\\/]generated-image-/);
			assert.match(toolContent.artifacts[0]?.storagePath ?? "", /^attachments\/images\/generated-image-/);
		});
	});
});

test("Zhipu provider model list includes local image generation models when API omits them", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withZhipuMockServer(async (baseUrl: string): Promise<void> => {
			const result = await listProviderModels("zhipu", "zhipu-test-key", baseUrl, true);

			assert.equal(result.source, "api");
			assert.equal(result.models.some((model): boolean => model.id === "glm-5.2"), true);
			assert.equal(result.models.find((model): boolean => model.id === "glm-image")?.capabilities.imageGeneration, true);
			assert.equal(result.models.find((model): boolean => model.id === "cogview-4-250304")?.capabilities.imageGeneration, true);
			assert.equal(result.models.find((model): boolean => model.id === "cogview-3-flash")?.capabilities.imageGeneration, true);
		});
	});
});
