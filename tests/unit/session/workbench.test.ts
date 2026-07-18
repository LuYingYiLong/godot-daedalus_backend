import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { AdditionalContextItem, ClientRequest } from "../../../src/protocol/types.js";
import { createClientSession } from "../../../src/server/client-session.js";
import { handleMessageQueueRequest } from "../../../src/server/handlers/message-queue-handlers.js";
import { handleWorkbenchRequest } from "../../../src/server/handlers/workbench-handlers.js";
import { applyWorkbenchPatch, serializeWorkbench } from "../../../src/server/workbench.js";

function makeContext(id: string, resourcePath: string, pinned: boolean = false): AdditionalContextItem {
	return {
		id,
		kind: "file",
		title: resourcePath,
		source: "manual",
		resourcePath,
		pinned
	};
}

function makeSocket(messages: unknown[]): WebSocket {
	return {
		readyState: WebSocket.OPEN,
		send(payload: string): void {
			messages.push(JSON.parse(payload) as unknown);
		}
	} as WebSocket;
}

test("workbench patch updates composer and increments revision", (): void => {
	const session = createClientSession(undefined);
	const changed = applyWorkbenchPatch(session, {
		composer: {
			text: "hello",
			chatMode: "ask",
			provider: "openai",
			model: "gpt-test",
			additionalContext: [makeContext("ctx-a", "res://a.gd")]
		}
	});

	assert.equal(changed, true);
	assert.equal(session.workbenchRevision, 1);
	const workbench = serializeWorkbench(session);
	assert.equal((workbench.composer as Record<string, unknown>).text, "hello");
	assert.equal((workbench.composer as Record<string, unknown>).chatMode, "ask");
	assert.equal((workbench.composer as Record<string, unknown>).provider, "openai");
	assert.equal((workbench.composer as Record<string, unknown>).model, "gpt-test");
	assert.equal(session.activeProvider, "openai");
	assert.equal(session.providerModel, "gpt-test");
	assert.equal(session.modelProfile.provider, "openai");
	assert.equal(session.modelProfile.model, "gpt-test");
});

test("workbench additional context actions dedupe, pin and clear unpinned", (): void => {
	const session = createClientSession(undefined);
	applyWorkbenchPatch(session, {
		additionalContextAction: {
			action: "set",
			items: [
				makeContext("ctx-a", "res://a.gd"),
				makeContext("ctx-b", "res://b.gd")
			]
		}
	});
	applyWorkbenchPatch(session, {
		additionalContextAction: {
			action: "addOrReplace",
			item: makeContext("ctx-a-new", "res://a.gd")
		}
	});
	assert.equal(session.workbenchComposer.additionalContext.length, 2);
	assert.equal(session.workbenchComposer.additionalContext[0]?.id, "ctx-a");

	applyWorkbenchPatch(session, {
		additionalContextAction: {
			action: "pin",
			contextId: "ctx-b",
			pinned: true
		}
	});
	applyWorkbenchPatch(session, {
		additionalContextAction: {
			action: "clearUnpinned"
		}
	});

	assert.deepEqual(
		session.workbenchComposer.additionalContext.map((context: AdditionalContextItem): string => context.id),
		["ctx-b"]
	);
	assert.equal(session.workbenchComposer.additionalContext[0]?.pinned, true);
});

test("workbench snapshot derives active run and pending approval shape", (): void => {
	const session = createClientSession(undefined);
	session.activeRunRequestId = "run-1";

	const workbench = serializeWorkbench(session);
	assert.deepEqual(workbench.activeRun, {
		status: "streaming",
		requestId: "run-1"
	});
	assert.deepEqual(workbench.pendingApproval, {
		count: 0,
		first: null
	});
});

test("workbench patch ignores stale client sequence without changing revision", (): void => {
	const session = createClientSession(undefined);
	const messages: unknown[] = [];
	const socket: WebSocket = makeSocket(messages);

	handleWorkbenchRequest(socket, {
		id: "patch-2",
		method: "session.workbench.patch",
		params: {
			clientSequence: 2,
			composer: { text: "new" }
		}
	} as ClientRequest, session, {} as never);

	handleWorkbenchRequest(socket, {
		id: "patch-1",
		method: "session.workbench.patch",
		params: {
			clientSequence: 1,
			composer: { text: "old" }
		}
	} as ClientRequest, session, {} as never);

	assert.equal(session.workbenchComposer.text, "new");
	assert.equal(session.workbenchRevision, 1);
	const responses = messages.filter((message: unknown): boolean => (message as Record<string, unknown>).type === "response");
	const events = messages.filter((message: unknown): boolean => (message as Record<string, unknown>).type === "event");
	assert.equal(responses.length, 2);
	assert.equal(events.length, 1);
	assert.equal(((responses[1] as Record<string, unknown>).result as Record<string, unknown>).changed, false);
	assert.equal(((responses[1] as Record<string, unknown>).result as Record<string, unknown>).stale, true);
});

test("message queue no-op remove does not bump workbench revision", (): void => {
	const session = createClientSession(undefined);
	const messages: unknown[] = [];
	const socket: WebSocket = makeSocket(messages);

	handleMessageQueueRequest(socket, {
		id: "remove-missing",
		method: "message.queue.remove",
		params: { queueId: 404 }
	} as ClientRequest, session, {} as never);

	assert.equal(session.workbenchRevision, 0);
	assert.equal(messages.length, 1);
	const response = messages[0] as Record<string, unknown>;
	assert.equal(response.type, "response");
	const result = response.result as Record<string, unknown>;
	assert.equal(result.queueRemoved, false);
	assert.equal(result.removed, false);
});
