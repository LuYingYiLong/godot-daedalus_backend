import type { WorkflowPhaseOutput, WorkflowPlan } from "../../workflow/types.js";

export class WorkflowExecutionError extends Error {
	readonly plan: WorkflowPlan;
	readonly originalError: unknown;
	readonly phaseOutputs: WorkflowPhaseOutput[];

	constructor(message: string, plan: WorkflowPlan, originalError: unknown, phaseOutputs: WorkflowPhaseOutput[] = []) {
		super(message);
		this.name = "WorkflowExecutionError";
		this.plan = plan;
		this.originalError = originalError;
		this.phaseOutputs = phaseOutputs;
	}
}
