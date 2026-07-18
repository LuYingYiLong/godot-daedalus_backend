import { getGeneralSettingsConfigPath } from "./app-paths.js";
import { readJsonFile, writeJsonFileAtomic } from "./json-file-store.js";

export type GeneralSettings = {
	schemaVersion: 1;
	autoExpandTodoList: boolean;
	updatedAt: string;
};

export type GeneralSettingsPatch = {
	autoExpandTodoList?: boolean | undefined;
};

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
	schemaVersion: 1,
	autoExpandTodoList: false,
	updatedAt: ""
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeGeneralSettings(value: unknown): GeneralSettings {
	if (!isRecord(value) || value.schemaVersion !== 1) {
		return { ...DEFAULT_GENERAL_SETTINGS };
	}

	return {
		schemaVersion: 1,
		autoExpandTodoList: typeof value.autoExpandTodoList === "boolean"
			? value.autoExpandTodoList
			: DEFAULT_GENERAL_SETTINGS.autoExpandTodoList,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
	};
}

export async function getGeneralSettings(): Promise<GeneralSettings> {
	return normalizeGeneralSettings(await readJsonFile<unknown>(getGeneralSettingsConfigPath()));
}

export async function updateGeneralSettings(patch: GeneralSettingsPatch): Promise<GeneralSettings> {
	const current: GeneralSettings = await getGeneralSettings();
	const settings: GeneralSettings = {
		schemaVersion: 1,
		autoExpandTodoList: patch.autoExpandTodoList ?? current.autoExpandTodoList,
		updatedAt: new Date().toISOString()
	};
	await writeJsonFileAtomic(getGeneralSettingsConfigPath(), settings);
	return settings;
}
