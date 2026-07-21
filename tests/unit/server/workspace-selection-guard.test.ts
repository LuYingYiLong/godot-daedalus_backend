import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWorkspaceSelectionForSession } from "../../../src/server/workspace-selection-guard.js";
import type { WorkspaceConfig } from "../../../src/workspace/types.js";

const workspaceA: WorkspaceConfig = {
	id: "workspace-a",
	name: "Project A",
	kind: "godot",
	rootPath: "D:/ProjectA"
};

const workspaceB: WorkspaceConfig = {
	id: "workspace-b",
	name: "Project B",
	kind: "godot",
	rootPath: "D:/ProjectB"
};

test("Studio workspace selection allows sessions without an active session id", (): void => {
	assert.deepEqual(evaluateWorkspaceSelectionForSession({
		clientType: "studio",
		session: {},
		workspace: workspaceA
	}), { allowed: true, bindToSession: true });
});

test("Studio workspace selection allows reselecting the bound workspace", (): void => {
	assert.deepEqual(evaluateWorkspaceSelectionForSession({
		clientType: "studio",
		session: {
			sessionId: "session-a",
			activeWorkspace: workspaceA
		},
		workspace: workspaceA
	}), { allowed: true, bindToSession: true });
});

test("Studio workspace selection blocks switching an opened session to another workspace", (): void => {
	const decision = evaluateWorkspaceSelectionForSession({
		clientType: "studio",
		session: {
			sessionId: "session-a",
			activeWorkspace: workspaceA
		},
		workspace: workspaceB
	});

	assert.equal(decision.allowed, false);
	if (!decision.allowed) {
		assert.equal(decision.code, "session_workspace_locked");
		assert.equal(decision.currentWorkspaceId, "workspace-a");
		assert.equal(decision.requestedWorkspaceId, "workspace-b");
	}
});

test("Studio draft workspace selection does not bind to the existing session runtime", (): void => {
	assert.deepEqual(evaluateWorkspaceSelectionForSession({
		clientType: "studio",
		session: {
			sessionId: "session-a",
			activeWorkspace: workspaceA
		},
		workspace: workspaceB,
		requestedSessionId: null
	}), { allowed: true, bindToSession: false });
});

test("non-Studio clients can still select runtime workspaces for existing sessions", (): void => {
	assert.deepEqual(evaluateWorkspaceSelectionForSession({
		clientType: "godot_plugin",
		session: {
			sessionId: "session-a",
			activeWorkspace: workspaceA
		},
		workspace: workspaceB
	}), { allowed: true, bindToSession: true });
});
