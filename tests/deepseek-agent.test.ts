import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { createToolProtocolCorrectionMessage, resolveRequiredToolChoice, runDeepSeekAgentStreaming, shouldDisableThinkingForToolCalls, shouldSkipRequiredToolChoice } from "../src/providers/deepseek-agent.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { McpHost } from "../src/mcp/mcp-host.js";
import type { AiChatParams } from "../src/protocol/types.js";
import { ApprovalGateway } from "../src/tools/approval-gateway.js";

type RecordedRequest = {
	url: string;
	body: Record<string, unknown>;
};

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let text: string = "";
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
			return undefined;
		},
		async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
			assert.equal(serverId, "godot");
			assert.equal(toolName, "read_text_file");
			assert.equal(args.relativePath, "tic_tac_toe_game.gd");
			return {
				content: [{
					type: "text",
					text: "extends Node\nfunc reset_game() -> void:\n\tpass\n"
				}]
			};
		}
	} as unknown as McpHost;
}

async function withStreamingAgentMockServer(run: (baseUrl: string, requests: RecordedRequest[]) => Promise<void>): Promise<void> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const body: Record<string, unknown> = await readRequestBody(request);
		requests.push({ url: request.url ?? "", body });
		assert.equal(request.url, "/chat/completions");

		if (requests.length === 1) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			writeSseChunk(response, {
				id: "chatcmpl-tool",
				object: "chat.completion.chunk",
				created: 1,
				model: "glm-5.2",
				choices: [{
					index: 0,
					delta: {
						tool_calls: [{
							index: 0,
							id: "call-read",
							type: "function",
							function: {
								name: "mcp_godot_read_text_file",
								arguments: "{\"relativePath\":\"tic_tac_toe_game.gd\"}"
							}
						}]
					},
					finish_reason: null
				}]
			});
			response.end("data: [DONE]\n\n");
			return;
		}

		if (requests.length === 2) {
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			writeSseChunk(response, {
				id: "chatcmpl-thinking-only",
				object: "chat.completion.chunk",
				created: 1,
				model: "glm-5.2",
				choices: [{
					index: 0,
					delta: {
						reasoning_content: "已经读取文件，但这次模型只返回了思考内容。"
					},
					finish_reason: null
				}]
			});
			response.end("data: [DONE]\n\n");
			return;
		}

		response.writeHead(200, { "Content-Type": "application/json" });
		response.end(JSON.stringify({
			id: "chatcmpl-final",
			object: "chat.completion",
			created: 1,
			model: "glm-5.2",
			choices: [{
				index: 0,
				message: { role: "assistant", content: "tic_tac_toe_game.gd 的逻辑入口是 reset_game。" },
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

test("DeepSeek V4 thinking models skip required tool_choice", (): void => {
	const tools: ChatCompletionTool[] = [{
		type: "function",
		function: {
			name: "mcp_godot_create_scene",
			description: "Create a scene",
			parameters: {
				type: "object",
				properties: {}
			}
		}
	}];
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}), true);
	assert.equal(shouldDisableThinkingForToolCalls({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}, tools), true);
	assert.equal(shouldDisableThinkingForToolCalls({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}, []), false);
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-flash"
	}), true);
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-chat"
	}), false);
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "moonshot",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}), true);
	assert.equal(shouldDisableThinkingForToolCalls({
		provider: "moonshot",
		apiKey: "test-key",
		model: "kimi-k2.7-code"
	}, tools), false);
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "zhipu",
		apiKey: "test-key",
		model: "glm-5.2"
	}), false);
	assert.equal(resolveRequiredToolChoice({
		provider: "zhipu",
		apiKey: "test-key",
		model: "glm-5.2"
	}), "auto");
});

test("tool protocol correction prompt distinguishes tool and no-tool phases", (): void => {
	const toolPrompt: string = createToolProtocolCorrectionMessage(["mcp_godot_read_text_file"]);
	assert.match(toolPrompt, /tool_calls/);
	assert.match(toolPrompt, /mcp_godot_read_text_file/);
	assert.match(toolPrompt, /不要再输出 <Tool>/);

	const noToolPrompt: string = createToolProtocolCorrectionMessage([]);
	assert.match(noToolPrompt, /当前阶段没有可用工具/);
	assert.match(noToolPrompt, /自然语言结果/);
});

test("streaming agent finalizes when tool follow-up only returns reasoning content", async (): Promise<void> => {
	await withStreamingAgentMockServer(async (baseUrl: string, requests: RecordedRequest[]): Promise<void> => {
		const events: string[] = [];
		const params: AiChatParams = {
			message: "解读一下 tic_tac_toe_game.gd",
			options: {
				stream: true
			}
		};
		(params.options as Record<string, unknown>).requireToolCallOnFirstStep = true;

		const result = await runDeepSeekAgentStreaming(
			params,
			{ provider: "zhipu", apiKey: "test-key", baseUrl, model: "glm-5.2" },
			[],
			"System prompt",
			createMockMcpHost(),
			new ApprovalGateway(),
			["mcp_godot_read_text_file"],
			(event): void => {
				if (event.type === "ai.delta") {
					events.push(event.text);
				}
			}
		);

		assert.equal(result.status, "completed");
		assert.equal(result.text, "tic_tac_toe_game.gd 的逻辑入口是 reset_game。");
		assert.deepEqual(events, ["tic_tac_toe_game.gd 的逻辑入口是 reset_game。"]);
		assert.equal(requests.length, 3);
		assert.equal(requests[0]?.body.stream, true);
		assert.equal(requests[1]?.body.stream, true);
		assert.equal(requests[2]?.body.stream, undefined);
		assert.match(JSON.stringify(requests[2]?.body.messages), /只返回了 thinking\/reasoning_content/);
	});
});
