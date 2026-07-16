import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatMessage } from "../src/protocol/types.js";

async function withTempAppData<T>(fn: (store: typeof import("../src/session/session-store.js")) => Promise<T>): Promise<T> {
	const previousUserProfile: string | undefined = process.env.USERPROFILE;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-session-appdata-"));
	process.env.USERPROFILE = appDataDir;

	try {
		const store = await import(`../src/session/session-store.js?case=${Date.now()}-${Math.random()}`);
		return await fn(store);
	} finally {
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
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
		assert.equal(recent.timelineBlocks.length, 1);
		assert.equal(recent.timelineBlocks[0]?.requestId, "req-2");
		assert.equal(typeof recent.timelineBlocks[0]?.renderHints?.estimatedHeight, "number");
		assert.deepEqual(recent.latestWorkflowSnapshot, { phases: [] });
		assert.equal(recent.hasMoreBefore, true);
		assert.equal(recent.hasMoreAfter, false);

		const firstPage = await store.openSessionTimelinePage(metadata.id, recent.blockOffset, 1);
		assert.equal(firstPage.timelineBlocks.length, 1);
		assert.equal(firstPage.timelineBlocks[0]?.requestId, "req-1");
		assert.equal(firstPage.hasMoreBefore, true);
		assert.equal(firstPage.hasMoreAfter, true);

		const afterPage = await store.openSessionTimelinePageAfter(metadata.id, recent.blockOffset, 1);
		assert.equal(afterPage.timelineBlocks.length, 1);
		assert.equal(afterPage.timelineBlocks[0]?.requestId, "req-2");

		await store.appendSessionEvent(metadata.id, "req-2", "ai.status", { title: "Updated", details: "cache invalidated" });
		const invalidatedPage = await store.openSessionTimelinePageAfter(metadata.id, recent.blockOffset, 1);
		const bodyParts = invalidatedPage.timelineBlocks[0]?.type === "assistant"
			? invalidatedPage.timelineBlocks[0].bodyParts
			: [];
		assert.equal(bodyParts.some((part) => part.type === "status" && part.title === "Updated"), true);

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

test("session store persists workspace metadata snapshot", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const metadata = await store.createSession("Workspace session", undefined, undefined, {
			id: "workspace-a",
			name: "Project A",
			kind: "godot",
			rootPath: "D:/GodotProjects/project-a",
			godotExecutablePath: "D:/Godot/Godot.exe"
		});

		assert.equal(metadata.workspaceId, "workspace-a");
		assert.equal(metadata.workspaceName, "Project A");
		assert.equal(metadata.workspaceKind, "godot");
		assert.equal(metadata.workspaceRoot, "D:/GodotProjects/project-a");
		assert.equal(metadata.godotExecutablePath, "D:/Godot/Godot.exe");

		await store.saveSession(metadata.id, [], {
			workspaceId: undefined,
			activeSkillId: undefined
		});

		const opened = await store.openSession(metadata.id);
		assert.equal(opened.metadata.workspaceId, "workspace-a");
		assert.equal(opened.metadata.workspaceRoot, "D:/GodotProjects/project-a");
		assert.equal(opened.metadata.godotExecutablePath, "D:/Godot/Godot.exe");
	});
});

test("session store persists frontend session metadata", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const metadata = await store.createSession("Configured session", undefined, undefined, undefined, {
			provider: "moonshot",
			model: "kimi-k2.7-code",
			chatMode: "ask",
			approvalMode: "manual"
		});

		assert.equal(metadata.provider, "moonshot");
		assert.equal(metadata.model, "kimi-k2.7-code");
		assert.equal(metadata.chatMode, "ask");
		assert.equal(metadata.approvalMode, "manual");

		await store.saveSession(metadata.id, [], {
			provider: "deepseek",
			model: "deepseek-v4-pro",
			chatMode: "plan",
			approvalMode: "auto-safe"
		});

		const opened = await store.openSession(metadata.id);
		assert.equal(opened.metadata.provider, "deepseek");
		assert.equal(opened.metadata.model, "deepseek-v4-pro");
		assert.equal(opened.metadata.chatMode, "plan");
		assert.equal(opened.metadata.approvalMode, "auto-safe");
	});
});

test("session store deletes active and archived sessions by workspace", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		const active = await store.createSession("Active workspace session", "workspace-a");
		const archived = await store.createSession("Archived workspace session", "workspace-a");
		const other = await store.createSession("Other workspace session", "workspace-b");
		await store.archiveSession(archived.id);

		const result = await store.deleteSessionsByWorkspace("workspace-a");

		assert.deepEqual(result.deletedSessionIds, [active.id]);
		assert.deepEqual(result.deletedArchivedSessionIds, [archived.id]);
		assert.deepEqual((await store.listSessions()).map((metadata) => metadata.id), [other.id]);
		assert.deepEqual(await store.listArchivedSessions(), []);
	});
});

test("session store rejects unsafe session ids", async (): Promise<void> => {
	await withTempAppData(async (store): Promise<void> => {
		await assert.rejects(() => store.openSession("../session-escape"), /Invalid session id/);
		await assert.rejects(() => store.deleteSession("session-../escape"), /Invalid session id/);
		await assert.rejects(() => store.restoreArchivedSession("session-..\\escape"), /Invalid session id/);
	});
});
