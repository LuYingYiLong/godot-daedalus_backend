import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatMessage } from "../src/protocol/types.js";

async function withTempAppData<T>(fn: (store: typeof import("../src/session/session-store.js")) => Promise<T>): Promise<T> {
	const previousAppData: string | undefined = process.env.APPDATA;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-session-appdata-"));
	process.env.APPDATA = appDataDir;

	try {
		const store = await import(`../src/session/session-store.js?case=${Date.now()}-${Math.random()}`);
		return await fn(store);
	} finally {
		if (previousAppData === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = previousAppData;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
	}
}

test("session store creates, opens, pages, rewinds, archives, restores, and deletes sessions", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const metadata = await store.createSession("First session", "workspace-a", "gdscript.review");
		assert.match(metadata.id, /^session-/);
		assert.equal(metadata.title, "First session");
		assert.equal(metadata.workspaceId, "workspace-a");

		const firstMessage: ChatMessage = {
			role: "user",
			content: "hello",
			requestId: "req-1",
			createdAt: "2026-07-03T00:00:00.000Z"
		};
		const secondMessage: ChatMessage = {
			role: "assistant",
			content: "world",
			requestId: "req-2",
			createdAt: "2026-07-03T00:00:01.000Z"
		};
		await store.appendMessage(metadata.id, firstMessage);
		await store.appendSessionEvent(metadata.id, "req-1", "tool.call", { toolName: "mcp_godot_read_text_file" });
		await store.appendMessage(metadata.id, secondMessage);
		await store.appendSessionEvent(metadata.id, "req-2", "workflow.todo.updated", { phases: [] });
		await store.appendApprovalEvent(metadata.id, "approval-req-2", "req-2", "requested", { approvalId: "approval-req-2" });
		assert.equal((await store.readApprovalEvents(metadata.id)).length, 1);

		const opened = await store.openSession(metadata.id);
		assert.equal(opened.messages.length, 2);
		assert.equal(opened.events.length, 2);

		const recent = await store.openSessionRecentTimeline(metadata.id, 1);
		assert.equal(recent.messages.length, 1);
		assert.equal(recent.messages[0]?.requestId, "req-2");
		assert.deepEqual(recent.latestWorkflowSnapshot, { phases: [] });
		assert.equal(recent.hasMoreBefore, true);

		const firstPage = await store.openSessionTimelinePage(metadata.id, recent.messagesOffset, 1);
		assert.equal(firstPage.messages.length, 1);
		assert.equal(firstPage.messages[0]?.requestId, "req-1");

		const rewound = await store.rewindSessionFromRequest(metadata.id, "req-2");
		assert.equal(rewound.length, 1);
		assert.equal(rewound[0]?.requestId, "req-1");
		assert.equal((await store.openSession(metadata.id)).events.length, 1);
		assert.equal((await store.readApprovalEvents(metadata.id)).length, 0);

		const renamed = await store.renameSession(metadata.id, "Renamed");
		assert.equal(renamed.title, "Renamed");

		const archived = await store.archiveSession(metadata.id);
		assert.equal(archived.archivedAt !== undefined, true);
		assert.equal((await store.listSessions()).length, 0);
		assert.equal((await store.listArchivedSessions()).length, 1);

		const restored = await store.restoreArchivedSession(metadata.id);
		assert.equal(restored.archivedAt, undefined);
		assert.equal(await store.sessionExists(metadata.id), true);

		await store.deleteSession(metadata.id);
		assert.equal(await store.sessionExists(metadata.id), false);
	});
});

test("session store rejects unsafe session ids", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		await assert.rejects(() => store.openSession("../session-escape"), /Invalid session id/);
		await assert.rejects(() => store.deleteSession("session-../escape"), /Invalid session id/);
		await assert.rejects(() => store.restoreArchivedSession("session-..\\escape"), /Invalid session id/);
	});
});
