import assert from "node:assert/strict";
import test from "node:test";
import type { ChatCompletionCreateParamsBase } from "openai/resources/chat/completions";
import { applyChatOptions } from "../src/providers/deepseek-client.js";
import { estimateProviderMessagesTokens, estimateProviderTextTokens } from "../src/providers/provider-token-estimator.js";
import { resolveModelProfile } from "../src/tokens/model-profiles.js";

test("moonshot token estimator reads data.total_tokens", async (): Promise<void> => {
	const originalFetch: typeof fetch = globalThis.fetch;
	let requestedUrl: string = "";
	let requestedBody: unknown;

	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		requestedUrl = String(input);
		requestedBody = JSON.parse(String(init?.body ?? "{}")) as unknown;
		return new Response(JSON.stringify({ data: { total_tokens: 80 } }), {
			status: 200,
			headers: { "Content-Type": "application/json" }
		});
	}) as typeof fetch;

	try {
		const tokens: number | null = await estimateProviderTextTokens({
			provider: "moonshot",
			apiKey: "test-key",
			model: "kimi-k2.7-code"
		}, "你好");

		assert.equal(tokens, 80);
		assert.equal(requestedUrl, "https://api.moonshot.cn/v1/tokenizers/estimate-token-count");
		assert.deepEqual(requestedBody, {
			model: "kimi-k2.7-code",
			messages: [{ role: "user", content: "你好" }]
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("moonshot token estimator accepts multimodal message parts", async (): Promise<void> => {
	const originalFetch: typeof fetch = globalThis.fetch;
	let requestedBody: unknown;

	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		requestedBody = JSON.parse(String(init?.body ?? "{}")) as unknown;
		return new Response(JSON.stringify({ data: { total_tokens: 128 } }), {
			status: 200,
			headers: { "Content-Type": "application/json" }
		});
	}) as typeof fetch;

	try {
		const messages = [{
			role: "user" as const,
			content: [
				{ type: "image_url" as const, image_url: { url: "data:image/png;base64,aGVsbG8=" } },
				{ type: "text" as const, text: "描述图片" }
			]
		}];
		const tokens: number | null = await estimateProviderMessagesTokens({
			provider: "moonshot",
			apiKey: "test-key",
			model: "kimi-k2.6"
		}, messages);

		assert.equal(tokens, 128);
		assert.deepEqual(requestedBody, {
			model: "kimi-k2.6",
			messages
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("provider model profiles accept dynamic model ids", (): void => {
	const moonshotProfile = resolveModelProfile("moonshot", "kimi-future-512k", 512_000);
	assert.equal(moonshotProfile.provider, "moonshot");
	assert.equal(moonshotProfile.model, "kimi-future-512k");
	assert.equal(moonshotProfile.contextWindowTokens, 512_000);

	const deepseekProfile = resolveModelProfile("deepseek", "deepseek-future");
	assert.equal(deepseekProfile.provider, "deepseek");
	assert.equal(deepseekProfile.contextWindowTokens, 1_000_000);
});

test("moonshot chat options normalize unsupported temperature values", (): void => {
	const moonshotRequest: ChatCompletionCreateParamsBase = {
		model: "kimi-k2.6",
		messages: []
	};
	applyChatOptions(
		moonshotRequest,
		{ message: "你好", options: { temperature: 0.2 } },
		{ provider: "moonshot", apiKey: "test-key", model: "kimi-k2.6" }
	);
	assert.equal(moonshotRequest.temperature, 1);

	const deepseekRequest: ChatCompletionCreateParamsBase = {
		model: "deepseek-v4-flash",
		messages: []
	};
	applyChatOptions(
		deepseekRequest,
		{ message: "你好", options: { temperature: 0.2 } },
		{ provider: "deepseek", apiKey: "test-key", model: "deepseek-v4-flash" }
	);
	assert.equal(deepseekRequest.temperature, 0.2);
});
