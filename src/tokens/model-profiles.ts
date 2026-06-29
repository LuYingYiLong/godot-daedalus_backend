import type { ModelProfile } from "../protocol/types.js";

export const DEEPSEEK_V4_FLASH: ModelProfile = {
	provider: "deepseek",
	model: "deepseek-v4-flash",
	contextWindowTokens: 1_000_000,
	maxOutputTokens: 384_000,
	defaultOutputReserveTokens: 16_000,
	safetyMarginTokens: 8_000,
};

export const DEEPSEEK_V4_PRO: ModelProfile = {
	provider: "deepseek",
	model: "deepseek-v4-pro",
	contextWindowTokens: 1_000_000,
	maxOutputTokens: 384_000,
	defaultOutputReserveTokens: 32_000,
	safetyMarginTokens: 12_000,
};

const MODEL_REGISTRY: Record<string, ModelProfile> = {
	"deepseek-v4-flash": DEEPSEEK_V4_FLASH,
	"deepseek-v4-pro": DEEPSEEK_V4_PRO,
};

export function resolveModelProfile(modelName: string): ModelProfile {
	const profile: ModelProfile | undefined = MODEL_REGISTRY[modelName];

	if (!profile) {
		throw new Error(`Unknown model: ${modelName}`);
	}

	return profile;
}

export function getDefaultModelProfile(): ModelProfile {
	return DEEPSEEK_V4_FLASH;
}
