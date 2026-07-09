import type { ProviderId } from "../protocol/types.js";
import {
	getProviderDefinition,
	getProviderFallbackModels,
	type ProviderModelCapabilities,
	type ProviderModelInfo
} from "./provider-registry.js";
import { getProviderModelsCache, saveProviderModelsCache, type StoredProviderModelsCache } from "./provider-config-store.js";
import { resolveProviderBaseUrl } from "./provider-base-url.js";

export type ProviderModelsListResult = {
	provider: ProviderId;
	models: ProviderModelInfo[];
	stale: boolean;
	source: "api" | "cache" | "fallback";
	error?: string | undefined;
};

function createDisplayName(modelId: string): string {
	return modelId
		.split("-")
		.filter((part: string): boolean => part.length > 0)
		.map((part: string): string => part.length <= 3 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1))
		.join(" ");
}

function inferContextLength(provider: ProviderId, modelId: string, rawContextLength: unknown): number {
	if (typeof rawContextLength === "number" && Number.isFinite(rawContextLength) && rawContextLength > 0) {
		return Math.floor(rawContextLength);
	}

	const fallback: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
		.find((model: ProviderModelInfo): boolean => model.id === modelId);
	if (fallback !== undefined) {
		return fallback.contextWindowTokens;
	}

	if (provider === "deepseek") {
		return 1_000_000;
	}
	if (provider === "openai") {
		return 400_000;
	}

	const lowerId: string = modelId.toLowerCase();
	if (lowerId.includes("8k")) {
		return 8_192;
	}
	if (lowerId.includes("32k")) {
		return 32_768;
	}
	if (lowerId.includes("128k")) {
		return 131_072;
	}
	return 256_000;
}

function inferMaxOutputTokens(provider: ProviderId, modelId: string, contextWindowTokens: number): number {
	const fallback: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
		.find((model: ProviderModelInfo): boolean => model.id === modelId);
	if (fallback !== undefined) {
		return fallback.maxOutputTokens;
	}

	if (provider === "deepseek") {
		return 384_000;
	}
	if (provider === "openai") {
		return Math.min(128_000, Math.max(4_096, Math.floor(contextWindowTokens / 3)));
	}

	return contextWindowTokens <= 8_192 ? 4_096 : Math.min(32_000, Math.max(4_096, Math.floor(contextWindowTokens / 4)));
}

function normalizeCapabilities(raw: Record<string, unknown>, fallback: ProviderModelInfo | undefined): ProviderModelCapabilities {
	return {
		imageInput: typeof raw.supports_image_in === "boolean"
			? raw.supports_image_in
			: typeof raw.input_modalities === "object" && Array.isArray(raw.input_modalities)
				? raw.input_modalities.includes("image")
				: fallback?.capabilities.imageInput,
		videoInput: typeof raw.supports_video_in === "boolean" ? raw.supports_video_in : fallback?.capabilities.videoInput,
		reasoning: typeof raw.supports_reasoning === "boolean" ? raw.supports_reasoning : fallback?.capabilities.reasoning
	};
}

function parseApiModels(provider: ProviderId, value: unknown): ProviderModelInfo[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Provider model list response is not an object");
	}

	const data: unknown = (value as Record<string, unknown>).data;
	if (!Array.isArray(data)) {
		throw new Error("Provider model list response does not contain data[]");
	}

	const models: ProviderModelInfo[] = [];
	for (const item of data) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			continue;
		}

		const record: Record<string, unknown> = item as Record<string, unknown>;
		if (typeof record.id !== "string" || record.id.trim().length === 0) {
			continue;
		}

		const id: string = record.id.trim();
		const fallback: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
			.find((model: ProviderModelInfo): boolean => model.id === id);
		const contextWindowTokens: number = inferContextLength(provider, id, record.context_length);
		models.push({
			id,
			displayName: fallback?.displayName ?? createDisplayName(id),
			provider,
			contextWindowTokens,
			maxOutputTokens: inferMaxOutputTokens(provider, id, contextWindowTokens),
			capabilities: normalizeCapabilities(record, fallback),
			ownedBy: typeof record.owned_by === "string" ? record.owned_by : fallback?.ownedBy
		});
	}

	if (models.length === 0) {
		throw new Error("Provider model list response contains no usable models");
	}

	return models;
}

async function fetchProviderModels(provider: ProviderId, apiKey: string, baseUrl?: string | undefined): Promise<ProviderModelInfo[]> {
	const endpoint: string = `${resolveProviderBaseUrl(provider, baseUrl)}${getProviderDefinition(provider).modelsPath}`;
	const response: Response = await fetch(endpoint, {
		method: "GET",
		headers: {
			"Authorization": `Bearer ${apiKey}`
		}
	});

	if (!response.ok) {
		throw new Error(`Model list request failed with HTTP ${response.status}`);
	}

	const body: unknown = await response.json() as unknown;
	return parseApiModels(provider, body);
}

export async function listProviderModels(
	provider: ProviderId,
	apiKey: string | undefined,
	baseUrl: string | undefined,
	refresh: boolean = false
): Promise<ProviderModelsListResult> {
	if (apiKey !== undefined && refresh) {
		try {
			const models: ProviderModelInfo[] = await fetchProviderModels(provider, apiKey, baseUrl);
			await saveProviderModelsCache(provider, models);
			return { provider, models, stale: false, source: "api" };
		} catch (error: unknown) {
			const cache: StoredProviderModelsCache | undefined = await getProviderModelsCache(provider);
			if (cache !== undefined) {
				return {
					provider,
					models: cache.models,
					stale: true,
					source: "cache",
					error: error instanceof Error ? error.message : "Failed to fetch provider models"
				};
			}

			return {
				provider,
				models: getProviderFallbackModels(provider),
				stale: true,
				source: "fallback",
				error: error instanceof Error ? error.message : "Failed to fetch provider models"
			};
		}
	}

	const cache: StoredProviderModelsCache | undefined = await getProviderModelsCache(provider);
	if (cache !== undefined) {
		return { provider, models: cache.models, stale: true, source: "cache" };
	}

	if (apiKey !== undefined) {
		try {
			const models: ProviderModelInfo[] = await fetchProviderModels(provider, apiKey, baseUrl);
			await saveProviderModelsCache(provider, models);
			return { provider, models, stale: false, source: "api" };
		} catch (error: unknown) {
			return {
				provider,
				models: getProviderFallbackModels(provider),
				stale: true,
				source: "fallback",
				error: error instanceof Error ? error.message : "Failed to fetch provider models"
			};
		}
	}

	return { provider, models: getProviderFallbackModels(provider), stale: true, source: "fallback" };
}
