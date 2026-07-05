import type { ModelProfile, ProviderId } from "../protocol/types.js";
import { getProviderDefaultModel, getProviderFallbackModels, type ProviderModelInfo } from "../providers/provider-registry.js";

const DEFAULT_OUTPUT_RESERVE_TOKENS: number = 16_000;
const DEFAULT_SAFETY_MARGIN_TOKENS: number = 8_000;

function createProfile(
	provider: ProviderId,
	model: string,
	contextWindowTokens: number,
	maxOutputTokens: number
): ModelProfile {
	return {
		provider,
		model,
		contextWindowTokens,
		maxOutputTokens,
		defaultOutputReserveTokens: Math.min(DEFAULT_OUTPUT_RESERVE_TOKENS, Math.max(1_024, Math.floor(maxOutputTokens / 2))),
		safetyMarginTokens: Math.min(DEFAULT_SAFETY_MARGIN_TOKENS, Math.max(1_024, Math.floor(contextWindowTokens * 0.02)))
	};
}

function profileFromModelInfo(model: ProviderModelInfo): ModelProfile {
	return createProfile(model.provider, model.id, model.contextWindowTokens, model.maxOutputTokens);
}

function inferMoonshotContext(modelName: string): number {
	const lowerName: string = modelName.toLowerCase();
	if (lowerName.includes("8k")) {
		return 8_192;
	}
	if (lowerName.includes("32k")) {
		return 32_768;
	}
	if (lowerName.includes("128k")) {
		return 131_072;
	}
	return 256_000;
}

function inferProfile(provider: ProviderId, modelName: string): ModelProfile {
	if (provider === "deepseek") {
		return createProfile(provider, modelName, 1_000_000, 384_000);
	}

	if (provider === "openai") {
		return createProfile(provider, modelName, 400_000, 128_000);
	}

	const contextWindowTokens: number = inferMoonshotContext(modelName);
	const maxOutputTokens: number = contextWindowTokens <= 8_192 ? 4_096 : Math.min(32_000, Math.floor(contextWindowTokens / 4));
	return createProfile(provider, modelName, contextWindowTokens, maxOutputTokens);
}

export function resolveModelProfile(provider: ProviderId, modelName: string, contextWindowTokens?: number | undefined): ModelProfile {
	if (contextWindowTokens !== undefined && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
		const maxOutputTokens: number = provider === "deepseek"
			? 384_000
			: provider === "openai"
				? Math.min(128_000, Math.max(4_096, Math.floor(contextWindowTokens / 3)))
				: Math.min(32_000, Math.max(4_096, Math.floor(contextWindowTokens / 4)));
		return createProfile(provider, modelName, Math.floor(contextWindowTokens), maxOutputTokens);
	}

	const fallback: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
		.find((model: ProviderModelInfo): boolean => model.id === modelName);
	if (fallback !== undefined) {
		return profileFromModelInfo(fallback);
	}

	return inferProfile(provider, modelName);
}

export function getDefaultModelProfile(provider: ProviderId = "deepseek"): ModelProfile {
	return resolveModelProfile(provider, getProviderDefaultModel(provider));
}
