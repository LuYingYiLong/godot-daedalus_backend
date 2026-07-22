import { getUserPromptConfigPath } from "./app-paths.js";
import { readJsonFile, writeJsonFileAtomic } from "./json-file-store.js";

export type UserPromptConfig = {
	schemaVersion: 1;
	prompt: string;
	updatedAt: string;
	gitCommitPrompt: string;
	gitCommitUpdatedAt: string;
};

export type UserPromptConfigPatch = {
	prompt?: string | undefined;
	gitCommitPrompt?: string | undefined;
};

const EMPTY_USER_PROMPT: UserPromptConfig = {
	schemaVersion: 1,
	prompt: "",
	updatedAt: "",
	gitCommitPrompt: "",
	gitCommitUpdatedAt: ""
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
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
		gitCommitPrompt: typeof value.gitCommitPrompt === "string" ? normalizePrompt(value.gitCommitPrompt) : "",
		gitCommitUpdatedAt: typeof value.gitCommitUpdatedAt === "string" ? value.gitCommitUpdatedAt : ""
	};
}

export async function getUserPrompt(): Promise<string> {
	return (await getUserPromptConfig()).prompt;
}

export async function getGitCommitPrompt(): Promise<string> {
	return (await getUserPromptConfig()).gitCommitPrompt;
}

export async function setUserPromptConfig(patch: UserPromptConfigPatch): Promise<UserPromptConfig> {
	const current: UserPromptConfig = await getUserPromptConfig();
	const now: string = new Date().toISOString();
	const config: UserPromptConfig = {
		schemaVersion: 1,
		prompt: patch.prompt === undefined ? current.prompt : normalizePrompt(patch.prompt),
		updatedAt: patch.prompt === undefined ? current.updatedAt : now,
		gitCommitPrompt: patch.gitCommitPrompt === undefined ? current.gitCommitPrompt : normalizePrompt(patch.gitCommitPrompt),
		gitCommitUpdatedAt: patch.gitCommitPrompt === undefined ? current.gitCommitUpdatedAt : now
	};
	await writeJsonFileAtomic(getUserPromptConfigPath(), config);
	return config;
}

export async function setUserPrompt(prompt: string): Promise<UserPromptConfig> {
	return setUserPromptConfig({ prompt });
}
