import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import keytar from "keytar";
import { getMcpServersConfigPath } from "../app-paths.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import type { McpServerConfig } from "./types.js";

const KEYTAR_SERVICE: string = "Godot Daedalus";
const MCP_SECRET_PREFIX: string = "mcp";
const MAX_CUSTOM_MCP_SERVERS: number = 24;
const MAX_ARGUMENTS: number = 64;
const MAX_SECRET_NAMES: number = 64;

export type CustomMcpTransport = "stdio" | "http";

export type CustomMcpServerInput = {
	name: string;
	description?: string | undefined;
	transport: CustomMcpTransport;
	enabled?: boolean | undefined;
	command?: string | undefined;
	args?: string[] | undefined;
	env?: Record<string, string> | undefined;
	url?: string | undefined;
	headers?: Record<string, string> | undefined;
};

export type CustomMcpSecretUpdateRecord = Record<string, string | null | undefined>;

export type CustomMcpServerUpdateInput = {
	serverId: string;
	description?: string | undefined;
	transport: CustomMcpTransport;
	enabled?: boolean | undefined;
	command?: string | undefined;
	args?: string[] | undefined;
	env?: CustomMcpSecretUpdateRecord | undefined;
	url?: string | undefined;
	headers?: CustomMcpSecretUpdateRecord | undefined;
};

export type StoredCustomMcpServerConfig = {
	id: string;
	name: string;
	description: string;
	transport: CustomMcpTransport;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	command?: string | undefined;
	args?: string[] | undefined;
	envNames?: string[] | undefined;
	url?: string | undefined;
	headerNames?: string[] | undefined;
};

export type CustomMcpServerSummary = {
	id: string;
	name: string;
	description: string;
	transport: CustomMcpTransport;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	command: string | null;
	args: string[];
	envNames: string[];
	envMasked: Record<string, string>;
	url: string | null;
	headerNames: string[];
	headerMasked: Record<string, string>;
};

function normalizeText(value: string | undefined, maxLength: number): string {
	const trimmed: string = value?.trim() ?? "";
	return trimmed.slice(0, maxLength);
}

function slugify(value: string): string {
	const slug: string = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return slug.length > 0 ? slug : "server";
}

function createServerId(name: string): string {
	const hash: string = createHash("sha1")
		.update(`${name}\n${randomUUID()}`)
		.digest("hex")
		.slice(0, 8);
	return `custom-${slugify(name)}-${hash}`;
}

function normalizeArgs(args: string[] | undefined): string[] {
	if (args === undefined) {
		return [];
	}

	return args
		.map((value: string): string => value.trim())
		.filter((value: string): boolean => value.length > 0)
		.slice(0, MAX_ARGUMENTS);
}

function isWindowsCmdCommand(command: string): boolean {
	const normalizedCommand: string = command.replace(/\\/g, "/").toLowerCase();
	const fileName: string = normalizedCommand.split("/").pop() ?? normalizedCommand;
	return fileName === "cmd" || fileName === "cmd.exe";
}

function normalizeStdioArgsForCommand(command: string | undefined, args: string[]): string[] {
	if (command === undefined || process.platform !== "win32" || !isWindowsCmdCommand(command) || args.length === 0) {
		return args;
	}

	const firstArg: string = args[0]?.toLowerCase() ?? "";
	if (firstArg === "/c" || firstArg === "/k") {
		return args;
	}

	return ["/c", ...args];
}

function normalizeSecretRecord(value: Record<string, string> | undefined): Record<string, string> {
	if (value === undefined) {
		return {};
	}

	const result: Record<string, string> = {};
	for (const [rawName, rawSecretValue] of Object.entries(value).slice(0, MAX_SECRET_NAMES)) {
		const name: string = rawName.trim();
		if (name.length === 0) {
			continue;
		}

		result[name] = rawSecretValue;
	}
	return result;
}

function normalizeSecretUpdateRecord(value: CustomMcpSecretUpdateRecord | undefined): CustomMcpSecretUpdateRecord {
	if (value === undefined) {
		return {};
	}

	const result: CustomMcpSecretUpdateRecord = {};
	for (const [rawName, rawSecretValue] of Object.entries(value).slice(0, MAX_SECRET_NAMES)) {
		const name: string = rawName.trim();
		if (name.length === 0) {
			continue;
		}

		result[name] = rawSecretValue;
	}
	return result;
}

