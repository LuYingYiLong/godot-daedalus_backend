import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderId } from "../protocol/types.js";
import type {
	AdapterFamily,
	EndpointType,
	ProviderDefinition,
	ProviderEndpointConfig,
	ProviderModelCapabilities,
	ProviderModelInfo
} from "./provider-types.js";

export type {
	AdapterFamily,
	EndpointType,
	ProviderDefinition,
	ProviderEndpointConfig,
	ProviderModelCapabilities,
	ProviderModelInfo
} from "./provider-types.js";

type RawProviderCatalogEntry = {
	id: string;
	displayName: string;
	authType: "api-key";
	defaultModel: string;
	defaultEndpointType: EndpointType;
	endpointConfigs: Record<string, ProviderEndpointConfig>;
	envBaseUrl?: string | undefined;
	envModel?: string | undefined;
};

type RawEndpointConfig = {
	baseUrl: string;
	adapterFamily: AdapterFamily;
	modelsPath?: string | undefined;
	tokenEstimatePath?: string | undefined;
};

type RawModelCatalogEntry = {
	id: string;
	displayName: string;
	provider: string;
	endpointType: EndpointType;
	contextWindowTokens: number;
	maxOutputTokens: number;
	capabilities?: ProviderModelCapabilities | undefined;
	ownedBy?: string | undefined;
};

type ProviderCatalog = {
	providers: Record<ProviderId, ProviderDefinition>;
	models: ProviderModelInfo[];
};

const DEFAULT_MODELS_PATH: string = "/models";
export const DEFAULT_PROVIDER_ID: ProviderId = "deepseek";

const CATALOG_DIR: string = join(dirname(fileURLToPath(import.meta.url)), "catalog");
const PROVIDERS_CATALOG_PATH: string = join(CATALOG_DIR, "providers.json");
const MODELS_CATALOG_PATH: string = join(CATALOG_DIR, "models.json");

function readJsonFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
	const value: unknown = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Provider catalog field ${key} must be a non-empty string`);
	}
	return value.trim();
}

function readPositiveInteger(record: Record<string, unknown>, key: string): number {
	const value: unknown = record[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Provider model catalog field ${key} must be a positive number`);
	}
	return Math.floor(value);
}

function isEndpointType(value: unknown): value is EndpointType {
	return value === "openai-chat-completions" || value === "openai-responses";
}

function isAdapterFamily(value: unknown): value is AdapterFamily {
	return value === "openai-compatible" || value === "openai-responses";
}

function parseEndpointConfig(value: unknown, providerId: string, endpointType: string): ProviderEndpointConfig {
	if (!isRecord(value)) {
		throw new Error(`Provider ${providerId} endpoint ${endpointType} must be an object`);
	}

	const baseUrl: string = readString(value, "baseUrl");
	const adapterFamilyValue: unknown = value.adapterFamily;
	if (!isAdapterFamily(adapterFamilyValue)) {
		throw new Error(`Provider ${providerId} endpoint ${endpointType} has unsupported adapterFamily`);
	}

	const config: ProviderEndpointConfig = {
		baseUrl,
		adapterFamily: adapterFamilyValue,
		modelsPath: typeof value.modelsPath === "string" && value.modelsPath.trim().length > 0
			? value.modelsPath.trim()
			: DEFAULT_MODELS_PATH
	};
	if (typeof value.tokenEstimatePath === "string" && value.tokenEstimatePath.trim().length > 0) {
		config.tokenEstimatePath = value.tokenEstimatePath.trim();
	}
	return config;
}

