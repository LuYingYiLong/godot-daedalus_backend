import OpenAI from "openai";
import type {
	ChatCompletionChunk,
	ChatCompletionCreateParamsBase,
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam
} from "openai/resources/chat/completions";
import type { AiChatParams, ChatMessage, ProviderId } from "../protocol/types.js";
import { getProviderDefaultModel } from "./provider-registry.js";
import { createProviderMessages } from "./provider-image-content.js";
import { chatWithOpenAIResponses, streamChatWithOpenAIResponses } from "./openai-responses-client.js";
import { normalizeConfiguredProviderBaseUrl, resolveProviderBaseUrl } from "./provider-base-url.js";

export type ProviderChatOptions = {
	provider: ProviderId;
	apiKey: string;
	baseUrl?: string | undefined;
	model?: string | undefined;
};

export type DeepSeekChatOptions = ProviderChatOptions;

export function createProviderClient(options: ProviderChatOptions): OpenAI {
	const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
		apiKey: options.apiKey
	};
	const normalizedBaseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(options.baseUrl);
	if (options.provider !== "openai" || normalizedBaseUrl !== undefined) {
		clientOptions.baseURL = normalizedBaseUrl ?? resolveProviderBaseUrl(options.provider, undefined);
	}
	return new OpenAI(clientOptions);
}

export function createDeepSeekClient(options: DeepSeekChatOptions): OpenAI {
	return createProviderClient(options);
}

export function resolveChatModel(options: ProviderChatOptions): string {
	return options.model ?? getProviderDefaultModel(options.provider);
}

export function createMessages(params: AiChatParams, history: ChatMessage[], systemPrompt: string): ChatCompletionMessageParam[] {
	return createProviderMessages(params, history, systemPrompt);
}

function normalizeTemperature(options: ProviderChatOptions, temperature: number): number {
	if (options.provider === "moonshot") {
		return 1;
	}

	return temperature;
}

export function applyChatOptions(requestBody: ChatCompletionCreateParamsBase, params: AiChatParams, options: ProviderChatOptions): void {
	if (params.options?.temperature !== undefined) {
		requestBody.temperature = normalizeTemperature(options, params.options.temperature);
	}

	if (params.options?.topP !== undefined) {
		requestBody.top_p = params.options.topP;
	}

	if (params.options?.maxTokens !== undefined) {
		requestBody.max_tokens = params.options.maxTokens;
	}

	if (params.options?.stop !== undefined) {
		requestBody.stop = params.options.stop;
	}

	if (params.options?.responseFormat === "json") {
		requestBody.response_format = { type: "json_object" };
	}
}

export async function chatWithProvider(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	if (options.provider === "openai") {
		return chatWithOpenAIResponses(params, options, history, systemPrompt, abortSignal);
	}

	const client: OpenAI = createProviderClient(options);
	const requestBody: ChatCompletionCreateParamsNonStreaming = {
		model: resolveChatModel(options),
		messages: createMessages(params, history, systemPrompt)
	};

	applyChatOptions(requestBody, params, options);

	const completion = await client.chat.completions.create(requestBody, { signal: abortSignal });

	const text: string | null | undefined = completion.choices[0]?.message.content;
	if (!text) {
		throw new Error("LLM returned empty response");
	}

	return text;
}

export async function chatWithDeepSeek(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	return chatWithProvider(params, options, history, systemPrompt, abortSignal);
}

export async function* streamChatWithProvider(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): AsyncGenerator<string> {
	if (options.provider === "openai") {
		yield* streamChatWithOpenAIResponses(params, options, history, systemPrompt, abortSignal);
		return;
	}

	const client: OpenAI = createProviderClient(options);
	const requestBody: ChatCompletionCreateParamsStreaming = {
		model: resolveChatModel(options),
		messages: createMessages(params, history, systemPrompt),
		stream: true
	};

	applyChatOptions(requestBody, params, options);

	const stream = await client.chat.completions.create(requestBody, { signal: abortSignal });
	for await (const chunk of stream) {
		const delta: string | null | undefined = (chunk as ChatCompletionChunk).choices[0]?.delta.content;
		if (delta !== undefined && delta !== null && delta.length > 0) {
			yield delta;
		}
	}
}

export async function* streamChatWithDeepSeek(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): AsyncGenerator<string> {
	yield* streamChatWithProvider(params, options, history, systemPrompt, abortSignal);
}