function secretAccount(serverId: string, kind: "env" | "header", name: string): string {
	return `${MCP_SECRET_PREFIX}:${serverId}:${kind}:${name}`;
}

function maskSecret(value: string | null): string {
	if (value === null || value.length === 0) {
		return "********";
	}

	if (value.length <= 8) {
		return "********";
	}

	return `${value.slice(0, 2)}...${value.slice(-4)}`;
}

function isStoredCustomMcpServerConfig(value: unknown): value is StoredCustomMcpServerConfig {
	if (value === null || typeof value !== "object") {
		return false;
	}

	const record: Partial<StoredCustomMcpServerConfig> = value as Partial<StoredCustomMcpServerConfig>;
	return typeof record.id === "string"
		&& record.id.startsWith("custom-")
		&& typeof record.name === "string"
		&& typeof record.description === "string"
		&& (record.transport === "stdio" || record.transport === "http")
		&& typeof record.enabled === "boolean"
		&& typeof record.createdAt === "string"
		&& typeof record.updatedAt === "string";
}

async function readStoredConfigs(): Promise<StoredCustomMcpServerConfig[]> {
	try {
		const raw: string = await readFile(getMcpServersConfigPath(), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}

		return parsed.filter(isStoredCustomMcpServerConfig);
	} catch {
		return [];
	}
}

async function writeStoredConfigs(configs: StoredCustomMcpServerConfig[]): Promise<void> {
	const filePath: string = getMcpServersConfigPath();
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, JSON.stringify(configs, null, 2), "utf8");
}

async function saveSecrets(serverId: string, kind: "env" | "header", values: Record<string, string>): Promise<string[]> {
	const names: string[] = [];
	for (const [name, secretValue] of Object.entries(values)) {
		await keytar.setPassword(KEYTAR_SERVICE, secretAccount(serverId, kind, name), secretValue);
		names.push(name);
	}
	return names.sort();
}

async function loadSecrets(serverId: string, kind: "env" | "header", names: readonly string[] | undefined): Promise<Record<string, string>> {
	const values: Record<string, string> = {};
	for (const name of names ?? []) {
		const value: string | null = await keytar.getPassword(KEYTAR_SERVICE, secretAccount(serverId, kind, name));
		if (value !== null) {
			values[name] = value;
		}
	}
	return values;
}

async function deleteSecrets(serverId: string, kind: "env" | "header", names: readonly string[] | undefined): Promise<void> {
	for (const name of names ?? []) {
		await keytar.deletePassword(KEYTAR_SERVICE, secretAccount(serverId, kind, name));
	}
}

async function updateSecrets(
	serverId: string,
	kind: "env" | "header",
	previousNames: readonly string[] | undefined,
	updates: CustomMcpSecretUpdateRecord | undefined
): Promise<string[]> {
	const normalizedUpdates: CustomMcpSecretUpdateRecord = normalizeSecretUpdateRecord(updates);
	const previousNameSet: Set<string> = new Set(previousNames ?? []);
	const nextNames: string[] = Object.keys(normalizedUpdates).sort();
	const nextNameSet: Set<string> = new Set(nextNames);

	for (const name of nextNames) {
		const secretValue: string | null | undefined = normalizedUpdates[name];
		if ((secretValue === null || secretValue === undefined || secretValue.length === 0) && !previousNameSet.has(name)) {
			throw new Error(`Secret value is required for new ${kind}: ${name}`);
		}
	}

	for (const previousName of previousNameSet) {
		if (!nextNameSet.has(previousName)) {
			await keytar.deletePassword(KEYTAR_SERVICE, secretAccount(serverId, kind, previousName));
		}
	}

	for (const name of nextNames) {
		const secretValue: string | null | undefined = normalizedUpdates[name];
		if (secretValue === null || secretValue === undefined || secretValue.length === 0) {
			continue;
		}

		await keytar.setPassword(KEYTAR_SERVICE, secretAccount(serverId, kind, name), secretValue);
	}

	return nextNames;
}

