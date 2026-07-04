import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import keytar from "keytar";
import { getProviderConfigPath } from "../app-paths.js";
import type { ProviderId } from "../protocol/types.js";
import {
	DEFAULT_PROVIDER_ID,
	getProviderDefaultBaseUrl,
	getProviderDefaultModel,
	getProviderDisplayName,
	getProviderIds,
	isProviderId,
	type ProviderModelInfo
} from "./provider-registry.js";

const KEYTAR_SERVICE: string = "Godot Daedalus";

export type ProviderConfigInput = {
	provider: ProviderId;
	apiKey?: string | undefined;
	model?: string | undefined;
	baseUrl?: string | undefined;
	activate?: boolean | undefined;
};

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
	schemaVersion: 2;
	activeProvider: ProviderId;
	providers: Partial<Record<ProviderId, StoredProviderEntry>>;
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
	apiKeyMasked: string | null;
	keyStorage: "keytar";
	updatedAt: string | null;
	modelsCacheUpdatedAt: string | null;
};

export type ProviderConfigStatus = {
	activeProvider: ProviderId;
	providers: ProviderConfigProviderStatus[];
	provider: ProviderId;
	configured: boolean;
	model: string | null;
	baseUrl: string | null;
	apiKeyMasked: string | null;
	keyStorage: "keytar";
	configPath: string;
	updatedAt: string | null;
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

function createEmptyStoredConfig(activeProvider: ProviderId = DEFAULT_PROVIDER_ID): StoredProviderConfig {
	return {
		schemaVersion: 2,
		activeProvider,
		providers: {}
	};
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
	if (isModelsCache(record.modelsCache)) {
		entry.modelsCache = record.modelsCache;
	}

	return entry;
}

function isModelsCache(value: unknown): value is StoredProviderModelsCache {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	const record: Record<string, unknown> = value as Record<string, unknown>;
	return Array.isArray(record.models) && typeof record.updatedAt === "string";
}

function parseStoredProviderConfig(parsed: unknown): StoredProviderConfig | null {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}

	const record: Record<string, unknown> = parsed as Record<string, unknown>;
	if (record.schemaVersion === 2) {
		const activeProvider: ProviderId = isProviderId(record.activeProvider) ? record.activeProvider : DEFAULT_PROVIDER_ID;
		const config: StoredProviderConfig = createEmptyStoredConfig(activeProvider);
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

		return config;
	}

	return null;
}

async function readStoredProviderConfig(): Promise<StoredProviderConfig> {
	const filePath: string = getProviderConfigPath();

	try {
		const raw: string = await readFile(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		return parseStoredProviderConfig(parsed) ?? createEmptyStoredConfig();
	} catch {
		return createEmptyStoredConfig();
	}
}

async function writeStoredProviderConfig(config: StoredProviderConfig): Promise<void> {
	const filePath: string = getProviderConfigPath();
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
}

export async function saveProviderConfig(input: ProviderConfigInput): Promise<ProviderConfigStatus> {
	const apiKey: string | undefined = normalizeOptionalString(input.apiKey);
	if (apiKey !== undefined) {
		await keytar.setPassword(KEYTAR_SERVICE, getKeytarAccount(input.provider), apiKey);
	}

	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const existing: StoredProviderEntry | undefined = stored.providers[input.provider];
	const entry: StoredProviderEntry = {
		keyStorage: "keytar",
		updatedAt: new Date().toISOString()
	};

	const model: string | undefined = normalizeOptionalString(input.model) ?? existing?.model;
	const baseUrl: string | undefined = normalizeOptionalString(input.baseUrl) ?? existing?.baseUrl;
	if (model !== undefined) {
		entry.model = model;
	}
	if (baseUrl !== undefined) {
		entry.baseUrl = baseUrl;
	}
	if (existing?.modelsCache !== undefined) {
		entry.modelsCache = existing.modelsCache;
	}

	stored.providers[input.provider] = entry;
	if (input.activate !== false) {
		stored.activeProvider = input.provider;
	}

	await writeStoredProviderConfig(stored);
	return getProviderConfigStatus();
}

export async function loadProviderConfigWithSecret(provider?: ProviderId | undefined): Promise<ProviderConfigWithSecret | null> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const activeProvider: ProviderId = provider ?? stored.activeProvider;
	const entry: StoredProviderEntry | undefined = stored.providers[activeProvider];
	const apiKey: string | null = await keytar.getPassword(KEYTAR_SERVICE, getKeytarAccount(activeProvider));

	if (entry === undefined && apiKey === null) {
		return null;
	}

	return {
		provider: activeProvider,
		model: entry?.model,
		baseUrl: entry?.baseUrl,
		apiKey: apiKey ?? undefined
	};
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
			apiKeyMasked: maskApiKey(apiKey),
			keyStorage: "keytar",
			updatedAt: entry?.updatedAt ?? null,
			modelsCacheUpdatedAt: entry?.modelsCache?.updatedAt ?? null
		});
	}

	const activeStatus: ProviderConfigProviderStatus = providers.find((item: ProviderConfigProviderStatus): boolean => item.provider === stored.activeProvider)
		?? providers[0]!;

	return {
		activeProvider: stored.activeProvider,
		providers,
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

export async function clearProviderConfig(provider?: ProviderId | undefined): Promise<ProviderConfigStatus> {
	const stored: StoredProviderConfig = await readStoredProviderConfig();
	const providerToClear: ProviderId = provider ?? stored.activeProvider;
	await keytar.deletePassword(KEYTAR_SERVICE, getKeytarAccount(providerToClear));
	delete stored.providers[providerToClear];

	if (Object.keys(stored.providers).length === 0) {
		await rm(getProviderConfigPath(), { force: true });
		return getProviderConfigStatus();
	}

	if (stored.activeProvider === providerToClear) {
		stored.activeProvider = DEFAULT_PROVIDER_ID;
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
		updatedAt: new Date().toISOString()
	};
	entry.modelsCache = {
		models,
		updatedAt: new Date().toISOString()
	};
	stored.providers[provider] = entry;
	await writeStoredProviderConfig(stored);
}
