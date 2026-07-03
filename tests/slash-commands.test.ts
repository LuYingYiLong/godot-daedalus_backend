import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../src/protocol/schema.js";
import { createSlashHelpText, listSlashCommands } from "../src/server/slash-commands.js";

test("slash command list exposes the existing backend chat commands", (): void => {
	const commands = listSlashCommands();
	const commandNames = commands.map((command) => command.command);

	assert.deepEqual(commandNames, [
		"/help",
		"/context",
		"/approvals",
		"/skills",
		"/skill",
		"/reset",
		"/init"
	]);

	for (const command of commands) {
		assert.equal(command.command.startsWith("/"), true);
		assert.equal(command.usage.startsWith(command.command), true);
		assert.equal(command.insertText.startsWith(command.command), true);
		assert.equal(command.description.length > 0, true);
	}
});

test("slash command help text is generated from the command list", (): void => {
	const helpText: string = createSlashHelpText();

	for (const command of listSlashCommands()) {
		assert.match(helpText, new RegExp(command.command.replace("/", "\\/")));
		assert.match(helpText, new RegExp(command.description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("command.list is accepted by the client request schema", (): void => {
	const parsed = clientRequestSchema.parse({
		type: "request",
		id: "command-list-test",
		method: "command.list",
		params: {}
	});

	assert.equal(parsed.method, "command.list");
});
