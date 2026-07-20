import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionCreateWorkspaceId } from "../../../src/server/session-create-workspace.js";

test("session.create workspace resolution does not let Studio inherit stale active workspace", (): void => {
	assert.equal(resolveSessionCreateWorkspaceId({
		requestedWorkspaceId: undefined,
		clientType: "studio",
		activeWorkspaceId: "workspace-example"
	}), undefined);
});

test("session.create workspace resolution preserves explicit workspace choices", (): void => {
	assert.equal(resolveSessionCreateWorkspaceId({
		requestedWorkspaceId: "workspace-selected",
		clientType: "studio",
		activeWorkspaceId: "workspace-example"
	}), "workspace-selected");
	assert.equal(resolveSessionCreateWorkspaceId({
		requestedWorkspaceId: null,
		clientType: "studio",
		activeWorkspaceId: "workspace-example"
	}), undefined);
});

test("session.create workspace resolution keeps Godot plugin active workspace default", (): void => {
	assert.equal(resolveSessionCreateWorkspaceId({
		requestedWorkspaceId: undefined,
		clientType: "godot_plugin",
		activeWorkspaceId: "workspace-example"
	}), "workspace-example");
});
