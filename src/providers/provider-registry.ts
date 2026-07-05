import type { ProviderId } from "../protocol/types.js";

export type ProviderModelCapabilities = {
	imageInput?: boolean | undefined;
	videoInput?: boolean | undefined;
	reasoning?: boolean | undefined;
};

export type ProviderModelInfo = {
	id: string;
	displayName: string;
	provider: ProviderId;
	contextWindowTokens: number;
	maxOutputTokens: number;
	capabilities: ProviderModelCapabilities;
	ownedBy?: string | undefined;
};

export type ProviderDefinition = {
	id: ProviderId;
	displayName: string;
	defaultBaseUrl: string;
	defaultModel: string;
	modelsPath: string;
	tokenEstimatePath?: string | undefined;
	envBaseUrl?: string | undefined;
	envModel?: string | undefined;
	fallbackModels: readonly ProviderModelInfo[];
};

const DEEPSEEK_FALLBACK_MODELS: readonly ProviderModelInfo[] = [
	{
		id: "deepseek-v4-flash",
		displayName: "DeepSeek V4 Flash",
		provider: "deepseek",
		contextWindowTokens: 1_000_000,
		maxOutputTokens: 384_000,
		capabilities: { reasoning: true },
		ownedBy: "deepseek"
	},
	{
		id: "deepseek-v4-pro",
		displayName: "DeepSeek V4 Pro",
		provider: "deepseek",
		contextWindowTokens: 1_000_000,
		maxOutputTokens: 384_000,
		capabilities: { reasoning: true },
		ownedBy: "deepseek"
	}
];

const MOONSHOT_FALLBACK_MODELS: readonly ProviderModelInfo[] = [
	{
		id: "kimi-k2.7-code",
		displayName: "Kimi K2.7 Code",
		provider: "moonshot",
		contextWindowTokens: 256_000,
		maxOutputTokens: 32_000,
		capabilities: { reasoning: true },
		ownedBy: "moonshot"
	},
	{
		id: "kimi-k2.7-code-highspeed",
		displayName: "Kimi K2.7 Code Highspeed",
		provider: "moonshot",
		contextWindowTokens: 256_000,
		maxOutputTokens: 32_000,
		capabilities: { reasoning: true },
		ownedBy: "moonshot"
	},
	{
		id: "kimi-k2.6",
		displayName: "Kimi K2.6",
		provider: "moonshot",
		contextWindowTokens: 256_000,
		maxOutputTokens: 32_000,
		capabilities: { imageInput: true, videoInput: true, reasoning: true },
		ownedBy: "moonshot"
	},
	{
		id: "kimi-k2.5",
		displayName: "Kimi K2.5",
		provider: "moonshot",
		contextWindowTokens: 256_000,
		maxOutputTokens: 32_000,
		capabilities: { reasoning: true },
		ownedBy: "moonshot"
	},
	{
		id: "moonshot-v1-8k",
		displayName: "Moonshot v1 8K",
		provider: "moonshot",
		contextWindowTokens: 8_192,
		maxOutputTokens: 4_096,
		capabilities: {},
		ownedBy: "moonshot"
	},
	{
		id: "moonshot-v1-32k",
		displayName: "Moonshot v1 32K",
		provider: "moonshot",
		contextWindowTokens: 32_768,
		maxOutputTokens: 8_192,
		capabilities: {},
		ownedBy: "moonshot"
	},
	{
		id: "moonshot-v1-128k",
		displayName: "Moonshot v1 128K",
		provider: "moonshot",
		contextWindowTokens: 131_072,
		maxOutputTokens: 8_192,
		capabilities: {},
		ownedBy: "moonshot"
	},
	{
		id: "moonshot-v1-auto",
		displayName: "Moonshot v1 Auto",
		provider: "moonshot",
		contextWindowTokens: 128_000,
		maxOutputTokens: 8_192,
		capabilities: {},
		ownedBy: "moonshot"
	},
	{
		id: "moonshot-v1-8k-vision-preview",
		displayName: "Moonshot v1 8K Vision Preview",
		provider: "moonshot",
		contextWindowTokens: 8_192,
		maxOutputTokens: 4_096,
		capabilities: { imageInput: true },
		ownedBy: "moonshot"
	},
	{
		id: "moonshot-v1-32k-vision-preview",
		displayName: "Moonshot v1 32K Vision Preview",
		provider: "moonshot",
		contextWindowTokens: 32_768,
		maxOutputTokens: 8_192,
		capabilities: { imageInput: true },
		ownedBy: "moonshot"
	},
	{
		id: "moonshot-v1-128k-vision-preview",
		displayName: "Moonshot v1 128K Vision Preview",
		provider: "moonshot",
		contextWindowTokens: 131_072,
		maxOutputTokens: 8_192,
		capabilities: { imageInput: true },
		ownedBy: "moonshot"
	}
];

