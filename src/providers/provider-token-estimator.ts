import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ProviderChatOptions } from "./deepseek-client.js";
import { resolveChatModel } from "./deepseek-client.js";
import { getProviderDefaultBaseUrl, getProviderDefinition } from "./provider-registry.js";

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function getEstimateEndpoint(options: ProviderChatOptions): string | null {
	const tokenEstimatePath: string | undefined = getProviderDefinition(options.provider).tokenEstimatePath;
	if (tokenEstimatePath === undefined) {
		return null;
	}

	return `${normalizeBaseUrl(options.baseUrl ?? getProviderDefaultBaseUrl(options.provider))}${tokenEstimatePath}`;
}

function readTotalTokens(value: unknown): number {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Token estimate response is not an object");
	}

	const data: unknown = (value as Record<string, unknown>).data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("Token estimate response does not contain data");
	}

	const totalTokens: unknown = (data as Record<string, unknown>).total_tokens;
	if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens)) {
		throw new Error("Token estimate response does not contain data.total_tokens");
	}

	return Math.max(1, Math.ceil(totalTokens));
}

export async function estimateProviderMessagesTokens(
	options: ProviderChatOptions,
	messages: ChatCompletionMessageParam[],
	abortSignal?: AbortSignal | undefined
): Promise<number | null> {
	const endpoint: string | null = getEstimateEndpoint(options);
	if (endpoint === null) {
		return null;
	}

	const requestInit: RequestInit = {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${options.apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			model: resolveChatModel(options),
			messages
		})
	};
	if (abortSignal !== undefined) {
		requestInit.signal = abortSignal;
	}

	const response: Response = await fetch(endpoint, requestInit);

	if (!response.ok) {
		throw new Error(`Token estimate request failed with HTTP ${response.status}`);
	}

	return readTotalTokens(await response.json() as unknown);
}

export async function estimateProviderTextTokens(
	options: ProviderChatOptions,
	text: string,
	abortSignal?: AbortSignal | undefined
): Promise<number | null> {
	return estimateProviderMessagesTokens(options, [{ role: "user", content: text }], abortSignal);
}
