import { join } from "node:path";

const DAEDALUS_DIR_NAME: string = ".daedalus";

export function getDaedalusDir(): string {
	const userProfile: string | undefined = process.env.USERPROFILE;
	if (!userProfile || userProfile.trim().length === 0) {
		throw new Error("USERPROFILE is not configured");
	}

	return join(userProfile, DAEDALUS_DIR_NAME);
}

export function getDefaultWorkspaceConfigPath(): string {
	return join(getDaedalusDir(), "config", "workspaces.json");
}

export function getProviderConfigPath(): string {
	return join(getDaedalusDir(), "config", "provider.json");
}

export function getMcpServersConfigPath(): string {
	return join(getDaedalusDir(), "config", "mcp-servers.json");
}

export function getPersonalSkillsDir(): string {
	return join(getDaedalusDir(), "skills");
}

export function getSkillSettingsPath(): string {
	return join(getDaedalusDir(), "config", "skill-settings.json");
}

export function getDefaultSessionsDir(): string {
	return join(getDaedalusDir(), "sessions");
}

export function getDefaultArchivedSessionsDir(): string {
	return join(getDaedalusDir(), "archived_sessions");
}

export function getToolExecutionLedgerPath(): string {
	return join(getDaedalusDir(), "tool-executions.jsonl");
}
