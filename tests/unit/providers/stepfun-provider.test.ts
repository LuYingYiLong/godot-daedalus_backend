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
import { modelSupportsImageInput } from "../src/providers/provider-image-content.js";
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
			return undefined;
		}
	} as unknown as McpHost;
}

async function withStepFunMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (request.url === "/models") {
			assert.equal(request.headers.authorization, "Bearer stepfun-test-key");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				data: [
					{ id: "step-3.7-flash", owned_by: "stepfun", context_length: 256000 },
					{ id: "step-legacy-unrecommended", owned_by: "stepfun", context_length: 8192 }
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
		assert.equal(request.headers.authorization, "Bearer stepfun-test-key");
		response.writeHead(200, { "Content-Type": "application/json" });
		if (body.model === "step-3.5-flash") {
			response.end(JSON.stringify({
				id: "chatcmpl-stepfun-reasoning",
				object: "chat.completion",
				created: 1,
				model: "step-3.5-flash",
				choices: [{
					index: 0,
					message: {
						role: "assistant",
						reasoning_content: "先确认输入意图。",
						content: "这是 StepFun 的普通回复。"
					},
					finish_reason: "stop"
				}]
			}));
			return;
		}

		response.end(JSON.stringify({
			id: "chatcmpl-stepfun",
			object: "chat.completion",
			created: 1,
			model: "step-3.7-flash",
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
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-stepfun-provider-"));
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

test("StepFun OpenAI-compatible requests preserve image input and recommended model listing", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withStepFunMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
			const options = {
				provider: "stepfun" as const,
				apiKey: "stepfun-test-key",
				baseUrl,
				model: "step-3.7-flash"
			};
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
				authorization: "Bearer stepfun-test-key",
				body: {
					model: "step-3.7-flash",
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
			assert.equal(await modelSupportsImageInput("stepfun", "step-3.7-flash"), true);

			const result = await listProviderModels("stepfun", "stepfun-test-key", baseUrl, true);
			assert.equal(result.source, "api");
			assert.equal(result.models.length, 3);
			assert.equal(result.models.find((model): boolean => model.id === "step-3.7-flash")?.capabilities.imageInput, true);
			assert.equal(result.models.find((model): boolean => model.id === "step-3.7-flash")?.capabilities.vision, true);
			assert.equal(result.models.find((model): boolean => model.id === "step-3.5-flash")?.capabilities.tools, true);
			assert.equal(result.models.some((model): boolean => model.id === "step-legacy-unrecommended"), false);
		});
	});
});

test("StepFun reasoning_content is emitted through the OpenAI-compatible agent", async (): Promise<void> => {
	await withTempAppData(async (): Promise<void> => {
		await withStepFunMockServer(async (baseUrl: string): Promise<void> => {
			const thinking: string[] = [];
			const result = await runOpenAICompatibleAgent(
				{ message: "Say hello" },
				{
					provider: "stepfun",
					apiKey: "stepfun-test-key",
					baseUrl,
					model: "step-3.5-flash"
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

			assert.deepEqual(thinking, ["先确认输入意图。"]);
			assert.deepEqual(result, {
				status: "completed",
				text: "这是 StepFun 的普通回复。"
			});
		});
	});
});
