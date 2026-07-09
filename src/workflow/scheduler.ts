import { appendPhaseOutput, updateWorkflowPhaseStatus } from "./runner.js";
import { countWorkflowAutoRepairRounds, insertWorkflowAutoRepairPhases } from "./repair.js";
import { findBlockingOutcomeBeforeSummarize } from "./outcome.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowPlan, WorkflowRunState } from "./types.js";

export type WorkflowSchedulerCommand =
	| { type: "run_phase"; state: WorkflowRunState; phase: WorkflowPhase }
	| { type: "blocked_before_start"; state: WorkflowRunState; phase: WorkflowPhase; outcome: WorkflowPhaseOutput }
	| { type: "pause_for_approval"; state: WorkflowRunState; phase: WorkflowPhase; outcome: WorkflowPhaseOutput }
	| { type: "repair"; state: WorkflowRunState; phase: WorkflowPhase; outcome: WorkflowPhaseOutput }
	| { type: "failed"; state: WorkflowRunState; phase: WorkflowPhase; outcome: WorkflowPhaseOutput }
	| { type: "complete_phase"; state: WorkflowRunState; phase: WorkflowPhase; outcome: WorkflowPhaseOutput }
	| { type: "finish"; state: WorkflowRunState };

function createSummarizeBlockedOutcome(phase: WorkflowPhase, phaseRunId: string, blockingOutcome: WorkflowPhaseOutput): WorkflowPhaseOutput {
	const message: string = `总结阶段被阻止：阶段「${blockingOutcome.title}」仍处于 ${blockingOutcome.status}，不能交付完成总结。`;
	return {
		phaseId: phase.id,
		phaseRunId,
		title: phase.title,
		status: "blocked",
		summary: message,
		evidence: [],
		failedChecks: blockingOutcome.failedChecks,
		requiredFixes: blockingOutcome.requiredFixes,
		modifiedArtifacts: [],
		verifiedArtifacts: [],
		toolObservations: [],
		sourcePhaseId: blockingOutcome.phaseId,
		blockedReason: message
	};
}

export function scheduleWorkflowPhaseStart(state: WorkflowRunState, phaseRunId: string): WorkflowSchedulerCommand {
	const phase: WorkflowPhase | undefined = state.plan.phases[state.phaseIndex];
	if (phase === undefined) {
		return { type: "finish", state };
	}

	if (phase.toolGroup === "summarize") {
		const blockingOutcome: WorkflowPhaseOutput | null = findBlockingOutcomeBeforeSummarize(state.phaseOutputs, phase.id);
		if (blockingOutcome !== null) {
			const outcome: WorkflowPhaseOutput = createSummarizeBlockedOutcome(phase, phaseRunId, blockingOutcome);
			const plan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "failed");
			return {
				type: "blocked_before_start",
				phase,
				outcome,
				state: {
					...state,
					plan,
					phaseOutputs: appendPhaseOutput(state.phaseOutputs, phase, outcome),
					activePhaseRunId: phaseRunId
				}
			};
		}
	}

	const plan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "running");
	return {
		type: "run_phase",
		phase,
		state: { ...state, plan, activePhaseRunId: phaseRunId }
	};
}

export function scheduleWorkflowPhaseOutcome(
	state: WorkflowRunState,
	phase: WorkflowPhase,
	outcome: WorkflowPhaseOutput,
	maxAutoRepairRounds: number
): WorkflowSchedulerCommand {
	if (outcome.status === "needs_fix") {
		if (countWorkflowAutoRepairRounds(state.plan) >= maxAutoRepairRounds) {
			const message: string = `验证阶段「${phase.title}」仍发现需要修复的问题，已达到自动修复次数上限。`;
			const blockedOutcome: WorkflowPhaseOutput = { ...outcome, status: "blocked", summary: message, blockedReason: message };
			const plan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "failed");
			return {
				type: "failed",
				phase,
				outcome: blockedOutcome,
				state: { ...state, plan, phaseOutputs: appendPhaseOutput(state.phaseOutputs, phase, blockedOutcome) }
			};
		}

		const failedPlan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "failed");
		const plan: WorkflowPlan = insertWorkflowAutoRepairPhases(failedPlan, state.phaseIndex + 1, phase, outcome.summary, outcome.failedChecks);
		return {
			type: "repair",
			phase,
			outcome,
			state: {
				...state,
				plan,
				phaseIndex: state.phaseIndex + 1,
				phaseOutputs: appendPhaseOutput(state.phaseOutputs, phase, outcome)
			}
		};
	}

	if (outcome.status === "blocked" || outcome.status === "failed") {
		const plan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "failed");
		return {
			type: "failed",
			phase,
			outcome,
			state: { ...state, plan, phaseOutputs: appendPhaseOutput(state.phaseOutputs, phase, outcome) }
		};
	}

	const plan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "done");
	return {
		type: "complete_phase",
		phase,
		outcome,
		state: {
			...state,
			plan,
			phaseIndex: state.phaseIndex + 1,
			phaseOutputs: appendPhaseOutput(state.phaseOutputs, phase, outcome)
		}
	};
}

export function scheduleWorkflowApproval(
	state: WorkflowRunState,
	phase: WorkflowPhase,
	outcome: WorkflowPhaseOutput,
	phaseRunId: string
): Extract<WorkflowSchedulerCommand, { type: "pause_for_approval" }> {
	const plan: WorkflowPlan = updateWorkflowPhaseStatus(state.plan, phase.id, "paused");
	return {
		type: "pause_for_approval",
		phase,
		outcome,
		state: {
			...state,
			plan,
			phaseOutputs: appendPhaseOutput(state.phaseOutputs, phase, outcome),
			activePhaseRunId: phaseRunId
		}
	};
}
