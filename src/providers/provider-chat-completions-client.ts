import OpenAI from "openai";
import type {
	ChatCompletionChunk,
	ChatCompletionCreateParamsBase,
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam
} from "openai/resources/chat/completions";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import { createProviderMessages } from "./provider-image-content.js";
import { normalizeConfiguredProviderBaseUrl, resolveProviderBaseUrl } from "./provider-base-url.js";
import type { ProviderChatOptions } from "./provider-types.js";
import { getProviderDefaultModel, getProviderEndpointConfig } from "./provider-registry.js";

export function createOpenAICompatibleClient(options: ProviderChatOptions): OpenAI {
	const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
		apiKey: options.apiKey,
		baseURL: normalizeConfiguredProviderBaseUrl(options.baseUrl) ?? resolveProviderBaseUrl(options.provider, undefined)
	};
	return new OpenAI(clientOptions);
}

export function resolveChatModel(options: ProviderChatOptions): string {
	return options.model ?? getProviderDefaultModel(options.provider);
}

export function createMessages(params: AiChatParams, history: ChatMessage[], systemPrompt: string): ChatCompletionMessageParam[] {
	return createProviderMessages(params, history, systemPrompt);
}

function normalizeTemperature(options: ProviderChatOptions, temperature: number): number {
	const constraint = getProviderEndpointConfig(options.provider, options.endpointType).temperature;
	if (constraint === undefined) {
		return temperature;
	}

	return Math.min(constraint.max, Math.max(constraint.min, temperature));
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

export async function chatWithOpenAICompatible(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	const client: OpenAI = createOpenAICompatibleClient(options);
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

export async function* streamChatWithOpenAICompatible(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): AsyncGenerator<string> {
	const client: OpenAI = createOpenAICompatibleClient(options);
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
