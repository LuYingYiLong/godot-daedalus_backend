import assert from "node:assert/strict";
import test from "node:test";
import { parseToolResultSummary } from "../../../src/tools/tool-result-parser.js";

test("terminal preset failed result becomes structured failed validation", (): void => {
	const summary = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "godot.check_only", resourcePath: "res://scripts/game.gd" },
		JSON.stringify({
			ok: false,
			exitCode: 1,
			stderr: "Parser Error: Unexpected token",
			resourcePath: "res://scripts/game.gd"
		})
	);

	assert.equal(summary.ok, false);
	assert.equal(summary.exitCode, 1);
	assert.equal(summary.validationStatus, "failed");
	assert.match(summary.summary ?? "", /godot\.check_only/);
	assert.deepEqual(summary.artifactRefs, ["res://scripts/game.gd"]);
	assert.equal(summary.failedChecks?.length, 1);
	assert.match(summary.failedChecks?.[0] ?? "", /Unexpected token/);
});

test("Godot terminal spawn errors are marked as environment issues", (): void => {
	const summary = parseToolResultSummary(
		"mcp_terminal_run_safe_preset",
		{ presetName: "godot.check_only", resourcePath: "res://scripts/game.gd" },
		JSON.stringify({
			ok: false,
			exitCode: null,
			stderr: "Process error: spawn godot ENOENT",
			resourcePath: "res://scripts/game.gd"
		})
	);

	assert.equal(summary.ok, false);
	assert.equal(summary.validationStatus, "failed");
	assert.equal(summary.environmentIssue, true);
	assert.match(summary.failedChecks?.[0] ?? "", /spawn godot ENOENT/);
});

test("LSP diagnostics result counts errors and marks validation failed", (): void => {
	const summary = parseToolResultSummary(
		"mcp_godot_lsp_get_file_diagnostics",
		{ resourcePath: "res://scripts/game.gd" },
		JSON.stringify({
			ok: true,
			resourcePath: "res://scripts/game.gd",
			diagnostics: [
				{ severity: "error", message: "Unknown identifier", lineStart: 4, columnStart: 2 },
				{ severity: "warning", message: "Unused variable", lineStart: 5, columnStart: 2 }
			]
		})
	);

	assert.equal(summary.ok, false);
	assert.equal(summary.diagnosticsCount, 2);
	assert.equal(summary.diagnosticsErrorCount, 1);
	assert.equal(summary.validationStatus, "failed");
	assert.deepEqual(summary.artifactRefs, ["res://scripts/game.gd"]);
	assert.match(summary.failedChecks?.[0] ?? "", /Unknown identifier/);
});

test("empty LSP diagnostics result marks validation passed", (): void => {
	const summary = parseToolResultSummary(
		"mcp_godot_lsp_get_file_diagnostics",
		{ resourcePath: "res://scripts/game.gd" },
		JSON.stringify({
			ok: true,
			resourcePath: "res://scripts/game.gd",
			diagnostics: []
		})
	);

	assert.equal(summary.ok, true);
	assert.equal(summary.diagnosticsCount, 0);
	assert.equal(summary.diagnosticsErrorCount, 0);
	assert.equal(summary.validationStatus, "passed");
	assert.deepEqual(summary.failedChecks, []);
});

test("LSP status preserves unavailable workspace as environment issue", (): void => {
	const summary = parseToolResultSummary(
		"mcp_godot_lsp_get_status",
		{},
		JSON.stringify({
			ok: false,
			error: {
				code: "godot_diagnostics_unavailable",
				message: "godot_diagnostics_unavailable: no active workspace"
			}
		})
	);

	assert.equal(summary.ok, false);
	assert.equal(summary.validationStatus, "failed");
	assert.equal(summary.environmentIssue, true);
	assert.match(summary.summary ?? "", /no active workspace/);
	assert.match(summary.failedChecks?.[0] ?? "", /no active workspace/);
});

test("LSP diagnostics unavailable keeps error text instead of reporting zero clean diagnostics", (): void => {
	const summary = parseToolResultSummary(
		"mcp_godot_lsp_get_file_diagnostics",
		{ resourcePath: "res://scripts/game.gd" },
		JSON.stringify({
			ok: false,
			error: {
				code: "godot_diagnostics_unavailable",
				message: "godot_diagnostics_unavailable: no active workspace"
			}
		})
	);

	assert.equal(summary.ok, false);
	assert.equal(summary.validationStatus, "failed");
	assert.equal(summary.environmentIssue, true);
	assert.match(summary.summary ?? "", /unavailable/);
	assert.match(summary.failedChecks?.[0] ?? "", /no active workspace/);
});
