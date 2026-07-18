import { getWebSearchSettingsConfigPath } from "./app-paths.js";
import { readJsonFile, writeJsonFileAtomic } from "./json-file-store.js";
import type { ProviderId } from "./protocol/types.js";
import {
	getCatalogModel,
	getProviderDefaultBaseUrl,
	getProviderDisplayName,
	getProviderFallbackModels,
	isProviderId,
	type ProviderModelInfo
} from "./providers/provider-registry.js";
import { loadProviderConfigWithSecret } from "./providers/provider-config-store.js";

export type WebSearchSettings = {
	schemaVersion: 1;
	enabled: boolean;
	provider: ProviderId;
	model: string;
	updatedAt: string;
};

export type WebSearchSettingsPatch = {
	enabled?: boolean | undefined;
	provider?: ProviderId | undefined;
	model?: string | undefined;
};

export type WebSearchModelOption = {
	provider: ProviderId;
	providerDisplayName: string;
	model: string;
	modelDisplayName: string;
	configured: boolean;
	apiKeyMasked: string | null;
	baseUrl: string;
	contextWindowTokens: number;
	maxOutputTokens: number;
};

export type WebSearchSettingsStatus = WebSearchSettings & {
	available: boolean;
	configured: boolean;
	selectedSupported: boolean;
	apiKeyMasked: string | null;
	models: WebSearchModelOption[];
};

export type WebSearchRuntimeConfig = {
	provider: ProviderId;
	model: string;
	apiKey: string;
	baseUrl?: string | undefined;
};

const SUPPORTED_WEB_SEARCH_PROVIDERS: ReadonlySet<ProviderId> = new Set(["zhipu"]);
const FALLBACK_PROVIDER: ProviderId = "zhipu";
const FALLBACK_MODEL: string = "glm-5.2";

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
	schemaVersion: 1,
	enabled: false,
	provider: FALLBACK_PROVIDER,
	model: FALLBACK_MODEL,
	updatedAt: ""
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maskApiKey(apiKey: string | undefined): string | null {
	if (apiKey === undefined || apiKey.length === 0) {
		return null;
	}
	if (apiKey.length <= 8) {
		return "********";
	}
	return `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`;
}

export function isProviderNativeWebSearchProvider(provider: ProviderId): boolean {
	return SUPPORTED_WEB_SEARCH_PROVIDERS.has(provider);
}

export function isProviderNativeWebSearchModel(provider: ProviderId, model: string): boolean {
	if (!isProviderNativeWebSearchProvider(provider)) {
		return false;
	}
	const catalogModel: ProviderModelInfo | undefined = getCatalogModel(provider, model);
	return catalogModel?.capabilities.webSearch === true;
}

function getDefaultSearchModel(provider: ProviderId): string {
	const model: ProviderModelInfo | undefined = getProviderFallbackModels(provider)
		.find((item: ProviderModelInfo): boolean => item.capabilities.webSearch === true);
	return model?.id ?? (provider === FALLBACK_PROVIDER ? FALLBACK_MODEL : DEFAULT_WEB_SEARCH_SETTINGS.model);
}

function normalizeSearchProvider(value: unknown): ProviderId {
	if (isProviderId(value) && isProviderNativeWebSearchProvider(value)) {
		return value;
	}
	return DEFAULT_WEB_SEARCH_SETTINGS.provider;
}

export function normalizeWebSearchSettings(value: unknown): WebSearchSettings {
	if (!isRecord(value) || value.schemaVersion !== 1) {
		return { ...DEFAULT_WEB_SEARCH_SETTINGS };
	}

	const provider: ProviderId = normalizeSearchProvider(value.provider);
	const requestedModel: string | undefined = typeof value.model === "string" && value.model.trim().length > 0
		? value.model.trim()
		: undefined;
	const model: string = requestedModel !== undefined && isProviderNativeWebSearchModel(provider, requestedModel)
		? requestedModel
		: getDefaultSearchModel(provider);

	return {
		schemaVersion: 1,
		enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_WEB_SEARCH_SETTINGS.enabled,
		provider,
		model,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
	};
}

