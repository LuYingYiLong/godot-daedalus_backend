import { readFile, rm } from "node:fs/promises";
import keytar from "keytar";
import { getProviderConfigPath } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";
import type { ProviderId } from "../protocol/types.js";
import {
	DEFAULT_PROVIDER_ID,
	getProviderDefaultBaseUrl,
	getProviderDefaultModel,
	getProviderDisplayName,
	getProviderFallbackModels,
	getProviderIds,
	isProviderId,
	mergeProviderModelsWithCatalog,
	normalizeProviderModelCapabilities,
	type ProviderModelInfo
} from "./provider-registry.js";
import type { ModelRef } from "./provider-types.js";

const KEYTAR_SERVICE: string = "Godot Daedalus";

export type ProviderConfigInput = {
	provider: ProviderId;
	apiKey?: string | null | undefined;
	model?: string | undefined;
	baseUrl?: string | null | undefined;
	activate?: boolean | undefined;
	modelRouting?: ProviderModelRoutingInput | undefined;
};

export type ProviderTaskModelRef = {
	provider: ProviderId;
	model: string;
};

export type ProviderModelRouting = {
	imageRecognition: ProviderTaskModelRef | null;
	workflowPlanner: ProviderTaskModelRef | null;
	sessionTitle: ProviderTaskModelRef | null;
	imageGeneration: ProviderTaskModelRef | null;
};

export type ProviderModelRoutingInput = Partial<Record<keyof ProviderModelRouting, ProviderTaskModelRef | null | undefined>>;

export type StoredProviderModelsCache = {
	models: ProviderModelInfo[];
	updatedAt: string;
};

export type StoredProviderEntry = {
	model?: string | undefined;
	baseUrl?: string | undefined;
	keyStorage: "keytar";
	updatedAt: string;
	modelsCache?: StoredProviderModelsCache | undefined;
};

export type StoredProviderConfig = {
	schemaVersion: 3;
	activeModel: ModelRef;
	providers: Partial<Record<ProviderId, StoredProviderEntry>>;
	modelRouting: ProviderModelRouting;
};

export type ProviderConfigWithSecret = {
	provider: ProviderId;
	model?: string | undefined;
	baseUrl?: string | undefined;
	apiKey?: string | undefined;
};

export type ProviderConfigProviderStatus = {
	provider: ProviderId;
	displayName: string;
	configured: boolean;
	model: string | null;
	baseUrl: string | null;
	defaultModel: string;
	defaultBaseUrl: string;
	modelsCache: ProviderModelInfo[];
	fallbackModels: readonly ProviderModelInfo[];
	apiKeyMasked: string | null;
	keyStorage: "keytar";
	updatedAt: string | null;
	modelsCacheUpdatedAt: string | null;
};

export type CurrentProviderConfigStatus = {
	provider: ProviderId;
	displayName: string;
	configured: boolean;
	model: string;
	modelDisplayName: string;
	baseUrl: string;
	apiKeyMasked: string | null;
	keyStorage: "keytar";
	updatedAt: string | null;
};

export type ProviderModelSelectionProviderStatus = {
	provider: ProviderId;
	displayName: string;
	configured: boolean;
	selected: boolean;
	selectedModel: string | null;
	selectedModelDisplayName: string | null;
	defaultModel: string;
	baseUrl: string;
	apiKeyMasked: string | null;
	models: ProviderModelInfo[];
	modelsSource: "cache" | "fallback";
	modelsCacheUpdatedAt: string | null;
};

export type ProviderModelSelectionStatus = {
	activeModel: ModelRef;
	current: CurrentProviderConfigStatus;
	providers: ProviderModelSelectionProviderStatus[];
	modelRouting: ProviderModelRouting;
};

export type ProviderConfigStatus = {
	schemaVersion: 3;
	activeModel: ModelRef;
	activeProvider: ProviderId;
	current: CurrentProviderConfigStatus;
	providers: ProviderConfigProviderStatus[];
	modelRouting: ProviderModelRouting;
	provider: ProviderId;
	configured: boolean;
	model: string | null;
	baseUrl: string | null;
	apiKeyMasked: string | null;
	keyStorage: "keytar";
	configPath: string;
	updatedAt: string | null;
};

type ParsedStoredConfig = {
	config: StoredProviderConfig;
	migrated: boolean;
};