async function createMaskedSecrets(serverId: string, kind: "env" | "header", names: readonly string[] | undefined): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const name of names ?? []) {
		const value: string | null = await keytar.getPassword(KEYTAR_SERVICE, secretAccount(serverId, kind, name));
		result[name] = maskSecret(value);
	}
	return result;
}

function createStoredConfig(input: CustomMcpServerInput): StoredCustomMcpServerConfig {
	const name: string = normalizeText(input.name, 80);
	if (name.length === 0) {
		throw new Error("MCP server name is required");
	}

	const now: string = new Date().toISOString();
	const config: StoredCustomMcpServerConfig = {
		id: createServerId(name),
		name,
		description: normalizeText(input.description, 300),
		transport: input.transport,
		enabled: input.enabled ?? true,
		createdAt: now,
		updatedAt: now
	};

	if (input.transport === "stdio") {
		const command: string = normalizeText(input.command, 300);
		if (command.length === 0) {
			throw new Error("STDIO MCP server command is required");
		}

		config.command = command;
		const args: string[] = normalizeStdioArgsForCommand(command, normalizeArgs(input.args));
		if (args.length > 0) {
			config.args = args;
		}
		return config;
	}

	const urlText: string = normalizeText(input.url, 1000);
	if (urlText.length === 0) {
		throw new Error("HTTP MCP server URL is required");
	}

	try {
		const url: URL = new URL(urlText);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error("URL must use http or https");
		}
	} catch (error: unknown) {
		throw new Error(error instanceof Error ? error.message : "Invalid HTTP MCP server URL");
	}

	config.url = urlText;
	return config;
}

export async function addCustomMcpServerConfig(input: CustomMcpServerInput): Promise<CustomMcpServerSummary> {
	const configs: StoredCustomMcpServerConfig[] = await readStoredConfigs();
	if (configs.length >= MAX_CUSTOM_MCP_SERVERS) {
		throw new Error(`Custom MCP server limit reached: ${MAX_CUSTOM_MCP_SERVERS}`);
	}

	const config: StoredCustomMcpServerConfig = createStoredConfig(input);
	if (config.transport === "stdio") {
		const env: Record<string, string> = normalizeSecretRecord(input.env);
		const envNames: string[] = await saveSecrets(config.id, "env", env);
		if (envNames.length > 0) {
			config.envNames = envNames;
		}
	} else {
		const headers: Record<string, string> = normalizeSecretRecord(input.headers);
		const headerNames: string[] = await saveSecrets(config.id, "header", headers);
		if (headerNames.length > 0) {
			config.headerNames = headerNames;
		}
	}

	configs.push(config);
	await writeStoredConfigs(configs);
	return createCustomMcpServerSummary(config);
}

export async function updateCustomMcpServerConfig(input: CustomMcpServerUpdateInput): Promise<CustomMcpServerSummary | null> {
	const configs: StoredCustomMcpServerConfig[] = await readStoredConfigs();
	const index: number = configs.findIndex((config: StoredCustomMcpServerConfig): boolean => config.id === input.serverId);
	if (index < 0) {
		return null;
	}

	const current: StoredCustomMcpServerConfig = configs[index]!;
	const updated: StoredCustomMcpServerConfig = {
		id: current.id,
		name: current.name,
		description: normalizeText(input.description ?? current.description, 300),
		transport: input.transport,
		enabled: input.enabled ?? current.enabled,
		createdAt: current.createdAt,
		updatedAt: new Date().toISOString()
	};

	if (input.transport === "stdio") {
		const command: string = normalizeText(input.command, 300);
		if (command.length === 0) {
			throw new Error("STDIO MCP server command is required");
		}

		updated.command = command;
		const args: string[] = normalizeStdioArgsForCommand(command, normalizeArgs(input.args));
		if (args.length > 0) {
			updated.args = args;
		}

		const envNames: string[] = await updateSecrets(current.id, "env", current.envNames, input.env);
		await deleteSecrets(current.id, "header", current.headerNames);
		if (envNames.length > 0) {
			updated.envNames = envNames;
		}
	} else {
		const urlText: string = normalizeText(input.url, 1000);
		if (urlText.length === 0) {
			throw new Error("HTTP MCP server URL is required");
		}

		try {
			const url: URL = new URL(urlText);
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new Error("URL must use http or https");
			}
		} catch (error: unknown) {
			throw new Error(error instanceof Error ? error.message : "Invalid HTTP MCP server URL");
		}

		updated.url = urlText;
		const headerNames: string[] = await updateSecrets(current.id, "header", current.headerNames, input.headers);
		await deleteSecrets(current.id, "env", current.envNames);
		if (headerNames.length > 0) {
			updated.headerNames = headerNames;
		}
	}

	configs[index] = updated;
	await writeStoredConfigs(configs);
	return createCustomMcpServerSummary(updated);
}

