import WebSocket from "ws";
import type { ServerEvent } from "../../protocol/types.js";
import type { ClientSession } from "../client-session.js";
import { createWorkflowTodoSnapshot } from "../../workflow/runner.js";
import type { WorkflowPhaseOutput, WorkflowPlan } from "../../workflow/types.js";
import { sendSessionEvent } from "../session-events.js";

export function sendWorkflowEvent(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	eventName: ServerEvent["event"],
	data: unknown,
	persistRequestId: string = requestId
): void {
	const agentEvent = mapWorkflowEventToAgentEvent(eventName, data);
	if (agentEvent === null) {
		return;
	}
	sendSessionEvent(socket, requestId, session, agentEvent.eventName, agentEvent.data, persistRequestId);
}

export function mapWorkflowEventToAgentEvent(eventName: ServerEvent["event"], data: unknown): { eventName: ServerEvent["event"]; data: unknown } | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return null;
	}

	const record: Record<string, unknown> = data as Record<string, unknown>;
	const workflowId: string = String(record.workflowId ?? record.runId ?? "");
	if (eventName === "workflow.started") {
		return null;
	}
	if (eventName === "workflow.todo.updated") {
		return {
			eventName: "agent.run.snapshot",
			data: convertWorkflowSnapshotToAgentSnapshot(record)
		};
	}
	if (eventName === "workflow.phase.started") {
		return {
			eventName: "agent.step.started",
			data: {
				runId: workflowId,
				stepId: record.phaseId,
				stepRunId: record.phaseRunId,
				title: record.title,
				toolGroup: record.toolGroup,
				acceptanceCriteria: record.acceptanceCriteria,
				repairOf: record.repairOf,
				repairRound: record.repairRound
			}
		};
	}
	if (eventName === "workflow.phase.outcome") {
		const outcome: unknown = record.outcome;
		return {
			eventName: "agent.step.outcome",
			data: {
				runId: workflowId,
				stepId: record.phaseId,
				stepRunId: record.phaseRunId,
				outcome
			}
		};
	}
	if (eventName === "workflow.done") {
		return {
			eventName: "agent.run.done",
			data: {
				runId: workflowId,
				requestId: record.requestId ?? null,
				status: "done",
				title: record.title,
				sequence: record.sequence
			}
		};
	}
	if (eventName === "workflow.error") {
		return {
			eventName: "agent.run.error",
			data: {
				runId: workflowId,
				requestId: record.requestId ?? null,
				status: "error",
				title: record.title,
				code: record.code ?? "agent_run_error",
				message: record.message,
				sequence: record.sequence
			}
		};
	}
	if (eventName === "workflow.phase.done") {
		return null;
	}

	return {
		eventName,
		data
	};
}

export function convertWorkflowSnapshotToAgentSnapshot(record: Record<string, unknown>): Record<string, unknown> {
	return {
		runId: record.workflowId ?? record.runId,
		title: record.title,
		source: record.source,
		revision: record.revision,
		steps: record.phases,
		todos: record.todos,
		outcomes: record.phaseOutcomes ?? record.outcomes ?? [],
		activeStepRunId: record.activePhaseRunId ?? record.activeStepRunId,
		repairRound: record.repairRound,
		blockedReason: record.blockedReason
	};
}

export function sendWorkflowTodoSnapshot(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	plan: WorkflowPlan,
	persistRequestId: string = requestId,
	phaseOutputs: WorkflowPhaseOutput[] = [],
	activePhaseRunId?: string | undefined
): void {
	sendWorkflowEvent(
		socket,
		requestId,
		session,
		"workflow.todo.updated",
		createWorkflowTodoSnapshot(plan, phaseOutputs, activePhaseRunId),
		persistRequestId
	);
}
