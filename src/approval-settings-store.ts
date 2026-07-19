import { getApprovalConfigPath } from "./app-paths.js";
import { readJsonFile, writeJsonFileAtomic } from "./json-file-store.js";
import type { ApprovalMode } from "./tools/tool-policy.js";

export type ApprovalSettings = {
	schemaVersion: 1;
	mode: ApprovalMode;
	updatedAt: string;
};

const DEFAULT_APPROVAL_MODE: ApprovalMode = "manual";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApprovalMode(value: unknown): value is ApprovalMode {
	return value === "manual" || value === "auto-safe" || value === "full-trust";
}

export async function getApprovalSettings(): Promise<ApprovalSettings> {
	const value: unknown = await readJsonFile<unknown>(getApprovalConfigPath());
	if (!isRecord(value) || value.schemaVersion !== 1 || !isApprovalMode(value.mode)) {
		return {
			schemaVersion: 1,
			mode: DEFAULT_APPROVAL_MODE,
			updatedAt: ""
		};
	}

	return {
		schemaVersion: 1,
		mode: value.mode,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
	};
}

export async function getApprovalMode(): Promise<ApprovalMode> {
	return (await getApprovalSettings()).mode;
}

export async function setApprovalMode(mode: ApprovalMode): Promise<ApprovalSettings> {
	const settings: ApprovalSettings = {
		schemaVersion: 1,
		mode,
		updatedAt: new Date().toISOString()
	};
	await writeJsonFileAtomic(getApprovalConfigPath(), settings);
	return settings;
}
