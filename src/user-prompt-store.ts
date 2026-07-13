import { getUserPromptConfigPath } from "./app-paths.js";
import { readJsonFile, writeJsonFileAtomic } from "./json-file-store.js";

export type UserPromptConfig = {
	schemaVersion: 1;
	prompt: string;
	updatedAt: string;
};

const EMPTY_USER_PROMPT: UserPromptConfig = {
	schemaVersion: 1,
	prompt: "",
	updatedAt: ""
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePrompt(prompt: string): string {
	return prompt.trim();
}

export async function getUserPromptConfig(): Promise<UserPromptConfig> {
	const value: unknown = await readJsonFile<unknown>(getUserPromptConfigPath());
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.prompt !== "string") {
		return { ...EMPTY_USER_PROMPT };
	}

	return {
		schemaVersion: 1,
		prompt: normalizePrompt(value.prompt),
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
	};
}

export async function getUserPrompt(): Promise<string> {
	return (await getUserPromptConfig()).prompt;
}

export async function setUserPrompt(prompt: string): Promise<UserPromptConfig> {
	const config: UserPromptConfig = {
		schemaVersion: 1,
		prompt: normalizePrompt(prompt),
		updatedAt: new Date().toISOString()
	};
	await writeJsonFileAtomic(getUserPromptConfigPath(), config);
	return config;
}
