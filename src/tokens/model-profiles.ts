import type { ModelProfile, ProviderId } from "../protocol/types.js";
import { getCatalogModel, getProviderDefaultModel, getProviderFallbackModels, type ProviderModelInfo } from "../providers/provider-registry.js";

const DEFAULT_OUTPUT_RESERVE_TOKENS: number = 16_000;
const DEFAULT_SAFETY_MARGIN_TOKENS: number = 8_000;
const FALLBACK_CONTEXT_WINDOW_TOKENS: number = 128_000;
const FALLBACK_MAX_OUTPUT_TOKENS: number = 8_192;

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

function inferProfile(provider: ProviderId, modelName: string): ModelProfile {
	return createProfile(provider, modelName, FALLBACK_CONTEXT_WINDOW_TOKENS, FALLBACK_MAX_OUTPUT_TOKENS);
}

export function resolveModelProfile(provider: ProviderId, modelName: string, contextWindowTokens?: number | undefined): ModelProfile {
	if (contextWindowTokens !== undefined && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
		const roundedContextWindowTokens: number = Math.floor(contextWindowTokens);
		return createProfile(
			provider,
			modelName,
			roundedContextWindowTokens,
			Math.min(FALLBACK_MAX_OUTPUT_TOKENS, Math.max(4_096, Math.floor(roundedContextWindowTokens / 4)))
		);
	}

	const catalogModel: ProviderModelInfo | undefined = getCatalogModel(provider, modelName);
	if (catalogModel !== undefined) {
		return profileFromModelInfo(catalogModel);
	}

	return inferProfile(provider, modelName);
}

export function getDefaultModelProfile(provider: ProviderId = "deepseek"): ModelProfile {
	return resolveModelProfile(provider, getProviderDefaultModel(provider));
}

export function listDefaultModelProfiles(provider: ProviderId): ModelProfile[] {
	return getProviderFallbackModels(provider).map(profileFromModelInfo);
}