const OPENAI_FALLBACK_MODELS: readonly ProviderModelInfo[] = [
	{
		id: "gpt-5.5",
		displayName: "GPT-5.5",
		provider: "openai",
		contextWindowTokens: 400_000,
		maxOutputTokens: 128_000,
		capabilities: { imageInput: true, reasoning: true },
		ownedBy: "openai"
	}
];

export const PROVIDER_DEFINITIONS: Record<ProviderId, ProviderDefinition> = {
	deepseek: {
		id: "deepseek",
		displayName: "DeepSeek",
		defaultBaseUrl: "https://api.deepseek.com",
		defaultModel: "deepseek-v4-flash",
		modelsPath: "/models",
		envBaseUrl: "DEEPSEEK_BASE_URL",
		envModel: "DEEPSEEK_MODEL",
		fallbackModels: DEEPSEEK_FALLBACK_MODELS
	},
	moonshot: {
		id: "moonshot",
		displayName: "Moonshot/Kimi",
		defaultBaseUrl: "https://api.moonshot.cn/v1",
		defaultModel: "kimi-k2.7-code",
		modelsPath: "/models",
		tokenEstimatePath: "/tokenizers/estimate-token-count",
		envBaseUrl: "MOONSHOT_BASE_URL",
		envModel: "MOONSHOT_MODEL",
		fallbackModels: MOONSHOT_FALLBACK_MODELS
	},
	openai: {
		id: "openai",
		displayName: "OpenAI",
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-5.5",
		modelsPath: "/models",
		envBaseUrl: "OPENAI_BASE_URL",
		envModel: "OPENAI_MODEL",
		fallbackModels: OPENAI_FALLBACK_MODELS
	}
};

export const DEFAULT_PROVIDER_ID: ProviderId = "deepseek";

export function getProviderIds(): ProviderId[] {
	return ["deepseek", "moonshot", "openai"];
}

export function getProviderDefinition(provider: ProviderId): ProviderDefinition {
	return PROVIDER_DEFINITIONS[provider];
}

export function getProviderDisplayName(provider: ProviderId): string {
	return getProviderDefinition(provider).displayName;
}

export function getProviderDefaultBaseUrl(provider: ProviderId): string {
	const definition: ProviderDefinition = getProviderDefinition(provider);
	const envBaseUrl: string | undefined = definition.envBaseUrl !== undefined ? process.env[definition.envBaseUrl] : undefined;
	return envBaseUrl !== undefined && envBaseUrl.trim().length > 0 ? envBaseUrl.trim() : definition.defaultBaseUrl;
}

export function getProviderDefaultModel(provider: ProviderId): string {
	const definition: ProviderDefinition = getProviderDefinition(provider);
	const envModel: string | undefined = definition.envModel !== undefined ? process.env[definition.envModel] : undefined;
	return envModel !== undefined && envModel.trim().length > 0 ? envModel.trim() : definition.defaultModel;
}

export function getProviderFallbackModels(provider: ProviderId): ProviderModelInfo[] {
	return getProviderDefinition(provider).fallbackModels.map((model: ProviderModelInfo): ProviderModelInfo => ({
		...model,
		capabilities: { ...model.capabilities }
	}));
}

export function isProviderId(value: unknown): value is ProviderId {
	return value === "deepseek" || value === "moonshot" || value === "openai";
}
