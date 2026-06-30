import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import keytar from "keytar";
import { getProviderConfigPath } from "../app-paths.js";

const KEYTAR_SERVICE: string = "Godot Daedalus";
const DEEPSEEK_ACCOUNT: string = "deepseek_api_key";

export type ProviderConfigInput = {
	provider: "deepseek";
	apiKey?: string | undefined;
	model?: string | undefined;
	baseUrl?: string | undefined;
};

export type StoredProviderConfig = {
	provider: "deepseek";
	model?: string | undefined;
	baseUrl?: string | undefined;
	keyStorage: "keytar";
	updatedAt: string;
};

export type ProviderConfigWithSecret = StoredProviderConfig & {
	apiKey?: string | undefined;
};

export type ProviderConfigStatus = {
	provider: "deepseek";
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

function maskApiKey(apiKey: string | null): string | null {
	if (apiKey === null || apiKey.length === 0) {
		return null;
	}

	if (apiKey.length <= 8) {
		return "********";
	}

	return `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`;
}

async function readStoredProviderConfig(): Promise<StoredProviderConfig | null> {
	const filePath: string = getProviderConfigPath();

	try {
		const raw: string = await readFile(filePath, "utf8");
		const parsed: unknown = JSON.parse(raw);

		if (typeof parsed !== "object" || parsed === null) {
			return null;
		}

		const record: Record<string, unknown> = parsed as Record<string, unknown>;
		if (record.provider !== "deepseek") {
			return null;
		}

		const config: StoredProviderConfig = {
			provider: "deepseek",
			keyStorage: "keytar",
			updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : ""
		};

		if (typeof record.model === "string" && record.model.trim().length > 0) {
			config.model = record.model.trim();
		}

		if (typeof record.baseUrl === "string" && record.baseUrl.trim().length > 0) {
			config.baseUrl = record.baseUrl.trim();
		}

		return config;
	} catch {
		return null;
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
		await keytar.setPassword(KEYTAR_SERVICE, DEEPSEEK_ACCOUNT, apiKey);
	}

	const existing: StoredProviderConfig | null = await readStoredProviderConfig();
	const config: StoredProviderConfig = {
		provider: "deepseek",
		keyStorage: "keytar",
		updatedAt: new Date().toISOString()
	};

	const model: string | undefined = normalizeOptionalString(input.model) ?? existing?.model;
	const baseUrl: string | undefined = normalizeOptionalString(input.baseUrl) ?? existing?.baseUrl;

	if (model !== undefined) {
		config.model = model;
	}

	if (baseUrl !== undefined) {
		config.baseUrl = baseUrl;
	}

	await writeStoredProviderConfig(config);
	return getProviderConfigStatus();
}

export async function loadProviderConfigWithSecret(): Promise<ProviderConfigWithSecret | null> {
	const stored: StoredProviderConfig | null = await readStoredProviderConfig();
	const apiKey: string | null = await keytar.getPassword(KEYTAR_SERVICE, DEEPSEEK_ACCOUNT);

	if (stored === null && apiKey === null) {
		return null;
	}

	return {
		provider: "deepseek",
		keyStorage: "keytar",
		updatedAt: stored?.updatedAt ?? "",
		model: stored?.model,
		baseUrl: stored?.baseUrl,
		apiKey: apiKey ?? undefined
	};
}

export async function getProviderConfigStatus(): Promise<ProviderConfigStatus> {
	const stored: StoredProviderConfig | null = await readStoredProviderConfig();
	const apiKey: string | null = await keytar.getPassword(KEYTAR_SERVICE, DEEPSEEK_ACCOUNT);

	return {
		provider: "deepseek",
		configured: apiKey !== null,
		model: stored?.model ?? null,
		baseUrl: stored?.baseUrl ?? null,
		apiKeyMasked: maskApiKey(apiKey),
		keyStorage: "keytar",
		configPath: getProviderConfigPath(),
		updatedAt: stored?.updatedAt ?? null
	};
}

export async function clearProviderConfig(): Promise<ProviderConfigStatus> {
	await keytar.deletePassword(KEYTAR_SERVICE, DEEPSEEK_ACCOUNT);
	await rm(getProviderConfigPath(), { force: true });
	return getProviderConfigStatus();
}
