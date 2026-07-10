import { join } from "node:path";

const APP_DIR_NAME: string = ".godot_daedalus";
const DATA_V2_DIR_NAME: string = "v2";

export function getAppDataDir(): string {
	const windowsAppData: string | undefined = process.env.APPDATA;
	if (!windowsAppData || windowsAppData.trim().length === 0) {
		throw new Error("APPDATA is not configured");
	}

	return join(windowsAppData, APP_DIR_NAME);
}

export function getDefaultWorkspaceConfigPath(): string {
	return join(getAppDataDir(), "config", "workspaces.json");
}

export function getProviderConfigPath(): string {
	return join(getAppDataDir(), "config", "provider.json");
}

export function getMcpServersConfigPath(): string {
	return join(getAppDataDir(), "config", "mcp-servers.json");
}

export function getDefaultSessionsDir(): string {
	return join(getAppDataDir(), "data", DATA_V2_DIR_NAME, "sessions");
}

export function getDefaultArchivedSessionsDir(): string {
	return join(getAppDataDir(), "data", DATA_V2_DIR_NAME, "archived_sessions");
}

export function getToolExecutionLedgerPath(): string {
	return join(getAppDataDir(), "data", DATA_V2_DIR_NAME, "tool-executions.jsonl");
}
