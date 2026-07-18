import assert from "node:assert/strict";
import test from "node:test";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ResponseFunctionToolCall } from "openai/resources/responses/responses";
import { aiChatParamsSchema, providerIdSchema } from "../src/protocol/schema.js";
import type { AiChatParams, ChatMessage } from "../src/protocol/types.js";
import {
	createOpenAIResponseInput,
	createOpenAIResponsesRequestBody
} from "../src/providers/openai-responses-client.js";
import {
	convertResponsesToolCalls,
	convertToolDefinitions
} from "../src/providers/openai-responses-agent.js";
import { getProviderDefaultBaseUrl, getProviderDefaultModel, getProviderIds } from "../src/providers/provider-registry.js";

test("provider schema and registry include official OpenAI provider", (): void => {
	assert.equal(providerIdSchema.safeParse("openai").success, true);
	assert.equal(providerIdSchema.safeParse("anthropic").success, true);
	assert.equal(providerIdSchema.safeParse("Anthropic").success, false);
	assert.ok(getProviderIds().includes("openai"));
	assert.equal(getProviderDefaultModel("openai"), "gpt-5.5");
	assert.equal(getProviderDefaultBaseUrl("openai"), "https://api.openai.com/v1");
});

test("OpenAI Responses request builder maps instructions, input, stream-safe options, and store false", (): void => {
	const params: AiChatParams = {
		message: "解释这个脚本",
		options: {
			temperature: 0.2,
			topP: 0.9,
			maxTokens: 1234,
			responseFormat: "json"
		}
	};
	const history: ChatMessage[] = [
		{ role: "user", content: "上一轮问题" },
		{ role: "assistant", content: "上一轮回答" }
	];

	const requestBody = createOpenAIResponsesRequestBody(
		params,
		{ provider: "openai", apiKey: "test-key" },
		history,
		"稳定系统指令"
	);

	assert.equal(requestBody.model, "gpt-5.5");
	assert.equal(requestBody.instructions, "稳定系统指令");
	assert.equal(requestBody.store, false);
	assert.equal(requestBody.temperature, 0.2);
	assert.equal(requestBody.top_p, 0.9);
	assert.equal(requestBody.max_output_tokens, 1234);
	assert.deepEqual(requestBody.text, { format: { type: "json_object" } });
	assert.deepEqual(requestBody.input, [
		{ type: "message", role: "user", content: "上一轮问题" },
		{ type: "message", role: "assistant", content: "上一轮回答", phase: "final_answer" },
		{ type: "message", role: "user", content: "解释这个脚本" }
	]);
});

test("OpenAI Responses input builder maps current image context to input_image parts", (): void => {
	const params: AiChatParams = {
		message: "看这张图",
		additionalContext: [{
			id: "image-1",
			kind: "image",
			title: "screenshot",
			source: "manual",
			data: {
				mimeType: "image/png",
				dataUrl: "data:image/png;base64,AAAA",
				byteSize: 3
			}
		}]
	};

	const input = createOpenAIResponseInput(params, []);
	assert.deepEqual(input, [{
		type: "message",
		role: "user",
		content: [
			{ type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
			{ type: "input_text", text: "看这张图" }
		]
	}]);
});

test("OpenAI Responses tools and function calls map to existing tool dispatcher shape", (): void => {
	const chatTool: ChatCompletionTool = {
		type: "function",
		function: {
			name: "godot_read_file",
			description: "Read a file",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string" }
				}
			}
		}
	};
	const responsesTools = convertToolDefinitions([chatTool]);
	assert.deepEqual(responsesTools, [{
		type: "function",
		name: "godot_read_file",
		description: "Read a file",
		parameters: chatTool.function.parameters,
		strict: false
	}]);

	const responsesToolCall: ResponseFunctionToolCall = {
		type: "function_call",
		call_id: "call-1",
		name: "godot_read_file",
		arguments: "{\"path\":\"res://main.gd\"}"
	};
	assert.deepEqual(convertResponsesToolCalls([responsesToolCall], new Set(["godot_read_file"])), [{
		id: "call-1",
		type: "function",
		function: {
			name: "godot_read_file",
			arguments: "{\"path\":\"res://main.gd\"}"
		}
	}]);
	assert.deepEqual(convertResponsesToolCalls([responsesToolCall], new Set(["other_tool"])), []);
});

test("ai.chat schema continues accepting ask mode with OpenAI provider configured separately", (): void => {
	assert.equal(aiChatParamsSchema.safeParse({
		message: "这段代码为什么错？",
		mode: "ask",
		options: {
			workflow: "single",
			stream: true
		}
	}).success, true);
});