function normalizeOptionalString(value: string | undefined): string | undefined {
	const trimmed: string | undefined = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function getKeytarAccount(provider: ProviderId): string {
	return `provider:${provider}:api_key`;
}

function maskApiKey(apiKey: string | null): string | null {
	if (apiKey === null || apiKey.length === 0) {
		return null;
	}

	if (apiKey.length <= 8) {
		return "********";
	}

	return `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`;
}

function getModelDisplayName(models: readonly ProviderModelInfo[], modelId: string): string {
	return models.find((model: ProviderModelInfo): boolean => model.id === modelId)?.displayName ?? modelId;
}

function createModelRef(provider: ProviderId = DEFAULT_PROVIDER_ID, model?: string | undefined): ModelRef {
	return {
		providerId: provider,
		modelId: normalizeOptionalString(model) ?? getProviderDefaultModel(provider)
	};
}

function createEmptyStoredConfig(activeModel: ModelRef = createModelRef()): StoredProviderConfig {
	return {
		schemaVersion: 3,
		activeModel,
		providers: {},
		modelRouting: createEmptyModelRouting()
	};
}

export function createEmptyModelRouting(): ProviderModelRouting {
	return {
		imageRecognition: null,
		workflowPlanner: null,
		sessionTitle: null,
		imageGeneration: null
	};
}

function parseTaskModelRef(value: unknown): ProviderTaskModelRef | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	const provider: unknown = record.provider ?? record.providerId;
	const model: unknown = record.model ?? record.modelId;
	if (!isProviderId(provider) || typeof model !== "string" || model.trim().length === 0) {
		return null;
	}

	return {
		provider,
		model: model.trim()
	};
}

function parseModelRouting(value: unknown): ProviderModelRouting {
	const routing: ProviderModelRouting = createEmptyModelRouting();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return routing;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	routing.imageRecognition = parseTaskModelRef(record.imageRecognition);
	routing.workflowPlanner = parseTaskModelRef(record.workflowPlanner);
	routing.sessionTitle = parseTaskModelRef(record.sessionTitle);
	routing.imageGeneration = parseTaskModelRef(record.imageGeneration);
	return routing;
}

function mergeModelRouting(existing: ProviderModelRouting | undefined, input: ProviderModelRoutingInput | undefined): ProviderModelRouting {
	const routing: ProviderModelRouting = existing ?? createEmptyModelRouting();
	if (input === undefined) {
		return routing;
	}

	const next: ProviderModelRouting = { ...routing };
	for (const key of ["imageRecognition", "workflowPlanner", "sessionTitle", "imageGeneration"] as const) {
		if (!Object.prototype.hasOwnProperty.call(input, key)) {
			continue;
		}

		const value: ProviderTaskModelRef | null | undefined = input[key];
		if (value === null || value === undefined) {
			next[key] = null;
			continue;
		}

		if (!isProviderId(value.provider)) {
			throw new Error(`Invalid task model provider for ${key}: ${String(value.provider)}`);
		}
		const model: string = value.model.trim();
		if (model.length === 0) {
			throw new Error(`Invalid task model for ${key}: model is required`);
		}
		next[key] = {
			provider: value.provider,
			model
		};
	}
	return next;
}

function parseModelInfo(value: unknown): ProviderModelInfo | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	const provider: unknown = record.provider;
	const id: unknown = record.id;
	const displayName: unknown = record.displayName;
	const contextWindowTokens: unknown = record.contextWindowTokens;
	const maxOutputTokens: unknown = record.maxOutputTokens;
	if (!isProviderId(provider) || typeof id !== "string" || id.trim().length === 0) {
		return null;
	}
	if (typeof displayName !== "string" || displayName.trim().length === 0) {
		return null;
	}
	if (typeof contextWindowTokens !== "number" || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
		return null;
	}
	if (typeof maxOutputTokens !== "number" || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
		return null;
	}

	const fallback = getProviderFallbackModels(provider).find((model: ProviderModelInfo): boolean => model.id === id);
	const model: ProviderModelInfo = {
		id: id.trim(),
		displayName: displayName.trim(),
		provider,
		endpointType: fallback?.endpointType ?? "openai-chat-completions",
		contextWindowTokens: Math.floor(contextWindowTokens),
		maxOutputTokens: Math.floor(maxOutputTokens),
		capabilities: normalizeProviderModelCapabilities(typeof record.capabilities === "object" && record.capabilities !== null && !Array.isArray(record.capabilities)
			? record.capabilities as ProviderModelInfo["capabilities"]
			: {})
	};
	if (typeof record.endpointType === "string" && (record.endpointType === "openai-chat-completions" || record.endpointType === "openai-responses")) {
		model.endpointType = record.endpointType;
	}
	if (typeof record.ownedBy === "string") {
		model.ownedBy = record.ownedBy;
	}
	return model;
}

