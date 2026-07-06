import WebSocket from "ws";
import type { AiChatParams } from "../protocol/types.js";
import type { AgentContinuation, ProviderAgentResult } from "../providers/agent-types.js";
import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import { appendApprovalEvent, readApprovalEvents } from "../session/session-store.js";
import { createPersistedApprovalRequestedData, createRuntimePendingContinuation, foldPendingApprovalStates, type PendingApprovalState } from "../session/approval-persistence.js";
import type { WorkflowRunState, WorkflowToolObservation } from "../workflow/types.js";
import { getToolPolicy } from "../tools/tool-policy.js";
import type { PendingApproval } from "../tools/approval-gateway.js";
import { getLlmToolExecutionIdentity } from "../tools/tool-idempotency.js";
import { resolveToolMapping } from "../tools/tool-mapping.js";
import { parseToolResultSummary } from "../tools/tool-result-parser.js";
import { McpHost } from "../mcp/mcp-host.js";
import type { ClientSession, PendingAiContinuation } from "./client-session.js";
import { appendChatTurnToSession } from "./token-budget.js";
import { sendSessionEvent } from "./session-events.js";

export function createPendingAiContinuation(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	allowedToolNames: readonly string[] | undefined,
	userMessage: string,
	requestId: string,
	userCreatedAt: string,
	stream: boolean,
	workflowState?: WorkflowRunState | undefined
): PendingAiContinuation {
	const pendingContinuation: PendingAiContinuation = {
		params,
		options,
		continuation,
		userMessage,
		requestId,
		userCreatedAt,
		stream
	};

	if (allowedToolNames !== undefined) {
		pendingContinuation.allowedToolNames = allowedToolNames;
	}

	if (workflowState !== undefined) {
		pendingContinuation.agentRunState = workflowState;
		pendingContinuation.workflowState = workflowState;
	}

	return pendingContinuation;
}

export async function persistApprovalRequested(
	session: ClientSession,
	mcpHost: McpHost,
	approvalId: string,
	pendingContinuation: PendingAiContinuation
): Promise<void> {
	if (session.sessionId === undefined) {
		return;
	}

	const pendingApproval: PendingApproval | undefined = session.approvalGateway.getPending(approvalId);
	if (pendingApproval === undefined) {
		return;
	}

	await appendApprovalEvent(
		session.sessionId,
		approvalId,
		pendingContinuation.requestId,
		"requested",
		createPersistedApprovalRequestedData(pendingApproval, pendingContinuation, mcpHost.getActiveWorkspaceId())
	);
}

export async function registerPendingApprovalContinuation(
	session: ClientSession,
	mcpHost: McpHost,
	approvalId: string,
	pendingContinuation: PendingAiContinuation
): Promise<void> {
	session.pendingAiContinuations.set(approvalId, pendingContinuation);
	await persistApprovalRequested(session, mcpHost, approvalId, pendingContinuation);
}

export async function loadHydratedPendingApprovalStates(
	session: ClientSession,
	apiKey?: string | undefined
): Promise<{ states: PendingApprovalState[]; hadEvents: boolean }> {
	if (session.sessionId === undefined) {
		return {
			states: createMemoryPendingApprovalStates(session),
			hadEvents: false
		};
	}

	const approvalEvents = await readApprovalEvents(session.sessionId);
	if (approvalEvents.length === 0) {
		return {
			states: createMemoryPendingApprovalStates(session),
			hadEvents: false
		};
	}

	const states: PendingApprovalState[] = foldPendingApprovalStates(approvalEvents);
	session.approvalGateway.replacePending(states.map((state: PendingApprovalState): PendingApproval => state.approval));
	const pendingIds: Set<string> = new Set(states.map((state: PendingApprovalState): string => state.approval.approvalId));
	for (const approvalId of session.pendingAiContinuations.keys()) {
		if (!pendingIds.has(approvalId)) {
			session.pendingAiContinuations.delete(approvalId);
		}
	}

	if (apiKey !== undefined) {
		for (const state of states) {
			if (state.continuation !== undefined) {
				session.pendingAiContinuations.set(state.approval.approvalId, createRuntimePendingContinuation(state.continuation, apiKey));
			}
		}
	}

	return {
		states,
		hadEvents: true
	};
}

export function createMemoryPendingApprovalStates(session: ClientSession): PendingApprovalState[] {
	return session.approvalGateway.listPending().map((pendingApproval: PendingApproval): PendingApprovalState => {
		const timestamp: string = new Date(pendingApproval.createdAt).toISOString();
		return {
			approval: pendingApproval,
			status: "pending",
			restored: false,
			interrupted: false,
			requestId: "",
			createdAt: timestamp,
			updatedAt: timestamp
		};
	});
}

export function findPendingApprovalState(states: PendingApprovalState[], approvalId: string): PendingApprovalState | undefined {
	return states.find((state: PendingApprovalState): boolean => state.approval.approvalId === approvalId);
}

