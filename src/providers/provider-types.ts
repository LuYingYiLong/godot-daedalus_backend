import type { ModelProfile, ProviderId } from "../protocol/types.js";

export type EndpointType = "openai-chat-completions" | "openai-responses";

export type AdapterFamily = "openai-compatible" | "openai-responses";

export type ProviderModelListMode = "api-plus-catalog" | "catalog-recommended";

export type ModelRef = {
	providerId: ProviderId;
	modelId: string;
};

export type ProviderModelCapabilities = {
	imageInput?: boolean | undefined;
	videoInput?: boolean | undefined;
	reasoning?: boolean | undefined;
	tools?: boolean | undefined;
	webSearch?: boolean | undefined;
	vision?: boolean | undefined;
	imageGeneration?: boolean | undefined;
	imageEdit?: boolean | undefined;
};

export type ProviderModelInfo = {
	id: string;
	displayName: string;
	provider: ProviderId;
	endpointType: EndpointType;
	contextWindowTokens: number;
	maxOutputTokens: number;
	capabilities: ProviderModelCapabilities;
	ownedBy?: string | undefined;
};

export type ProviderEndpointConfig = {
	baseUrl: string;
	adapterFamily: AdapterFamily;
	modelsPath: string;
	tokenEstimatePath?: string | undefined;
	requiredToolChoice?: "auto" | "omit" | undefined;
	temperature?: {
		min: number;
		max: number;
	} | undefined;
};

export type ProviderDefinition = {
	id: ProviderId;
	displayName: string;
	authType: "api-key";
	defaultEndpointType: EndpointType;
	defaultBaseUrl: string;
	defaultModel: string;
	modelListMode: ProviderModelListMode;
	modelsPath: string;
	tokenEstimatePath?: string | undefined;
	envBaseUrl?: string | undefined;
	envModel?: string | undefined;
	endpointConfigs: Partial<Record<EndpointType, ProviderEndpointConfig>>;
	fallbackModels: readonly ProviderModelInfo[];
};

export type ProviderChatOptions = {
	provider: ProviderId;
	apiKey: string;
	baseUrl?: string | undefined;
	model?: string | undefined;
	endpointType?: EndpointType | undefined;
	adapterFamily?: AdapterFamily | undefined;
	modelProfile?: ModelProfile | undefined;
};

export type ProviderRuntimeConfig = {
	providerId: ProviderId;
	modelId: string;
	endpointType: EndpointType;
	adapterFamily: AdapterFamily;
	baseUrl: string;
	apiKey: string;
	modelProfile: ModelProfile;
};

function copyBooleanCapability(target: ProviderModelCapabilities, source: ProviderModelCapabilities, key: keyof ProviderModelCapabilities): void {
	const value: boolean | undefined = source[key];
	if (value !== undefined) {
		target[key] = value;
	}
}

export function normalizeProviderModelCapabilities(capabilities: ProviderModelCapabilities | undefined): ProviderModelCapabilities {
	const source: ProviderModelCapabilities = capabilities ?? {};
	const normalized: ProviderModelCapabilities = {};

	copyBooleanCapability(normalized, source, "imageInput");
	copyBooleanCapability(normalized, source, "videoInput");
	copyBooleanCapability(normalized, source, "reasoning");
	copyBooleanCapability(normalized, source, "tools");
	copyBooleanCapability(normalized, source, "webSearch");
	copyBooleanCapability(normalized, source, "imageGeneration");
	copyBooleanCapability(normalized, source, "imageEdit");
	normalized.vision = source.vision ?? (source.imageInput === true || source.videoInput === true);

	return normalized;
}