function parseModelsCache(value: unknown): StoredProviderModelsCache | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	if (!Array.isArray(record.models) || typeof record.updatedAt !== "string") {
		return undefined;
	}
	const models: ProviderModelInfo[] = record.models
		.map(parseModelInfo)
		.filter((model: ProviderModelInfo | null): model is ProviderModelInfo => model !== null);
	return models.length > 0 ? { models, updatedAt: record.updatedAt } : undefined;
}

function parseStoredEntry(value: unknown): StoredProviderEntry | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	const entry: StoredProviderEntry = {
		keyStorage: "keytar",
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : ""
	};

	if (typeof record.model === "string" && record.model.trim().length > 0) {
		entry.model = record.model.trim();
	}
	if (typeof record.baseUrl === "string" && record.baseUrl.trim().length > 0) {
		entry.baseUrl = record.baseUrl.trim();
	}
	const modelsCache: StoredProviderModelsCache | undefined = parseModelsCache(record.modelsCache);
	if (modelsCache !== undefined) {
		entry.modelsCache = modelsCache;
	}

	return entry;
}

function parseActiveModel(value: unknown, fallbackProvider?: ProviderId | undefined, fallbackModel?: string | undefined): ModelRef {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const record: Record<string, unknown> = value as Record<string, unknown>;
		const provider: unknown = record.providerId ?? record.provider;
		const model: unknown = record.modelId ?? record.model;
		if (isProviderId(provider) && typeof model === "string" && model.trim().length > 0) {
			return createModelRef(provider, model);
		}
	}

	return createModelRef(fallbackProvider ?? DEFAULT_PROVIDER_ID, fallbackModel);
}

function parseStoredProviderConfig(parsed: unknown): ParsedStoredConfig {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { config: createEmptyStoredConfig(), migrated: true };
	}

	const record: Record<string, unknown> = parsed as Record<string, unknown>;
	if (record.schemaVersion === 3) {
		const activeModel: ModelRef = parseActiveModel(record.activeModel);
		const config: StoredProviderConfig = createEmptyStoredConfig(activeModel);
		const providersValue: unknown = record.providers;
		if (typeof providersValue === "object" && providersValue !== null && !Array.isArray(providersValue)) {
			const providersRecord: Record<string, unknown> = providersValue as Record<string, unknown>;
			for (const provider of getProviderIds()) {
				const entry: StoredProviderEntry | undefined = parseStoredEntry(providersRecord[provider]);
				if (entry !== undefined) {
					config.providers[provider] = entry;
				}
			}
		}
		config.modelRouting = parseModelRouting(record.modelRouting);
		return { config, migrated: false };
	}

	// v2 只在这里迁移一次，后续写回 schemaVersion 3。
	const activeProvider: ProviderId = isProviderId(record.activeProvider) ? record.activeProvider : DEFAULT_PROVIDER_ID;
	const providersValue: unknown = record.providers;
	let activeModel: ModelRef = createModelRef(activeProvider);
	const config: StoredProviderConfig = createEmptyStoredConfig(activeModel);
	if (typeof providersValue === "object" && providersValue !== null && !Array.isArray(providersValue)) {
		const providersRecord: Record<string, unknown> = providersValue as Record<string, unknown>;
		for (const provider of getProviderIds()) {
			const entry: StoredProviderEntry | undefined = parseStoredEntry(providersRecord[provider]);
			if (entry !== undefined) {
				config.providers[provider] = entry;
				if (provider === activeProvider) {
					activeModel = createModelRef(provider, entry.model);
				}
			}
		}
	}
	config.activeModel = activeModel;
	config.modelRouting = parseModelRouting(record.modelRouting);
	return { config, migrated: true };
}