export async function removeCustomMcpServerConfig(serverId: string): Promise<boolean> {
	const configs: StoredCustomMcpServerConfig[] = await readStoredConfigs();
	const index: number = configs.findIndex((config: StoredCustomMcpServerConfig): boolean => config.id === serverId);
	if (index < 0) {
		return false;
	}

	const [removed] = configs.splice(index, 1);
	if (removed !== undefined) {
		await deleteSecrets(removed.id, "env", removed.envNames);
		await deleteSecrets(removed.id, "header", removed.headerNames);
	}
	await writeStoredConfigs(configs);
	return true;
}

export async function setCustomMcpServerEnabled(serverId: string, enabled: boolean): Promise<boolean> {
	const configs: StoredCustomMcpServerConfig[] = await readStoredConfigs();
	const config: StoredCustomMcpServerConfig | undefined = configs.find((item: StoredCustomMcpServerConfig): boolean => item.id === serverId);
	if (config === undefined) {
		return false;
	}

	config.enabled = enabled;
	config.updatedAt = new Date().toISOString();
	await writeStoredConfigs(configs);
	return true;
}

export async function listStoredCustomMcpServerConfigs(): Promise<StoredCustomMcpServerConfig[]> {
	return readStoredConfigs();
}

export async function listCustomMcpServerSummaries(): Promise<CustomMcpServerSummary[]> {
	const configs: StoredCustomMcpServerConfig[] = await readStoredConfigs();
	const summaries: CustomMcpServerSummary[] = [];
	for (const config of configs) {
		summaries.push(await createCustomMcpServerSummary(config));
	}
	return summaries;
}

export async function buildCustomMcpServerConfigs(workspace: WorkspaceConfig): Promise<McpServerConfig[]> {
	const configs: StoredCustomMcpServerConfig[] = await readStoredConfigs();
	const result: McpServerConfig[] = [];

	for (const config of configs) {
		if (!config.enabled) {
			continue;
		}

		if (config.transport === "stdio") {
			const env: Record<string, string> = {
				BACKEND_DIR: process.cwd(),
				GODOT_PROJECT_PATH: workspace.rootPath
			};
			if (workspace.godotExecutablePath !== undefined) {
				env.GODOT_EXECUTABLE_PATH = workspace.godotExecutablePath;
			}

			Object.assign(env, await loadSecrets(config.id, "env", config.envNames));
			result.push({
				id: config.id,
				name: config.name,
				description: config.description,
				transport: "stdio",
				command: config.command,
				args: normalizeStdioArgsForCommand(config.command, config.args ?? []),
				env,
				custom: true
			});
			continue;
		}

		result.push({
			id: config.id,
			name: config.name,
			description: config.description,
			transport: "http",
			url: config.url,
			headers: await loadSecrets(config.id, "header", config.headerNames),
			custom: true
		});
	}

	return result;
}

async function createCustomMcpServerSummary(config: StoredCustomMcpServerConfig): Promise<CustomMcpServerSummary> {
	return {
		id: config.id,
		name: config.name,
		description: config.description,
		transport: config.transport,
		enabled: config.enabled,
		createdAt: config.createdAt,
		updatedAt: config.updatedAt,
		command: config.command ?? null,
		args: normalizeStdioArgsForCommand(config.command, config.args ?? []),
		envNames: config.envNames ?? [],
		envMasked: await createMaskedSecrets(config.id, "env", config.envNames),
		url: config.url ?? null,
		headerNames: config.headerNames ?? [],
		headerMasked: await createMaskedSecrets(config.id, "header", config.headerNames)
	};
}
