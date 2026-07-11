import OpenAI from "openai";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type { ProviderChatOptions } from "./provider-types.js";
import { resolveProviderAdapter } from "./provider-adapter.js";
import "./provider-adapters.js";
import {
	applyChatOptions,
	createMessages,
	createOpenAICompatibleClient,
	resolveChatModel
} from "./provider-chat-completions-client.js";

export type { ProviderChatOptions } from "./provider-types.js";
export type DeepSeekChatOptions = ProviderChatOptions;

export function createProviderClient(options: ProviderChatOptions): OpenAI {
	return createOpenAICompatibleClient(options);
}

export function createDeepSeekClient(options: ProviderChatOptions): OpenAI {
	return createProviderClient(options);
}

export { applyChatOptions, createMessages, resolveChatModel };

export async function chatWithProvider(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	return resolveProviderAdapter(options).chat(params, options, history, systemPrompt, abortSignal);
}

export async function chatWithDeepSeek(
	params: AiChatParams,
	options: ProviderChatOptions,
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
	yield* resolveProviderAdapter(options).streamChat(params, options, history, systemPrompt, abortSignal);
}

export async function* streamChatWithDeepSeek(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	abortSignal?: AbortSignal | undefined
): AsyncGenerator<string> {
	yield* streamChatWithProvider(params, options, history, systemPrompt, abortSignal);
}
