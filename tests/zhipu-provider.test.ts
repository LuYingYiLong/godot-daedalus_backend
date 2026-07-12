import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { runDeepSeekAgent } from "../src/providers/deepseek-agent.js";
import { chatWithOpenAICompatible, streamChatWithOpenAICompatible } from "../src/providers/provider-chat-completions-client.js";
import { fetchOpenAICompatibleModels } from "../src/providers/provider-models.js";
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
