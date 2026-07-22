import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { clientRequestSchema } from "../../../src/protocol/schema.js";
import type { ClientRequest } from "../../../src/protocol/types.js";
import type { McpHost } from "../../../src/mcp/mcp-host.js";
import { createClientSession, type ClientSession } from "../../../src/server/client-session.js";
import { createSlashHelpText, handleSlashCommand, listSlashCommands } from "../../../src/server/slash-commands.js";

function createSocketMock(): WebSocket & { sent: unknown[] } {
	const sent: unknown[] = [];
	return {
		readyState: WebSocket.OPEN,
		sent,
		send(message: string): void {
			sent.push(JSON.parse(message) as unknown);
		}
	} as unknown as WebSocket & { sent: unknown[] };
}

async function withTempUserProfile(run: () => Promise<void>): Promise<void> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	process.env.USERPROFILE = await mkdtemp(join(tmpdir(), "daedalus-slash-skill-"));
	try {
		await run();
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
	}
}

test("slash command list exposes the existing backend chat commands", (): void => {
	const commands = listSlashCommands();
	const commandNames = commands.map((command) => command.command);

	assert.deepEqual(commandNames, [
		"/help",
		"/context",
		"/approvals",
		"/test-approval",
		"/skills",
		"/skill",
		"/create-skill",
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

test("test approval command includes a clear user-facing reason", (): void => {
	const source: string = readFileSync(new URL("../../../src/server/slash-commands.ts", import.meta.url), "utf8");

	assert.match(source, /Create a temporary markdown file to test the Studio approval UI\./);
});

test("/skill streams and responds even without an active workspace", async (): Promise<void> => {
	await withTempUserProfile(async (): Promise<void> => {
		const socket = createSocketMock();
		const session: ClientSession = createClientSession(undefined);
		const request: ClientRequest = {
			type: "request",
			id: "slash-skill-no-workspace",
			method: "ai.chat",
			params: {
				message: "/skill",
				options: { stream: true }
			}
		} as ClientRequest;

		const result = await handleSlashCommand({
			socket,
			request,
			session,
			mcpHost: {} as McpHost,
			createSessionInfo: (): Record<string, unknown> => ({ ok: true })
		});

		assert.deepEqual(result, { type: "handled" });
		assert.equal(socket.sent.some((message): boolean => (message as { event?: string }).event === "agent.run.started"), true);
		assert.equal(socket.sent.some((message): boolean => (message as { event?: string }).event === "agent.message.done"), true);
		assert.equal(socket.sent.some((message): boolean => (message as { event?: string }).event === "agent.run.done"), true);
		const response = socket.sent.find((message): boolean => (message as { type?: string }).type === "response") as { ok?: boolean; result?: { text?: string } } | undefined;
		assert.equal(response?.ok, true);
		assert.match(response?.result?.text ?? "", /Skill 现在按消息激活/u);
		assert.match(response?.result?.text ?? "", /builtin:skill-creator/u);
	});
});