async function readStoredProviderConfig(): Promise<StoredProviderConfig> {
	const filePath: string = getProviderConfigPath();

	try {
		const raw: string = await readFile(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		const result: ParsedStoredConfig = parseStoredProviderConfig(parsed);
		if (result.migrated) {
			await writeStoredProviderConfig(result.config);
		}
		return result.config;
	} catch {
		return createEmptyStoredConfig();
	}
}

async function writeStoredProviderConfig(config: StoredProviderConfig): Promise<void> {
	const filePath: string = getProviderConfigPath();
	await writeJsonFileAtomic(filePath, config);
}

export async function saveProviderConfig(input: ProviderConfigInput): Promise<ProviderConfigStatus> {
	if (!isProviderId(input.provider)) {
		throw new Error(`Unknown provider: ${input.provider}`);
	}

	const apiKey: string | undefined = input.apiKey === null ? undefined : normalizeOptionalString(input.apiKey);
	if (input.apiKey === null) {
		await keytar.deletePassword(KEYTAR_SERVICE, getKeytarAccount(input.provider));
	}
	if (apiKey !== undefined) {
		await keytar.setPassword(KEYTAR_SERVICE, getKeytarAccount(input.provider), apiKey);
	}

	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const existing: StoredProviderEntry | undefined = stored.providers[input.provider];
	const entry: StoredProviderEntry = {
		keyStorage: "keytar",
		updatedAt: new Date().toISOString()
	};

	const model: string | undefined = normalizeOptionalString(input.model) ?? existing?.model ?? getProviderDefaultModel(input.provider);
	const baseUrl: string | undefined = input.baseUrl === null ? undefined : (normalizeOptionalString(input.baseUrl) ?? existing?.baseUrl);
	entry.model = model;
	if (baseUrl !== undefined && input.baseUrl !== null) {
		entry.baseUrl = baseUrl;
	}
	if (existing?.modelsCache !== undefined) {
		entry.modelsCache = existing.modelsCache;
	}

	stored.providers[input.provider] = entry;
	stored.modelRouting = mergeModelRouting(stored.modelRouting, input.modelRouting);
	if (input.activate !== false) {
		stored.activeModel = createModelRef(input.provider, model);
	}

	await writeStoredProviderConfig(stored);
	return getProviderConfigStatus();
}

export async function loadProviderConfigWithSecret(provider?: ProviderId | undefined): Promise<ProviderConfigWithSecret | null> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const activeProvider: ProviderId = provider ?? stored.activeModel.providerId;
	if (!isProviderId(activeProvider)) {
		return null;
	}
	const entry: StoredProviderEntry | undefined = stored.providers[activeProvider];
	const apiKey: string | null = await keytar.getPassword(KEYTAR_SERVICE, getKeytarAccount(activeProvider));

	if (entry === undefined && apiKey === null) {
		return null;
	}

	const result: ProviderConfigWithSecret = {
		provider: activeProvider,
		model: entry?.model ?? (activeProvider === stored.activeModel.providerId ? stored.activeModel.modelId : undefined),
		apiKey: apiKey ?? undefined
	};
	if (entry?.baseUrl !== undefined) {
		result.baseUrl = entry.baseUrl;
	}
	return result;
}

export async function getProviderConfigStatus(): Promise<ProviderConfigStatus> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const providers: ProviderConfigProviderStatus[] = [];

	for (const provider of getProviderIds()) {
		const entry: StoredProviderEntry | undefined = stored.providers[provider];
		const apiKey: string | null = await keytar.getPassword(KEYTAR_SERVICE, getKeytarAccount(provider));
		providers.push({
			provider,
			displayName: getProviderDisplayName(provider),
			configured: apiKey !== null,
			model: entry?.model ?? null,
			baseUrl: entry?.baseUrl ?? null,
			defaultModel: getProviderDefaultModel(provider),
			defaultBaseUrl: getProviderDefaultBaseUrl(provider),
			modelsCache: entry?.modelsCache?.models ?? [],
			fallbackModels: getProviderFallbackModels(provider),
			apiKeyMasked: maskApiKey(apiKey),
			keyStorage: "keytar",
			updatedAt: entry?.updatedAt ?? null,
			modelsCacheUpdatedAt: entry?.modelsCache?.updatedAt ?? null
		});
	}

	const activeStatus: ProviderConfigProviderStatus = providers.find((item: ProviderConfigProviderStatus): boolean => item.provider === stored.activeModel.providerId)
		?? providers[0]!;
	const activeModels: ProviderModelInfo[] = activeStatus.modelsCache.length > 0
		? mergeProviderModelsWithCatalog(activeStatus.provider, activeStatus.modelsCache)
		: [...activeStatus.fallbackModels];
	const current: CurrentProviderConfigStatus = {
		provider: activeStatus.provider,
		displayName: activeStatus.displayName,
		configured: activeStatus.configured,
		model: stored.activeModel.modelId,
		modelDisplayName: getModelDisplayName(activeModels, stored.activeModel.modelId),
		baseUrl: activeStatus.baseUrl ?? activeStatus.defaultBaseUrl,
		apiKeyMasked: activeStatus.apiKeyMasked,
		keyStorage: "keytar",
		updatedAt: activeStatus.updatedAt
	};

	return {
		schemaVersion: 3,
		activeModel: stored.activeModel,
		activeProvider: stored.activeModel.providerId,
		current,
		providers,
		modelRouting: stored.modelRouting,
		provider: activeStatus.provider,
		configured: activeStatus.configured,
		model: activeStatus.model,
		baseUrl: activeStatus.baseUrl,
		apiKeyMasked: activeStatus.apiKeyMasked,
		keyStorage: "keytar",
		configPath: getProviderConfigPath(),
		updatedAt: activeStatus.updatedAt
	};
}

