import assert from "node:assert/strict";
import test from "node:test";
import type { ToolEvent } from "../src/tools/tool-dispatcher.js";
import {
	applyDeterministicVerificationGate,
	applyToolEventToWorkflowObservations,
	createWorkflowPhaseOutcome,
	findBlockingOutcomeBeforeSummarize
} from "../src/workflow/outcome.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowToolObservation } from "../src/workflow/types.js";

function createPhase(id: string, toolGroup: WorkflowPhase["toolGroup"]): WorkflowPhase {
	return {
		id,
		title: id,
		toolGroup,
		toolBudget: toolGroup === "write" ? "project_edit" : "normal",
		allowedTools: [],
		instruction: id
	};
}

function applyEvents(events: ToolEvent[]): WorkflowToolObservation[] {
	let observations: WorkflowToolObservation[] = [];
	for (const event of events) {
		observations = applyToolEventToWorkflowObservations(observations, event);
	}
	return observations;
}

test("verify phase with failed terminal validation becomes needs_fix", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.call",
			step: 0,
			toolCallId: "call-1",
			toolName: "mcp_terminal_run_safe_preset",
			args: { presetName: "godot.check_only", resourcePath: "res://scripts/game.gd" },
			serverId: "terminal",
			serverName: "Terminal",
			category: "terminal",
			title: "运行验证",
			summary: "godot.check_only",
			target: {
				kind: "command",
				path: "res://scripts/game.gd",
				label: "godot.check_only"
			}
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "call-1",
			toolName: "mcp_terminal_run_safe_preset",
			resultChars: 120,
			truncated: false,
			ok: false,
			exitCode: 1,
			validationStatus: "failed",
			summary: "godot.check_only failed",
			failedChecks: ["Parser Error"],
			artifactRefs: ["res://scripts/game.gd"]
		}
	]);
	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-1", "", observations);

	assert.equal(outcome.status, "needs_fix");
	assert.equal(outcome.failedChecks.length, 1);
	assert.match(outcome.failedChecks[0]?.message ?? "", /Parser Error/);
	assert.deepEqual(outcome.requiredFixes, ["修复：Parser Error"]);
});

test("verify phase without deterministic validation tool becomes blocked", (): void => {
	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-1", "我检查过了，应该没问题。", []);

	assert.equal(outcome.status, "blocked");
	assert.match(outcome.blockedReason ?? "", /验证工具/);
	assert.equal(outcome.failedChecks[0]?.code, "verify_tool_missing");
});

test("summarize phase cannot complete with a tool-call prelude", (): void => {
	const outcome = createWorkflowPhaseOutcome(
		createPhase("summarize", "summarize"),
		"phase-run-1",
		"已经拿到了上下文。现在读取 `AGENTS.md` 内容，准备用 `read_text_file` 读取 `res://addons/godot_daedalus/AGENTS.md`，大概几秒。",
		[]
	);

	assert.equal(outcome.status, "blocked");
	assert.equal(outcome.failedChecks[0]?.code, "summary_requested_tool");
	assert.match(outcome.summary, /summarize 阶段不能调用工具/);
});

test("successful LSP diagnostics lets verify phase complete", (): void => {
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.result",
			step: 0,
			toolCallId: "call-1",
			toolName: "mcp_godot_lsp_get_file_diagnostics",
			resultChars: 80,
			truncated: false,
			ok: true,
			diagnosticsCount: 0,
			diagnosticsErrorCount: 0,
			validationStatus: "passed",
			summary: "res://scripts/game.gd LSP diagnostics: 0 issue(s), 0 error(s).",
			artifactRefs: ["res://scripts/game.gd"]
		}
	]);
	const outcome = createWorkflowPhaseOutcome(createPhase("verify", "verify"), "phase-run-1", "验证完成。", observations);

	assert.equal(outcome.status, "completed");
	assert.deepEqual(outcome.verifiedArtifacts, ["res://scripts/game.gd"]);
});