function parseProviders(value: unknown): RawProviderCatalogEntry[] {
	if (!Array.isArray(value)) {
		throw new Error("Provider catalog must be an array");
	}

	return value.map((item: unknown): RawProviderCatalogEntry => {
		if (!isRecord(item)) {
			throw new Error("Provider catalog entry must be an object");
		}

		const id: string = readString(item, "id");
		const defaultEndpointTypeValue: unknown = item.defaultEndpointType;
		if (!isEndpointType(defaultEndpointTypeValue)) {
			throw new Error(`Provider ${id} has unsupported defaultEndpointType`);
		}

		if (item.authType !== "api-key") {
			throw new Error(`Provider ${id} has unsupported authType`);
		}

		if (!isRecord(item.endpointConfigs)) {
			throw new Error(`Provider ${id} endpointConfigs must be an object`);
		}

		const endpointConfigs: Record<string, ProviderEndpointConfig> = {};
		for (const [endpointType, config] of Object.entries(item.endpointConfigs)) {
			if (!isEndpointType(endpointType)) {
				throw new Error(`Provider ${id} endpoint ${endpointType} is not supported`);
			}
			endpointConfigs[endpointType] = parseEndpointConfig(config, id, endpointType);
		}

		return {
			id,
			displayName: readString(item, "displayName"),
			authType: "api-key",
			defaultModel: readString(item, "defaultModel"),
			defaultEndpointType: defaultEndpointTypeValue,
			endpointConfigs,
			envBaseUrl: typeof item.envBaseUrl === "string" ? item.envBaseUrl : undefined,
			envModel: typeof item.envModel === "string" ? item.envModel : undefined
		};
	});
}

function parseModels(value: unknown): RawModelCatalogEntry[] {
	if (!Array.isArray(value)) {
		throw new Error("Provider model catalog must be an array");
	}

	return value.map((item: unknown): RawModelCatalogEntry => {
		if (!isRecord(item)) {
			throw new Error("Provider model catalog entry must be an object");
		}

		const endpointTypeValue: unknown = item.endpointType;
		if (!isEndpointType(endpointTypeValue)) {
			throw new Error(`Model ${String(item.id)} has unsupported endpointType`);
		}

		const raw: RawModelCatalogEntry = {
			id: readString(item, "id"),
			displayName: readString(item, "displayName"),
			provider: readString(item, "provider"),
			endpointType: endpointTypeValue,
			contextWindowTokens: readPositiveInteger(item, "contextWindowTokens"),
			maxOutputTokens: readPositiveInteger(item, "maxOutputTokens"),
			capabilities: isRecord(item.capabilities) ? item.capabilities as ProviderModelCapabilities : {},
			ownedBy: typeof item.ownedBy === "string" ? item.ownedBy : undefined
		};
		return raw;
	});
}

function buildCatalog(): ProviderCatalog {
	const rawProviders: RawProviderCatalogEntry[] = parseProviders(readJsonFile(PROVIDERS_CATALOG_PATH));
	const rawModels: RawModelCatalogEntry[] = parseModels(readJsonFile(MODELS_CATALOG_PATH));
	const providerIds: Set<string> = new Set();
	const modelKeys: Set<string> = new Set();
	const modelsByProvider: Map<string, ProviderModelInfo[]> = new Map();

	for (const provider of rawProviders) {
		if (providerIds.has(provider.id)) {
			throw new Error(`Duplicate provider id in catalog: ${provider.id}`);
		}
		providerIds.add(provider.id);
		if (provider.endpointConfigs[provider.defaultEndpointType] === undefined) {
			throw new Error(`Provider ${provider.id} default endpoint is missing from endpointConfigs`);
		}
	}

	for (const rawModel of rawModels) {
		if (!providerIds.has(rawModel.provider)) {
			throw new Error(`Model ${rawModel.id} references unknown provider ${rawModel.provider}`);
		}
		const key: string = `${rawModel.provider}:${rawModel.id}`;
		if (modelKeys.has(key)) {
			throw new Error(`Duplicate model id in catalog: ${key}`);
		}
		modelKeys.add(key);

		const model: ProviderModelInfo = {
			id: rawModel.id,
			displayName: rawModel.displayName,
			provider: rawModel.provider,
			endpointType: rawModel.endpointType,
			contextWindowTokens: rawModel.contextWindowTokens,
			maxOutputTokens: rawModel.maxOutputTokens,
			capabilities: { ...(rawModel.capabilities ?? {}) }
		};
		if (rawModel.ownedBy !== undefined) {
			model.ownedBy = rawModel.ownedBy;
		}
		modelsByProvider.set(rawModel.provider, [...(modelsByProvider.get(rawModel.provider) ?? []), model]);
	}

	const providers: Record<ProviderId, ProviderDefinition> = {};
	for (const rawProvider of rawProviders) {
		const fallbackModels: ProviderModelInfo[] = modelsByProvider.get(rawProvider.id) ?? [];
		if (!fallbackModels.some((model: ProviderModelInfo): boolean => model.id === rawProvider.defaultModel)) {
			throw new Error(`Provider ${rawProvider.id} default model ${rawProvider.defaultModel} is missing from model catalog`);
		}

		const defaultEndpoint: ProviderEndpointConfig = rawProvider.endpointConfigs[rawProvider.defaultEndpointType]!;
		const definition: ProviderDefinition = {
			id: rawProvider.id,
			displayName: rawProvider.displayName,
			authType: rawProvider.authType,
			defaultEndpointType: rawProvider.defaultEndpointType,
			defaultBaseUrl: defaultEndpoint.baseUrl,
			defaultModel: rawProvider.defaultModel,
			modelsPath: defaultEndpoint.modelsPath,
			endpointConfigs: rawProvider.endpointConfigs,
			fallbackModels
		};
		if (defaultEndpoint.tokenEstimatePath !== undefined) {
			definition.tokenEstimatePath = defaultEndpoint.tokenEstimatePath;
		}
		if (rawProvider.envBaseUrl !== undefined) {
			definition.envBaseUrl = rawProvider.envBaseUrl;
		}
		if (rawProvider.envModel !== undefined) {
			definition.envModel = rawProvider.envModel;
		}
		providers[rawProvider.id] = definition;
	}

	if (providers[DEFAULT_PROVIDER_ID] === undefined) {
		throw new Error(`Default provider ${DEFAULT_PROVIDER_ID} is missing from catalog`);
	}

	return {
		providers,
		models: rawModels.map((rawModel: RawModelCatalogEntry): ProviderModelInfo => {
			const model = (modelsByProvider.get(rawModel.provider) ?? []).find((item: ProviderModelInfo): boolean => item.id === rawModel.id);
			if (model === undefined) {
				throw new Error(`Model ${rawModel.provider}:${rawModel.id} failed catalog normalization`);
			}
			return model;
		})
	};
}

