import type { ModelProfile, ProviderId } from "../protocol/types.js";

export type EndpointType = "openai-chat-completions" | "openai-responses";

export type AdapterFamily = "openai-compatible" | "openai-responses";

export type ModelRef = {
	providerId: ProviderId;
	modelId: string;
};

export type ProviderModelCapabilities = {
	imageInput?: boolean | undefined;
	videoInput?: boolean | undefined;
	reasoning?: boolean | undefined;
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
};

export type ProviderDefinition = {
	id: ProviderId;
	displayName: string;
	authType: "api-key";
	defaultEndpointType: EndpointType;
	defaultBaseUrl: string;
	defaultModel: string;
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
