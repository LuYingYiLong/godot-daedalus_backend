import type { ToolBudgetLimitKind } from "../providers/agent-types.js";
import type { PendingAiContinuation } from "./pending-continuation.js";
import type { WorkflowToolObservation } from "../workflow/types.js";

export type PendingToolBudgetPhaseStats = {
	toolEvents: number;
	proposeToolEvents: number;
	writeToolEvents: number;
	approvalEvents: number;
};

export type PendingToolBudget = {
	budgetId: string;
	requestId: string;
	reason: string;
	limitKind: ToolBudgetLimitKind;
	usedSteps: number;
	maxSteps: number;
	totalToolResultChars: number;
	toolResultCharLimit: number;
	additionalSteps: number;
	createdAt: string;
	continuation: PendingAiContinuation;
	workflowPhaseToolStats?: PendingToolBudgetPhaseStats | undefined;
	workflowToolObservations?: WorkflowToolObservation[] | undefined;
};

export function serializePendingToolBudget(pending: PendingToolBudget): Record<string, unknown> {
	return {
		budgetId: pending.budgetId,
		requestId: pending.requestId,
		reason: pending.reason,
		limitKind: pending.limitKind,
		usedSteps: pending.usedSteps,
		maxSteps: pending.maxSteps,
		totalToolResultChars: pending.totalToolResultChars,
		toolResultCharLimit: pending.toolResultCharLimit,
		additionalSteps: pending.additionalSteps,
		createdAt: pending.createdAt
	};
}
