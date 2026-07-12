import assert from "node:assert/strict";
import test from "node:test";
import {
	getDaedalusDir,
	getDefaultArchivedSessionsDir,
	getDefaultSessionsDir,
	getMcpServersConfigPath,
	getPersonalSkillsDir,
	getProviderConfigPath,
	getToolExecutionLedgerPath
} from "../src/app-paths.js";

test("Daedalus state uses USERPROFILE without legacy appdata or v2 paths", (): void => {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const previousAppData: string | undefined = process.env.APPDATA;
	process.env.USERPROFILE = "D:/Users/TestUser";
	process.env.APPDATA = "D:/Legacy/AppData";

	try {
		assert.equal(getDaedalusDir(), "D:\\Users\\TestUser\\.daedalus");
		assert.equal(getProviderConfigPath(), "D:\\Users\\TestUser\\.daedalus\\config\\provider.json");
		assert.equal(getMcpServersConfigPath(), "D:\\Users\\TestUser\\.daedalus\\config\\mcp-servers.json");
		assert.equal(getPersonalSkillsDir(), "D:\\Users\\TestUser\\.daedalus\\skills");
		assert.equal(getDefaultSessionsDir(), "D:\\Users\\TestUser\\.daedalus\\sessions");
		assert.equal(getDefaultArchivedSessionsDir(), "D:\\Users\\TestUser\\.daedalus\\archived_sessions");
		assert.equal(getToolExecutionLedgerPath(), "D:\\Users\\TestUser\\.daedalus\\tool-executions.jsonl");
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