export async function getWebSearchSettings(): Promise<WebSearchSettings> {
	return normalizeWebSearchSettings(await readJsonFile<unknown>(getWebSearchSettingsConfigPath()));
}

function validateSettings(settings: WebSearchSettings): void {
	if (!isProviderNativeWebSearchProvider(settings.provider)) {
		throw new Error(`Provider does not support Daedalus web search: ${settings.provider}`);
	}
	if (!isProviderNativeWebSearchModel(settings.provider, settings.model)) {
		throw new Error(`Model does not support Daedalus web search: ${settings.provider}/${settings.model}`);
	}
}

export async function updateWebSearchSettings(patch: WebSearchSettingsPatch): Promise<WebSearchSettingsStatus> {
	const current: WebSearchSettings = await getWebSearchSettings();
	const provider: ProviderId = patch.provider ?? current.provider;
	if (!isProviderId(provider)) {
		throw new Error(`Unknown provider: ${String(provider)}`);
	}
	if (!isProviderNativeWebSearchProvider(provider)) {
		throw new Error(`Provider does not support Daedalus web search: ${provider}`);
	}

	const model: string = patch.model?.trim() ?? (patch.provider !== undefined && patch.provider !== current.provider
		? getDefaultSearchModel(provider)
		: current.model);
	const next: WebSearchSettings = {
		schemaVersion: 1,
		enabled: patch.enabled ?? current.enabled,
		provider,
		model,
		updatedAt: new Date().toISOString()
	};
	validateSettings(next);
	await writeJsonFileAtomic(getWebSearchSettingsConfigPath(), next);
	return getWebSearchSettingsStatus();
}

export async function getWebSearchSettingsStatus(): Promise<WebSearchSettingsStatus> {
	const settings: WebSearchSettings = await getWebSearchSettings();
	const models: WebSearchModelOption[] = [];
	let configured: boolean = false;
	let apiKeyMasked: string | null = null;

	for (const provider of SUPPORTED_WEB_SEARCH_PROVIDERS) {
		const config = await loadProviderConfigWithSecret(provider);
		const providerConfigured: boolean = config?.apiKey !== undefined;
		for (const model of getProviderFallbackModels(provider)) {
			if (model.capabilities.webSearch !== true) {
				continue;
			}
			models.push({
				provider,
				providerDisplayName: getProviderDisplayName(provider),
				model: model.id,
				modelDisplayName: model.displayName,
				configured: providerConfigured,
				apiKeyMasked: maskApiKey(config?.apiKey),
				baseUrl: config?.baseUrl ?? getProviderDefaultBaseUrl(provider),
				contextWindowTokens: model.contextWindowTokens,
				maxOutputTokens: model.maxOutputTokens
			});
		}

		if (provider === settings.provider) {
			configured = providerConfigured;
			apiKeyMasked = maskApiKey(config?.apiKey);
		}
	}

	const selectedSupported: boolean = isProviderNativeWebSearchModel(settings.provider, settings.model);
	return {
		...settings,
		available: settings.enabled && configured && selectedSupported,
		configured,
		selectedSupported,
		apiKeyMasked,
		models
	};
}

export async function resolveWebSearchRuntimeConfig(): Promise<WebSearchRuntimeConfig | null> {
	const settings: WebSearchSettings = await getWebSearchSettings();
	if (!settings.enabled || !isProviderNativeWebSearchModel(settings.provider, settings.model)) {
		return null;
	}

	const config = await loadProviderConfigWithSecret(settings.provider);
	if (config?.apiKey === undefined || config.apiKey.length === 0) {
		return null;
	}

	return {
		provider: settings.provider,
		model: settings.model,
		apiKey: config.apiKey,
		baseUrl: config.baseUrl
	};
}

export async function isWebSearchToolAvailable(): Promise<boolean> {
	try {
		return (await resolveWebSearchRuntimeConfig()) !== null;
	} catch {
		return false;
	}
}