const CATALOG: ProviderCatalog = buildCatalog();
export const PROVIDER_DEFINITIONS: Record<ProviderId, ProviderDefinition> = CATALOG.providers;

export function getProviderIds(): ProviderId[] {
	return Object.keys(CATALOG.providers);
}

export function getProviderDefinition(provider: ProviderId): ProviderDefinition {
	const definition: ProviderDefinition | undefined = CATALOG.providers[provider];
	if (definition === undefined) {
		throw new Error(`Unknown provider: ${provider}`);
	}
	return definition;
}

export function getProviderDisplayName(provider: ProviderId): string {
	return getProviderDefinition(provider).displayName;
}

export function getProviderDefaultEndpointType(provider: ProviderId): EndpointType {
	return getProviderDefinition(provider).defaultEndpointType;
}

export function getProviderEndpointConfig(provider: ProviderId, endpointType?: EndpointType | undefined): ProviderEndpointConfig {
	const definition: ProviderDefinition = getProviderDefinition(provider);
	const resolvedEndpointType: EndpointType = endpointType ?? definition.defaultEndpointType;
	const endpointConfig: ProviderEndpointConfig | undefined = definition.endpointConfigs[resolvedEndpointType];
	if (endpointConfig === undefined) {
		throw new Error(`Provider ${provider} does not define endpoint ${resolvedEndpointType}`);
	}
	return endpointConfig;
}

export function getProviderAdapterFamily(provider: ProviderId, endpointType?: EndpointType | undefined): AdapterFamily {
	return getProviderEndpointConfig(provider, endpointType).adapterFamily;
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

export function getCatalogModel(provider: ProviderId, modelId: string): ProviderModelInfo | undefined {
	return getProviderFallbackModels(provider).find((model: ProviderModelInfo): boolean => model.id === modelId);
}

export function getCatalogModels(): ProviderModelInfo[] {
	return CATALOG.models.map((model: ProviderModelInfo): ProviderModelInfo => ({
		...model,
		capabilities: { ...model.capabilities }
	}));
}

export function isProviderId(value: unknown): value is ProviderId {
	return typeof value === "string" && CATALOG.providers[value] !== undefined;
}
