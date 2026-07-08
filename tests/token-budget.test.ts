import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ChatMessage } from "../src/protocol/types.js";
import { createClientSession } from "../src/server/client-session.js";
import type { ClientSession } from "../src/server/client-session.js";
import { selectMessagesWithinBudget, summarizeMessagesAsSummary } from "../src/session/session-compressor.js";
import type { TokenCounter } from "../src/tokens/token-counter.js";

async function withTempAppData<T>(
	fn: (
		store: typeof import("../src/session/session-store.js"),
		transcriptHistory: typeof import("../src/server/transcript-history.js")
	) => Promise<T>
): Promise<T> {
	const previousAppData: string | undefined = process.env.APPDATA;
	const appDataDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "godot-daedalus-token-budget-appdata-"));
	process.env.APPDATA = appDataDir;

	try {
		const suffix: string = `${Date.now()}-${Math.random()}`;
		const store = await import(`../src/session/session-store.js?case=${suffix}`);
		const transcriptHistory = await import(`../src/server/transcript-history.js?case=${suffix}`);
		return await fn(store, transcriptHistory);
	} finally {
		if (previousAppData === undefined) {
			delete process.env.APPDATA;
		} else {
			process.env.APPDATA = previousAppData;
		}
		await fs.rm(appDataDir, { recursive: true, force: true });
	}
}

test("failed transcript-only turns persist but stay out of LLM context", async (): Promise<void> => {
	await withTempAppData(async (store, transcriptHistory): Promise<void> => {
		const metadata = await store.createSession("Failed turn", "workspace-a");
		const session: ClientSession = createClientSession(undefined);
		session.sessionId = metadata.id;
		session.sessionTitle = metadata.title;

		const saved = await transcriptHistory.appendFailedChatTurnToSession(
			session,
			"帮我修改脚本",
			{
				code: "agent_run_error",
				message: "总结阶段不能调用工具"
			},
			"request-failed",
			"2026-07-08T00:00:00.000Z",
			"2026-07-08T00:00:01.000Z"
		);

		assert.equal(saved, true);
		assert.equal(session.messages.length, 2);
		assert.equal(session.messages.every((message: ChatMessage): boolean => message.excludeFromLlmContext === true), true);
		assert.equal(session.messages[1]?.status, "failed");
		assert.deepEqual(session.messages[1]?.error, {
			code: "agent_run_error",
			message: "总结阶段不能调用工具"
		});

		const opened = await store.openSession(metadata.id);
		assert.equal(opened.messages.length, 2);
		assert.equal(opened.messages[0]?.excludeFromLlmContext, true);
		assert.equal(opened.messages[1]?.status, "failed");

		assert.deepEqual(transcriptHistory.filterLlmContextMessages(session.messages), []);
		assert.equal(summarizeMessagesAsSummary(session.messages), "");
		const selected = await selectMessagesWithinBudget(session.messages, 10000, {
			countText(text: string): Promise<number> {
				return Promise.resolve(text.length);
			},
			countMessages(messages: ChatMessage[]): Promise<number> {
				return Promise.resolve(messages.reduce((sum: number, message: ChatMessage): number => sum + message.content.length, 0));
			}
		} satisfies TokenCounter);
		assert.deepEqual(selected, []);

		await store.appendSessionEvent(metadata.id, "request-failed", "agent.run.error", {
			code: "agent_run_error",
			message: "总结阶段不能调用工具"
		});
		const rewound = await store.rewindSessionFromRequest(metadata.id, "request-failed");
		assert.equal(rewound.length, 0);
		assert.equal((await store.openSession(metadata.id)).events.length, 0);
	});
});
