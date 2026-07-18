import assert from "node:assert/strict";
import test from "node:test";
import { collectGodotRefreshPaths, getLlmToolExecutionIdentity, shouldDedupeLlmToolExecution } from "../../../src/tools/tool-idempotency.js";

test("only write and destructive tools are deduplicated", (): void => {
	assert.equal(shouldDedupeLlmToolExecution("mcp_godot_read_text_file"), false);
	assert.equal(shouldDedupeLlmToolExecution("mcp_terminal_run_safe_preset"), false);
	assert.equal(shouldDedupeLlmToolExecution("mcp_godot_propose_create_text_file"), false);
	assert.equal(shouldDedupeLlmToolExecution("mcp_godot_create_text_file"), true);
	assert.equal(shouldDedupeLlmToolExecution("mcp_godot_delete_file"), true);
	assert.equal(shouldDedupeLlmToolExecution("mcp_custom_server_tool_12345678"), true);
});

test("tool execution fingerprints are stable across argument key order", (): void => {
	const left = getLlmToolExecutionIdentity(
		"mcp_godot_create_text_file",
		{ relativePath: "scripts/player.gd", content: "extends Node\n", nested: { b: 2, a: 1 } },
		"workspace:alpha"
	);
	const right = getLlmToolExecutionIdentity(
		"mcp_godot_create_text_file",
		{ nested: { a: 1, b: 2 }, content: "extends Node\n", relativePath: "scripts/player.gd" },
		"workspace:alpha"
	);

	assert.notEqual(left, undefined);
	assert.deepEqual(left, right);
});

test("tool execution fingerprints include workspace scope", (): void => {
	const args: Record<string, unknown> = {
		relativePath: "scripts/player.gd",
		content: "extends Node\n"
	};
	const alpha = getLlmToolExecutionIdentity("mcp_godot_create_text_file", args, "workspace:alpha");
	const beta = getLlmToolExecutionIdentity("mcp_godot_create_text_file", args, "workspace:beta");

	assert.notEqual(alpha, undefined);
	assert.notEqual(beta, undefined);
	assert.notEqual(alpha?.fingerprint, beta?.fingerprint);
	assert.equal(alpha?.argsHash, beta?.argsHash);
});

test("read tools do not produce execution identities", (): void => {
	assert.equal(getLlmToolExecutionIdentity("mcp_godot_read_text_file", { relativePath: "project.godot" }), undefined);
});

test("project setting mutations refresh project.godot", (): void => {
	assert.deepEqual(
		collectGodotRefreshPaths("mcp_godot_set_project_setting", {
			key: "application/config/name",
			valueExpression: "\"Daedalus\""
		}),
		["project.godot"]
	);
	assert.deepEqual(
		collectGodotRefreshPaths("mcp_godot_unset_project_setting", {
			key: "application/config/name"
		}),
		["project.godot"]
	);
});