export async function restorePendingContinuationForApproval(
	session: ClientSession,
	state: PendingApprovalState | undefined,
	apiKey: string | undefined
): Promise<PendingAiContinuation | undefined> {
	const approvalId: string | undefined = state?.approval.approvalId;
	if (approvalId !== undefined) {
		const existingContinuation: PendingAiContinuation | undefined = session.pendingAiContinuations.get(approvalId);
		if (existingContinuation !== undefined) {
			return existingContinuation;
		}
	}

	if (state?.continuation === undefined || apiKey === undefined) {
		return undefined;
	}

	const restoredContinuation: PendingAiContinuation = createRuntimePendingContinuation(state.continuation, apiKey);
	session.pendingAiContinuations.set(state.approval.approvalId, restoredContinuation);
	return restoredContinuation;
}

export async function validatePendingApprovalBeforeExecution(
	session: ClientSession,
	mcpHost: McpHost,
	pendingApproval: PendingApproval
): Promise<string | null> {
	const decision = await session.approvalGateway.evaluate(pendingApproval.llmToolName, pendingApproval.args, pendingApproval.toolCallId);
	if (decision.action === "deny") {
		return decision.reason;
	}

	try {
		resolveToolMapping(pendingApproval.llmToolName);
	} catch (error: unknown) {
		return error instanceof Error ? error.message : "审批工具当前不可用";
	}

	const currentIdentity = getLlmToolExecutionIdentity(
		pendingApproval.llmToolName,
		pendingApproval.args,
		mcpHost.getActiveWorkspaceId()
	);
	if (
		pendingApproval.executionFingerprint !== undefined
		&& currentIdentity !== undefined
		&& currentIdentity.fingerprint !== pendingApproval.executionFingerprint
	) {
		return "当前 workspace 与创建审批时不一致，不能执行该审批。";
	}

	return null;
}

export function createApprovedWorkflowToolObservation(pendingApproval: PendingApproval, content: string): WorkflowToolObservation {
	const parsedResult = parseToolResultSummary(pendingApproval.llmToolName, pendingApproval.args, content);
	const failed: boolean = parsedResult.validationStatus === "failed" || parsedResult.ok === false;
	return {
		toolCallId: pendingApproval.toolCallId,
		toolName: pendingApproval.llmToolName,
		risk: getToolPolicy(pendingApproval.llmToolName)?.risk,
		status: failed ? "failed" : "succeeded",
		argsSummary: {},
		parsedResult: {
			...parsedResult
		},
		artifactRefs: parsedResult.artifactRefs ?? []
	};
}

export function sendAgentPaused(socket: WebSocket, requestId: string, session: ClientSession, runId: string, agentResult: Extract<ProviderAgentResult, { status: "approval_required" }>, persistRequestId: string = requestId): void {
	sendSessionEvent(socket, requestId, session, "agent.run.paused", {
		runId,
		reason: "approval_required",
		approvalId: agentResult.approvalId,
		toolName: agentResult.toolName,
		message: `工具 ${agentResult.toolName} 需要审批：${agentResult.approvalId}`
	}, persistRequestId);
}

export async function sendContinuedAgentResult(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	mcpHost: McpHost,
	agentResult: ProviderAgentResult,
	pendingContinuation: PendingAiContinuation,
	historyBudgetTokens: number | null = null
): Promise<void> {
	if (agentResult.status === "approval_required") {
		const nextPendingContinuation: PendingAiContinuation = createPendingAiContinuation(
			pendingContinuation.params,
			pendingContinuation.options,
			agentResult.continuation,
			pendingContinuation.allowedToolNames,
			pendingContinuation.userMessage,
			pendingContinuation.requestId,
			pendingContinuation.userCreatedAt,
			pendingContinuation.stream,
			pendingContinuation.workflowState
		);
		await registerPendingApprovalContinuation(session, mcpHost, agentResult.approvalId, nextPendingContinuation);
		sendAgentPaused(socket, requestId, session, pendingContinuation.workflowState?.plan.id ?? pendingContinuation.requestId, agentResult, pendingContinuation.requestId);
		return;
	}

	const text: string = agentResult.text;
	const runId: string = pendingContinuation.workflowState?.plan.id ?? pendingContinuation.requestId;
	const stepRunId: string = pendingContinuation.workflowState?.activePhaseRunId ?? pendingContinuation.requestId;

	if (!pendingContinuation.stream) {
		for (let index: number = 0; index < text.length; index += 1) {
			sendSessionEvent(socket, requestId, session, "agent.message.delta", {
				runId,
				stepRunId,
				text: text[index]
			}, pendingContinuation.requestId);
		}
	}

	await appendChatTurnToSession(
		session,
		[],
		pendingContinuation.userMessage,
		text,
		pendingContinuation.requestId,
		pendingContinuation.userCreatedAt,
		undefined,
		pendingContinuation.params.additionalContext
	);
	sendSessionEvent(socket, requestId, session, "agent.message.done", {
		runId,
		stepRunId,
		text,
		context: {
			historyMessagesStored: session.messages.length,
			historyBudgetTokens,
			mcpServers: mcpHost.getConnectedServerIds()
		}
	}, pendingContinuation.requestId);
}
