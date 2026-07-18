import assert from "node:assert/strict";
import test from "node:test";
import {
	getDaedalusPath,
	getDaedalusDir,
	getApprovalConfigPath,
	getDefaultArchivedSessionsDir,
	getDefaultWorkspaceConfigPath,
	getDefaultSessionsDir,
	getGeneralSettingsConfigPath,
	getLogsDir,
	getMcpServersConfigPath,
	getPersonalSkillsDir,
	getProviderConfigPath,
	getSkillSettingsPath,
	getTerminalJobsDir,
	getToolExecutionLedgerPath,
	getUserPromptConfigPath,
	getWebSearchSettingsConfigPath
} from "../../../src/app-paths.js";

test("Daedalus state uses USERPROFILE without legacy appdata or v2 paths", (): void => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const previousAppData: string | undefined = process.env.APPDATA;
	process.env.USERPROFILE = "D:/Users/TestUser";
	process.env.APPDATA = "D:/Legacy/AppData";

	try {
		assert.equal(getDaedalusDir(), "D:\\Users\\TestUser\\.daedalus");
		assert.equal(getDefaultWorkspaceConfigPath(), "D:\\Users\\TestUser\\.daedalus\\config\\workspaces.json");
		assert.equal(getProviderConfigPath(), "D:\\Users\\TestUser\\.daedalus\\config\\provider.json");
		assert.equal(getMcpServersConfigPath(), "D:\\Users\\TestUser\\.daedalus\\config\\mcp-servers.json");
		assert.equal(getSkillSettingsPath(), "D:\\Users\\TestUser\\.daedalus\\config\\skill-settings.json");
		assert.equal(getUserPromptConfigPath(), "D:\\Users\\TestUser\\.daedalus\\config\\user-prompt.json");
		assert.equal(getGeneralSettingsConfigPath(), "D:\\Users\\TestUser\\.daedalus\\config\\general-settings.json");
		assert.equal(getWebSearchSettingsConfigPath(), "D:\\Users\\TestUser\\.daedalus\\config\\web-search-settings.json");
		assert.equal(getApprovalConfigPath(), "D:\\Users\\TestUser\\.daedalus\\config\\approval.json");
		assert.equal(getPersonalSkillsDir(), "D:\\Users\\TestUser\\.daedalus\\skills");
		assert.equal(getDefaultSessionsDir(), "D:\\Users\\TestUser\\.daedalus\\sessions");
		assert.equal(getDefaultArchivedSessionsDir(), "D:\\Users\\TestUser\\.daedalus\\archived_sessions");
		assert.equal(getLogsDir(), "D:\\Users\\TestUser\\.daedalus\\logs");
		assert.equal(getTerminalJobsDir(), "D:\\Users\\TestUser\\.daedalus\\terminal-jobs");
		assert.equal(getToolExecutionLedgerPath(), "D:\\Users\\TestUser\\.daedalus\\tool-executions.jsonl");

		assert.equal(getDaedalusPath("config.workspaces"), getDefaultWorkspaceConfigPath());
		assert.equal(getDaedalusPath("config.provider"), getProviderConfigPath());
		assert.equal(getDaedalusPath("config.mcpServers"), getMcpServersConfigPath());
		assert.equal(getDaedalusPath("config.skillSettings"), getSkillSettingsPath());
		assert.equal(getDaedalusPath("config.userPrompt"), getUserPromptConfigPath());
		assert.equal(getDaedalusPath("config.generalSettings"), getGeneralSettingsConfigPath());
		assert.equal(getDaedalusPath("config.webSearchSettings"), getWebSearchSettingsConfigPath());
		assert.equal(getDaedalusPath("config.approval"), getApprovalConfigPath());
		assert.equal(getDaedalusPath("skills.root"), getPersonalSkillsDir());
		assert.equal(getDaedalusPath("sessions.activeRoot"), getDefaultSessionsDir());
		assert.equal(getDaedalusPath("sessions.archivedRoot"), getDefaultArchivedSessionsDir());
		assert.equal(getDaedalusPath("logs.root"), getLogsDir());
		assert.equal(getDaedalusPath("terminalJobs.root"), getTerminalJobsDir());
		assert.equal(getDaedalusPath("toolExecution.ledger"), getToolExecutionLedgerPath());
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (previousAppData === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = previousAppData;
		}
	}
});