test("summarize gate blocks unresolved failed outcome until a later completed outcome", (): void => {
	const verifyPhase: WorkflowPhase = createPhase("verify", "verify");
	const failedOutcome = createWorkflowPhaseOutcome(
		verifyPhase,
		"phase-run-1",
		"",
		applyEvents([{
			type: "tool.result",
			step: 0,
			toolCallId: "call-1",
			toolName: "mcp_godot_validate_scene_script_references",
			resultChars: 120,
			truncated: false,
			ok: false,
			validationStatus: "failed",
			summary: "场景引用缺失。",
			failedChecks: ["`%TitleLabel` 未设置 unique name。"],
			artifactRefs: ["res://scenes/main.tscn"]
		}])
	);
	const repairedOutcome = createWorkflowPhaseOutcome(
		verifyPhase,
		"phase-run-2",
		"",
		applyEvents([{
			type: "tool.result",
			step: 0,
			toolCallId: "call-2",
			toolName: "mcp_godot_lsp_get_file_diagnostics",
			resultChars: 80,
			truncated: false,
			ok: true,
			diagnosticsCount: 0,
			diagnosticsErrorCount: 0,
			validationStatus: "passed",
			summary: "LSP diagnostics passed.",
			artifactRefs: ["res://scripts/game.gd"]
		}])
	);

	assert.equal(findBlockingOutcomeBeforeSummarize([failedOutcome])?.status, "needs_fix");
	assert.equal(findBlockingOutcomeBeforeSummarize([failedOutcome, repairedOutcome]), null);
});

test("deterministic verification gate requires check-only after GDScript writes", (): void => {
	const writeOutcome: WorkflowPhaseOutput = {
		phaseId: "implement",
		phaseRunId: "phase-run-write",
		title: "实现修改",
		status: "completed",
		summary: "updated script",
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: ["res://scripts/game.gd"],
		verifiedArtifacts: [],
		toolObservations: []
	};
	const verifyPhase: WorkflowPhase = createPhase("verify", "verify");
	const lspOnlyOutcome = createWorkflowPhaseOutcome(
		verifyPhase,
		"phase-run-verify",
		"",
		applyEvents([{
			type: "tool.result",
			step: 0,
			toolCallId: "call-1",
			toolName: "mcp_godot_lsp_get_file_diagnostics",
			resultChars: 80,
			truncated: false,
			ok: true,
			diagnosticsCount: 0,
			diagnosticsErrorCount: 0,
			validationStatus: "passed",
			summary: "LSP diagnostics passed.",
			artifactRefs: ["res://scripts/game.gd"]
		}])
	);
	const gatedOutcome = applyDeterministicVerificationGate(verifyPhase, lspOnlyOutcome, [writeOutcome]);

	assert.equal(gatedOutcome.status, "needs_fix");
	assert.equal(gatedOutcome.failedChecks[0]?.code, "godot_check_only_required");
});

test("deterministic verification gate passes when required GDScript checks ran", (): void => {
	const writeOutcome: WorkflowPhaseOutput = {
		phaseId: "implement",
		phaseRunId: "phase-run-write",
		title: "实现修改",
		status: "completed",
		summary: "updated script",
		evidence: [],
		failedChecks: [],
		requiredFixes: [],
		modifiedArtifacts: ["res://scripts/game.gd"],
		verifiedArtifacts: [],
		toolObservations: []
	};
	const verifyPhase: WorkflowPhase = createPhase("verify", "verify");
	const observations: WorkflowToolObservation[] = applyEvents([
		{
			type: "tool.result",
			step: 0,
			toolCallId: "call-lsp",
			toolName: "mcp_godot_lsp_get_file_diagnostics",
			resultChars: 80,
			truncated: false,
			ok: true,
			diagnosticsCount: 0,
			diagnosticsErrorCount: 0,
			validationStatus: "passed",
			summary: "LSP diagnostics passed.",
			artifactRefs: ["res://scripts/game.gd"]
		},
		{
			type: "tool.call",
			step: 0,
			toolCallId: "call-check",
			toolName: "mcp_terminal_run_safe_preset",
			args: { presetName: "godot.check_only", resourcePath: "res://scripts/game.gd" },
			serverId: "terminal",
			serverName: "Terminal",
			category: "terminal",
			title: "运行终端命令",
			summary: "godot.check_only",
			target: {
				kind: "command",
				path: "res://scripts/game.gd",
				label: "godot.check_only"
			}
		},
		{
			type: "tool.result",
			step: 0,
			toolCallId: "call-check",
			toolName: "mcp_terminal_run_safe_preset",
			resultChars: 80,
			truncated: false,
			ok: true,
			exitCode: 0,
			validationStatus: "passed",
			summary: "godot.check_only passed",
			artifactRefs: ["res://scripts/game.gd"]
		}
	]);
	const outcome = createWorkflowPhaseOutcome(verifyPhase, "phase-run-verify", "", observations);
	const gatedOutcome = applyDeterministicVerificationGate(verifyPhase, outcome, [writeOutcome]);

	assert.equal(gatedOutcome.status, "completed");
});
