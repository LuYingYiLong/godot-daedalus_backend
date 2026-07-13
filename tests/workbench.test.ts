import test from "node:test";
import assert from "node:assert/strict";
import type { AdditionalContextItem } from "../src/protocol/types.js";
import { createClientSession } from "../src/server/client-session.js";
import { applyWorkbenchPatch, serializeWorkbench } from "../src/server/workbench.js";

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
