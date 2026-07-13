import { join } from "node:path";

const DAEDALUS_DIR_NAME: string = ".daedalus";

export type DaedalusPathKey =
	| "config.workspaces"
	| "config.provider"
	| "config.mcpServers"
	| "config.skillSettings"
	| "config.userPrompt"
	| "config.approval"
	| "skills.root"
	| "sessions.activeRoot"
	| "sessions.archivedRoot"
	| "logs.root"
	| "terminalJobs.root"
	| "toolExecution.ledger";

type DaedalusPathRegistry = Record<DaedalusPathKey, string>;

export function getDaedalusDir(): string {
	const userProfile: string | undefined = process.env.USERPROFILE;
	if (!userProfile || userProfile.trim().length === 0) {
		throw new Error("USERPROFILE is not configured");
	}

	return join(userProfile, DAEDALUS_DIR_NAME);
}

function buildDaedalusPathRegistry(): DaedalusPathRegistry {
	const root: string = getDaedalusDir();
	const configRoot: string = join(root, "config");
	return {
		"config.workspaces": join(configRoot, "workspaces.json"),
		"config.provider": join(configRoot, "provider.json"),
		"config.mcpServers": join(configRoot, "mcp-servers.json"),
		"config.skillSettings": join(configRoot, "skill-settings.json"),
		"config.userPrompt": join(configRoot, "user-prompt.json"),
		"config.approval": join(configRoot, "approval.json"),
		"skills.root": join(root, "skills"),
		"sessions.activeRoot": join(root, "sessions"),
		"sessions.archivedRoot": join(root, "archived_sessions"),
		"logs.root": join(root, "logs"),
		"terminalJobs.root": join(root, "terminal-jobs"),
		"toolExecution.ledger": join(root, "tool-executions.jsonl")
	};
}

export function getDaedalusPath(key: DaedalusPathKey): string {
	return buildDaedalusPathRegistry()[key];
}

export function getDefaultWorkspaceConfigPath(): string {
	return getDaedalusPath("config.workspaces");
}

export function getProviderConfigPath(): string {
	return getDaedalusPath("config.provider");
}

export function getMcpServersConfigPath(): string {
	return getDaedalusPath("config.mcpServers");
}

export function getPersonalSkillsDir(): string {
	return getDaedalusPath("skills.root");
}

export function getSkillSettingsPath(): string {
	return getDaedalusPath("config.skillSettings");
}

export function getUserPromptConfigPath(): string {
	return getDaedalusPath("config.userPrompt");
}

export function getApprovalConfigPath(): string {
	return getDaedalusPath("config.approval");
}

export function getDefaultSessionsDir(): string {
	return getDaedalusPath("sessions.activeRoot");
}

export function getDefaultArchivedSessionsDir(): string {
	return getDaedalusPath("sessions.archivedRoot");
}

export function getLogsDir(): string {
	return getDaedalusPath("logs.root");
}

export function getTerminalJobsDir(): string {
	return getDaedalusPath("terminalJobs.root");
}

export function getToolExecutionLedgerPath(): string {
	return getDaedalusPath("toolExecution.ledger");
}
