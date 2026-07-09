import assert from "node:assert/strict";
import test from "node:test";
import { scheduleWorkflowApproval, scheduleWorkflowPhaseOutcome, scheduleWorkflowPhaseStart } from "../src/workflow/scheduler.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowRunState } from "../src/workflow/types.js";

function createPhase(id: string, toolGroup: WorkflowPhase["toolGroup"] = "read"): WorkflowPhase {
	return {
		id,
		title: id,
		toolGroup,
		toolBudget: "normal",
		allowedTools: [],
		instruction: id
	};
}

function createState(phases: WorkflowPhase[], outputs: WorkflowPhaseOutput[] = []): WorkflowRunState {
	return {
		plan: {
			id: "workflow-test",
			title: "Workflow test",
			phases,
			todos: phases.map((phase: WorkflowPhase) => ({ id: phase.id, phaseId: phase.id, text: phase.title, status: "pending" }))
		},
		phaseIndex: 0,
		phaseOutputs: outputs,
		originalParams: { message: "test" },
		history: [],
		historyBudgetTokens: 100
	};
}

function createOutcome(phase: WorkflowPhase, status: WorkflowPhaseOutput["status"]): WorkflowPhaseOutput {
	return {
		phaseId: phase.id,
		phaseRunId: `run-${phase.id}`,
		title: phase.title,
		status,
		summary: status,
		evidence: [],
		failedChecks: status === "needs_fix" ? [{ code: "check", message: "needs repair" }] : [],
		requiredFixes: status === "needs_fix" ? ["修复：needs repair"] : [],
		modifiedArtifacts: [],
		verifiedArtifacts: [],
		toolObservations: []
	};
}

test("scheduler blocks summarize after an unresolved earlier outcome", (): void => {
	const failedPhase = createPhase("verify", "verify");
	const summarizePhase = createPhase("summarize", "summarize");
	const state = createState([failedPhase, summarizePhase], [createOutcome(failedPhase, "needs_fix")]);
	state.phaseIndex = 1;

	const command = scheduleWorkflowPhaseStart(state, "run-summarize");
	assert.equal(command.type, "blocked_before_start");
	if (command.type === "blocked_before_start") {
		assert.equal(command.state.plan.todos[1]?.status, "failed");
		assert.equal(command.outcome.status, "blocked");
	}
});

test("scheduler inserts repair phases for a repairable verification outcome", (): void => {
	const phase = createPhase("verify", "verify");
	const command = scheduleWorkflowPhaseOutcome(createState([phase]), phase, createOutcome(phase, "needs_fix"), 2);

	assert.equal(command.type, "repair");
	if (command.type === "repair") {
		assert.equal(command.state.phaseIndex, 1);
		assert.ok(command.state.plan.phases.length > 1);
	}
});

test("scheduler blocks a repairable outcome after the repair budget is exhausted", (): void => {
	const phase = createPhase("verify", "verify");
	const state = createState([phase]);
	state.plan.phases = [{ ...phase, id: "auto-repair-1", repairRound: 1 }, { ...phase, id: "auto-verify-1", repairRound: 1 }];
	state.plan.todos = state.plan.phases.map((item: WorkflowPhase) => ({ id: item.id, phaseId: item.id, text: item.title, status: "pending" }));

	const command = scheduleWorkflowPhaseOutcome(state, phase, createOutcome(phase, "needs_fix"), 2);
	assert.equal(command.type, "failed");
	if (command.type === "failed") {
		assert.equal(command.outcome.status, "blocked");
	}
});

test("scheduler completes a successful phase without executing effects", (): void => {
	const phase = createPhase("inspect");
	const command = scheduleWorkflowPhaseOutcome(createState([phase]), phase, createOutcome(phase, "completed"), 2);

	assert.equal(command.type, "complete_phase");
	if (command.type === "complete_phase") {
		assert.equal(command.state.plan.todos[0]?.status, "done");
		assert.equal(command.state.phaseIndex, 1);
	}
});

test("scheduler pauses an approval-required phase without invoking approval effects", (): void => {
	const phase = createPhase("write", "write");
	const outcome = createOutcome(phase, "approval_required");
	const command = scheduleWorkflowApproval(createState([phase]), phase, outcome, "run-write");

	assert.equal(command.type, "pause_for_approval");
	if (command.type === "pause_for_approval") {
		assert.equal(command.state.plan.todos[0]?.status, "paused");
		assert.equal(command.state.activePhaseRunId, "run-write");
	}
});
