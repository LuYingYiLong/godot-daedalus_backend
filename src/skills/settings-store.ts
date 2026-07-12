import { readFile } from "node:fs/promises";
import { getSkillSettingsPath } from "../app-paths.js";
import { writeJsonFileAtomic } from "../json-file-store.js";
import type { SkillRef, SkillSource } from "./types.js";

type SkillSettings = {
	schemaVersion: 1;
	workspaces: Record<string, { enabledOverrides: Record<SkillRef, boolean> }>;
};

const EMPTY_SETTINGS: SkillSettings = { schemaVersion: 1, workspaces: {} };
let settingsWriteQueue: Promise<void> = Promise.resolve();

async function readSettings(): Promise<SkillSettings> {
	try {
		const value: unknown = JSON.parse(await readFile(getSkillSettingsPath(), "utf8"));
		if (typeof value !== "object" || value === null || (value as { schemaVersion?: unknown }).schemaVersion !== 1) {
			return structuredClone(EMPTY_SETTINGS);
		}
		return value as SkillSettings;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return structuredClone(EMPTY_SETTINGS);
		}
		throw error;
	}
}

async function writeSettings(settings: SkillSettings): Promise<void> {
	const filePath: string = getSkillSettingsPath();
	await writeJsonFileAtomic(filePath, settings);
}

export async function isSkillEnabled(workspaceId: string, ref: SkillRef, source: SkillSource): Promise<boolean> {
	const settings: SkillSettings = await readSettings();
	const override: boolean | undefined = settings.workspaces[workspaceId]?.enabledOverrides[ref];
	return override ?? source !== "personal";
}

export async function getWorkspaceSkillEnablement(workspaceId: string): Promise<Record<SkillRef, boolean>> {
	const settings: SkillSettings = await readSettings();
	return { ...(settings.workspaces[workspaceId]?.enabledOverrides ?? {}) };
}

export async function setSkillEnabled(workspaceId: string, ref: SkillRef, enabled: boolean): Promise<void> {
	const operation: Promise<void> = settingsWriteQueue.then(async (): Promise<void> => {
		const settings: SkillSettings = await readSettings();
		const workspace = settings.workspaces[workspaceId] ?? { enabledOverrides: {} };
		workspace.enabledOverrides[ref] = enabled;
		settings.workspaces[workspaceId] = workspace;
		await writeSettings(settings);
	});
	settingsWriteQueue = operation.catch((): void => undefined);
	await operation;
}
