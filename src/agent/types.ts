import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type {
	WorkflowFailedCheck,
	WorkflowPhase,
	WorkflowPhaseOutput,
	WorkflowPhaseOutcomeStatus,
	WorkflowPlan,
	WorkflowTodoItem,
	WorkflowTodoStatus,
	WorkflowToolGroup,
	WorkflowToolObservation
} from "../workflow/types.js";

export type AgentRunStatus = "running" | "paused" | "done" | "error" | "cancelled";
export type AgentStepStatus = WorkflowTodoStatus | "blocked" | "repairing";
export type AgentStepOutcomeStatus = WorkflowPhaseOutcomeStatus;
export type AgentToolGroup = WorkflowToolGroup | "answer";
export type AgentStep = WorkflowPhase;
export type AgentFailedCheck = WorkflowFailedCheck;
export type AgentToolObservation = WorkflowToolObservation;
export type AgentStepOutcome = WorkflowPhaseOutput;

export type AgentRunState = {
	runId: string;
	requestId: string;
	status: AgentRunStatus;
	steps: AgentStep[];
	outcomes: AgentStepOutcome[];
	activeStepRunId?: string | undefined;
	originalParams: AiChatParams;
	history: ChatMessage[];
	context?: Record<string, unknown> | undefined;
};

export type AgentSnapshot = {
	runId: string;
	title: string;
	status?: AgentRunStatus | undefined;
	steps: Array<{
		id: string;
		title: string;
		status: AgentStepStatus;
	}>;
	todos: WorkflowTodoItem[];
	outcomes: AgentStepOutcome[];
	activeStepRunId?: string | undefined;
	blockedReason?: string | undefined;
	repairRound?: number | undefined;
};

export function createAgentSnapshotFromWorkflowPlan(
	plan: WorkflowPlan,
	outcomes: AgentStepOutcome[] = [],
	activeStepRunId?: string | undefined,
	status?: AgentRunStatus | undefined
): AgentSnapshot {
	const blockedReason: string | undefined = findLastBlockedReason(outcomes);
	return {
		runId: plan.id,
		title: plan.title,
		status,
		steps: plan.phases.map((phase: WorkflowPhase) => ({
			id: phase.id,
			title: phase.title,
			status: getStepStatus(plan, phase.id)
		})),
		todos: plan.todos.map((todo: WorkflowTodoItem): WorkflowTodoItem => ({ ...todo })),
		outcomes: outcomes.map((outcome: AgentStepOutcome): AgentStepOutcome => ({ ...outcome })),
		activeStepRunId,
		blockedReason,
		repairRound: Math.max(0, ...plan.phases.map((phase: WorkflowPhase): number => phase.repairRound ?? 0))
	};
}

function getStepStatus(plan: WorkflowPlan, stepId: string): AgentStepStatus {
	const stepTodos: WorkflowTodoItem[] = plan.todos.filter((todo: WorkflowTodoItem): boolean => todo.phaseId === stepId);
	if (stepTodos.some((todo: WorkflowTodoItem): boolean => todo.status === "failed")) {
		const phase: WorkflowPhase | undefined = plan.phases.find((item: WorkflowPhase): boolean => item.id === stepId);
		return phase?.repairOf !== undefined ? "repairing" : "failed";
	}
	if (stepTodos.some((todo: WorkflowTodoItem): boolean => todo.status === "paused")) {
		return "paused";
	}
	if (stepTodos.some((todo: WorkflowTodoItem): boolean => todo.status === "running")) {
		return "running";
	}
	if (stepTodos.length > 0 && stepTodos.every((todo: WorkflowTodoItem): boolean => todo.status === "done")) {
		return "done";
	}

	return "pending";
}

function findLastBlockedReason(outcomes: AgentStepOutcome[]): string | undefined {
	for (let index: number = outcomes.length - 1; index >= 0; index -= 1) {
		const outcome: AgentStepOutcome | undefined = outcomes[index];
		if (outcome?.status === "blocked") {
			return outcome.blockedReason ?? outcome.summary;
		}
	}

	return undefined;
}