export async function getProviderModelSelectionStatus(): Promise<ProviderModelSelectionStatus> {
	const status: ProviderConfigStatus = await getProviderConfigStatus();

	return {
		activeModel: status.activeModel,
		current: status.current,
		providers: status.providers.map((providerStatus: ProviderConfigProviderStatus): ProviderModelSelectionProviderStatus => {
			const modelsSource: "cache" | "fallback" = providerStatus.modelsCache.length > 0 ? "cache" : "fallback";
			const models: ProviderModelInfo[] = modelsSource === "cache"
				? mergeProviderModelsWithCatalog(providerStatus.provider, providerStatus.modelsCache)
				: [...providerStatus.fallbackModels];
			const selected: boolean = providerStatus.provider === status.activeModel.providerId;
			const selectedModel: string | null = selected
				? status.activeModel.modelId
				: providerStatus.model ?? null;

			return {
				provider: providerStatus.provider,
				displayName: providerStatus.displayName,
				configured: providerStatus.configured,
				selected,
				selectedModel,
				selectedModelDisplayName: selectedModel === null ? null : getModelDisplayName(models, selectedModel),
				defaultModel: providerStatus.defaultModel,
				baseUrl: providerStatus.baseUrl ?? providerStatus.defaultBaseUrl,
				apiKeyMasked: providerStatus.apiKeyMasked,
				models,
				modelsSource,
				modelsCacheUpdatedAt: providerStatus.modelsCacheUpdatedAt
			};
		}),
		modelRouting: status.modelRouting
	};
}

export async function clearProviderConfig(provider?: ProviderId | undefined): Promise<ProviderConfigStatus> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const providerToClear: ProviderId = provider ?? stored.activeModel.providerId;
	if (!isProviderId(providerToClear)) {
		throw new Error(`Unknown provider: ${providerToClear}`);
	}

	await keytar.deletePassword(KEYTAR_SERVICE, getKeytarAccount(providerToClear));
	delete stored.providers[providerToClear];

	if (Object.keys(stored.providers).length === 0) {
		await rm(getProviderConfigPath(), { force: true });
		return getProviderConfigStatus();
	}

	if (stored.activeModel.providerId === providerToClear) {
		const nextProvider: ProviderId = Object.keys(stored.providers).find(isProviderId) ?? DEFAULT_PROVIDER_ID;
		stored.activeModel = createModelRef(nextProvider, stored.providers[nextProvider]?.model);
	}

	await writeStoredProviderConfig(stored);
	return getProviderConfigStatus();
}

export async function getProviderModelsCache(provider: ProviderId): Promise<StoredProviderModelsCache | undefined> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	return stored.providers[provider]?.modelsCache;
}

export async function saveProviderModelsCache(provider: ProviderId, models: ProviderModelInfo[]): Promise<void> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const existing: StoredProviderEntry | undefined = stored.providers[provider];
	const entry: StoredProviderEntry = existing ?? {
		keyStorage: "keytar",
		updatedAt: new Date().toISOString(),
		model: getProviderDefaultModel(provider)
	};
	entry.modelsCache = {
		models,
		updatedAt: new Date().toISOString()
	};
	stored.providers[provider] = entry;
	await writeStoredProviderConfig(stored);
}
