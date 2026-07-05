import WebSocket from "ws";
import { composeSystemPrompt, listPromptTemplates } from "../prompts/registry.js";
import type { AdditionalContextItem, AiChatParams, ChatMessage, ClientRequest, ModelProfile, ProviderId, ServerEvent } from "../protocol/types.js";
import {
	continueDeepSeekAgent,
	continueDeepSeekAgentStreaming,
	runDeepSeekAgent,
	runDeepSeekAgentStreaming,
	type DeepSeekAgentContinuation,
	type DeepSeekAgentResult
} from "../providers/deepseek-agent.js";
import type { OnToolEvent, ToolEvent } from "../tools/tool-dispatcher.js";
import { parseToolResultSummary } from "../tools/tool-result-parser.js";
import { chatWithDeepSeek, createDeepSeekClient, resolveChatModel, type ProviderChatOptions } from "../providers/deepseek-client.js";
import { McpHost } from "../mcp/mcp-host.js";
import type { CustomMcpServerRuntimeStatus } from "../mcp/mcp-host.js";
import {
	addCustomMcpServerConfig,
	listCustomMcpServerSummaries,
	removeCustomMcpServerConfig,
	setCustomMcpServerEnabled,
	type CustomMcpServerSummary
} from "../mcp/custom-mcp-config-store.js";
import { sendJson } from "./send-json.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDefaultModelProfile, resolveModelProfile } from "../tokens/model-profiles.js";
import { type TokenCounter } from "../tokens/token-counter.js";
import { createTokenCounter } from "../tokens/token-counter-factory.js";
import { computeInputBudget, selectMessagesWithinBudget } from "../session/session-compressor.js";
import { composeSkillPrompt, getSkill, isSkillId, listSkills } from "../skills/registry.js";
import type { SkillId } from "../skills/registry.js";
import {
	createRuntimeWorkspace,
	loadWorkspaces,
	findWorkspace,
	getDefaultWorkspace,
	upsertRuntimeWorkspace
} from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import {
	createSession, openSession, saveSession, listSessions,
	archiveSession, deleteArchivedSession, deleteSession, listArchivedSessions, renameSession, restoreArchivedSession,
	rewindSessionFromRequest,
	readSummary, writeSummary,
	appendSessionEvent, appendApprovalEvent, appendWorkflowEvent, appendAgentEvent, clearSessionEvents, readApprovalEvents,
	openSessionRecentTimeline, openSessionTimelinePage,
	type SessionMetadata,
	type SessionSummary,
	type StoredMessage,
	type StoredSessionEvent,
	type StoredSessionTimelinePage
} from "../session/session-store.js";
import {
	clearProviderConfig,
	getProviderConfigStatus,
	loadProviderConfigWithSecret,
	saveProviderConfig,
	type ProviderConfigWithSecret
} from "../providers/provider-config-store.js";
import { listProviderModels } from "../providers/provider-models.js";
import { estimateProviderMessagesTokens, estimateProviderTextTokens } from "../providers/provider-token-estimator.js";
import {
	createCurrentUserMessage,
	getImageAttachments,
	hasImageAttachments,
	modelSupportsImageInput,
	ProviderImageInputError
} from "../providers/provider-image-content.js";
import { getProviderDefaultBaseUrl, getProviderDefaultModel, getProviderDisplayName } from "../providers/provider-registry.js";
import { classifyProviderError, createProviderStatusEvent } from "../providers/provider-error.js";
import { generateSessionTitle, shouldApplyGeneratedSessionTitle } from "./session-title.js";
import { createSingleAnswerPlan, planWorkflow, READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "../workflow/planner.js";
import { createLlmWorkflowPlan, reviseLlmWorkflowPlan } from "../workflow/llm-planner.js";
import {
	applyDeterministicVerificationGate,
	applyToolEventToWorkflowObservations,
	createWorkflowPhaseOutcome,
	createWorkflowPhaseRunId,
	findBlockingOutcomeBeforeSummarize
} from "../workflow/outcome.js";
import {
	appendPhaseOutput,
	createPhaseMessage,
	createPhaseParams,
	createPhasePrompt,
	createWorkflowTodoSnapshot,
	markRemainingWorkflowTodos,
	updateWorkflowPhaseStatus
} from "../workflow/runner.js";
import { countWorkflowAutoRepairRounds, insertWorkflowAutoRepairPhases } from "../workflow/repair.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowPlan, WorkflowRunState, WorkflowToolObservation } from "../workflow/types.js";
import {
	clearActiveSession,
	type ClientSession,
	type PendingAiContinuation,
	type PendingGuide,
	type ThinkingEventBuffer
} from "./client-session.js";
import { getToolPolicy } from "../tools/tool-policy.js";
import type { PendingApproval } from "../tools/approval-gateway.js";
import { getLlmToolExecutionIdentity } from "../tools/tool-idempotency.js";
import { resolveToolMapping } from "../tools/llm-tools.js";
import {
	createPersistedApprovalRequestedData,
	createRuntimePendingContinuation,
	foldPendingApprovalStates,
	serializePendingApprovalState,
	type PendingApprovalState
} from "../session/approval-persistence.js";
import { createBackendHealthResult } from "./backend-health.js";
import {
	createSlashCommandListResult,
	handleSlashCommand,
	type SlashCommandResult
} from "./slash-commands.js";

import {
	tokenCounterPromise,
	sessionCompressorPromptCache,
	DEFAULT_SESSION_OPEN_MESSAGE_LIMIT,
	MAX_SESSION_OPEN_MESSAGE_LIMIT,
	DEFAULT_SESSION_OPEN_EVENT_LIMIT,
	MAX_SESSION_OPEN_EVENT_LIMIT,
	SESSION_OPEN_PREVIEW_STRING_LIMIT,
	SESSION_OPEN_PREVIEW_ARRAY_LIMIT,
	THINKING_EVENT_FLUSH_CHARS,
	REQUEST_DEDUP_TTL_MS,
	MAX_COMPLETED_REQUEST_IDS,
	CUSTOM_INSTRUCTIONS_TRACE_WARNING_CHARS,
	DEFAULT_NEXT_STEP_HINT_COUNT,
	MAX_NEXT_STEP_HINT_COUNT,
	MAX_NEXT_STEP_HINT_MESSAGE_CHARS,
	MAX_GUIDE_TEXT_CHARS,
	MAX_WORKFLOW_AUTO_REPAIR_ROUNDS,
	fingerprintText,
	logPromptTrace,
	logProjectInstructionTrace,
	getTokenCounter,
	loadSessionCompressorPrompt,
	isCancellationError,
	sendAgentCancelled,
	sendAiCancelled,
	pruneCompletedRequestIds,
	beginRequestExecution,
	finishRequestExecution,
	parseMessage,
	estimateTextTokens,
	estimateMessagesTokens,
	estimateTextTokensForProvider,
	estimateCurrentMessageTokensForProvider,
	selectHistoryWithinBudget,
	computeHistoryBudget,
	appendChatTurnToSession,
	selectHistoryForModel,
	createSummaryMessage,
	getSessionProjectPath,
	toChatMessage,
	clampSessionOpenMessageLimit,
	createPreviewValue,
	createSessionEventPreview,
	createTimelinePageResult,
	startFullSessionLoad,
	waitForFullSessionLoad,
	createProviderChatOptions,
	createGuideId,
	clipTextByChars,
	cloneAdditionalContextItems,
	getAdditionalContextDataRecord,
	getContextNumber,
	getContextString,
	createLineColumnRangeText,
	appendScriptSelectionPromptLines,
	appendFilesystemSelectionPromptLines,
	createAdditionalContextPromptSection,
	createPendingGuide,
	serializePendingGuide,
	findPendingGuideIndexById,
	findPendingGuideByClientId,
	readEventDataObject,
	hydratePendingGuides,
	persistGuideEvent,
	formatGuidePromptSection,
	consumePendingGuideSection,
	parseJsonObjectLoose,
	normalizeNextStepHints,
	createNextStepHintPrompt,
	createNextStepHints,
	resolveAllowedToolsForChatParams,
	shouldPersistSessionEvent,
	getThinkingEventBufferKey,
	getThinkingDeltaText,
	getWorkflowIdFromEventData,
	getAgentRunIdFromEventData,
	enqueueSessionEventWrite,
	flushThinkingEventBuffer,
	flushAllThinkingEventBuffers,
	flushAiDeltaEventBuffer,
	flushAllAiDeltaEventBuffers,
	waitForSessionEventPersistence,
	persistSessionEvent,
	sendSessionEvent,
	sendGlobalEvent,
	maybeScheduleSessionTitleGeneration,
	WorkflowExecutionError
} from "./websocket-support.js";
import type { WorkflowPhaseToolStats, WorkflowPhaseRunResult, NextStepHint } from "./websocket-support.js";
import { createMcpSystemContext, createProviderRuntimeContext } from "./prompt-context.js";

export function createAgentToolEventForwarder(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	runId: string,
	stepRunId: string,
	persistRequestId: string = requestId
): OnToolEvent {
	return (event: ToolEvent): void => {
		if (event.type === "ai.delta") {
			sendSessionEvent(socket, requestId, session, "agent.message.delta", {
				runId,
				stepRunId,
				text: event.text
			}, persistRequestId);
			return;
		}
		if (event.type === "ai.thinking.delta") {
			sendSessionEvent(socket, requestId, session, "agent.thinking.delta", {
				runId,
				stepRunId,
				text: event.text
			}, persistRequestId);
			return;
		}
		if (event.type === "ai.thinking.done") {
			sendSessionEvent(socket, requestId, session, "agent.thinking.done", {
				runId,
				stepRunId
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.call") {
			sendSessionEvent(socket, requestId, session, "agent.tool.call", {
				...event,
				type: "agent.tool.call",
				runId,
				stepRunId
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.result") {
			sendSessionEvent(socket, requestId, session, "agent.tool.result", {
				...event,
				type: "agent.tool.result",
				runId,
				stepRunId
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.error") {
			sendSessionEvent(socket, requestId, session, "agent.tool.error", {
				...event,
				type: "agent.tool.error",
				runId,
				stepRunId
			}, persistRequestId);
			return;
		}
		if (event.type === "tool.approval_required") {
			sendSessionEvent(socket, requestId, session, "agent.tool.approval_required", {
				...event,
				type: "agent.tool.approval_required",
				runId,
				stepRunId
			}, persistRequestId);
		}
	};
}

export function createEmptyWorkflowPhaseToolStats(): WorkflowPhaseToolStats {
	return {
		toolEvents: 0,
		proposeToolEvents: 0,
		writeToolEvents: 0,
		approvalEvents: 0
	};
}

export function updateWorkflowPhaseToolStats(stats: WorkflowPhaseToolStats, event: ToolEvent): void {
	if (!event.type.startsWith("tool.")) {
		return;
	}

	stats.toolEvents += 1;

	if (event.type === "tool.approval_required") {
		stats.approvalEvents += 1;
	}

	const toolName: string | undefined = "toolName" in event ? event.toolName : undefined;
	if (toolName === undefined) {
		return;
	}

	const policy = getToolPolicy(toolName);
	if (policy?.risk === "propose") {
		stats.proposeToolEvents += 1;
	}
	if (policy?.risk === "write" || policy?.risk === "destructive") {
		stats.writeToolEvents += 1;
	}
}

export function shouldRequireWorkflowWriteTool(phase: WorkflowPhase): boolean {
	return phase.toolGroup === "write";
}

export function didWorkflowWritePhaseExecute(phase: WorkflowPhase, stats: WorkflowPhaseToolStats): boolean {
	if (stats.writeToolEvents > 0 || stats.approvalEvents > 0) {
		return true;
	}

	return isWorkflowProposalPhase(phase) && stats.proposeToolEvents > 0;
}

export function isWorkflowProposalPhase(phase: WorkflowPhase): boolean {
	const text: string = `${phase.id}\n${phase.title}\n${phase.instruction}`.toLowerCase();
	return text.includes("propose")
		|| text.includes("preview")
		|| text.includes("diff")
		|| text.includes("预览")
		|| text.includes("提案")
		|| text.includes("方案");
}

export function createWorkflowWriteGuardRetryMessage(phaseMessage: string): string {
	return [
		phaseMessage,
		"",
		"## 后端执行守卫",
		"上一次候选回复没有实际调用当前阶段需要的 propose/write 工具，也没有触发审批，因此当前阶段还没有完成。",
		"如果当前阶段是预览/提案，请调用允许的 propose_* 工具；如果当前阶段是实际修改，请调用写入工具并按审批流程暂停。",
		"不要只描述计划、步骤或意图。"
	].join("\n");
}

import {
	createPendingAiContinuation,
	registerPendingApprovalContinuation,
	sendAgentPaused
} from "./approval-continuation.js";

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
		return {
			eventName: "agent.run.started",
			data: {
				runId: workflowId,
				requestId: record.requestId ?? null,
				title: record.title,
				source: record.source,
				steps: record.phases
			}
		};
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
				title: record.title
			}
		};
	}
	if (eventName === "workflow.error") {
		return {
			eventName: "agent.run.error",
			data: {
				runId: workflowId,
				title: record.title,
				code: record.code ?? "agent_run_error",
				message: record.message
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

export async function runWorkflowPhase(
	socket: WebSocket,
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	fullSystemPrompt: string,
	phase: WorkflowPhase,
	mcpHost: McpHost,
	session: ClientSession,
	requestId: string,
	persistRequestId: string,
	runId: string,
	stepRunId: string,
	streamPhase: boolean,
	abortSignal?: AbortSignal | undefined
): Promise<WorkflowPhaseRunResult> {
	const toolStats: WorkflowPhaseToolStats = createEmptyWorkflowPhaseToolStats();
	let toolObservations: WorkflowToolObservation[] = [];
	const forwardToolEvent: OnToolEvent = createAgentToolEventForwarder(socket, requestId, session, runId, stepRunId, persistRequestId);
	const onToolEvent: OnToolEvent = (event: ToolEvent): void => {
		updateWorkflowPhaseToolStats(toolStats, event);
		toolObservations = applyToolEventToWorkflowObservations(toolObservations, event);
		forwardToolEvent(event);
	};
	const agentResult: DeepSeekAgentResult = streamPhase
		? await runDeepSeekAgentStreaming(params, options, history, fullSystemPrompt, mcpHost, session.approvalGateway, phase.allowedTools, onToolEvent, abortSignal)
		: await runDeepSeekAgent(params, options, history, fullSystemPrompt, mcpHost, session.approvalGateway, phase.allowedTools, onToolEvent, abortSignal);
	return {
		agentResult,
		toolStats,
		toolObservations
	};
}

export async function createWorkflowPhasePrompt(
	phase: WorkflowPhase,
	params: AiChatParams,
	mcpHost: McpHost,
	session: ClientSession,
	requestId: string,
	guidePromptSection: string = ""
): Promise<string> {
	const systemPrompt: string = await composeSystemPrompt(phase.promptId ?? params.promptId, params.systemPrompt, createProviderRuntimeContext(session));
	const skillPrompt: string = await composeSkillPrompt(phase.skillId);
	const mcpSystemContext: string = await createMcpSystemContext(mcpHost, session);
	const additionalContextSection: string = createAdditionalContextPromptSection(params.additionalContext);
	const fullSystemPrompt: string = [
		systemPrompt,
		createPhasePrompt(phase, skillPrompt, mcpSystemContext),
		additionalContextSection,
		guidePromptSection
	].join("\n\n");
	logPromptTrace({
		requestId,
		phaseId: phase.id,
		promptId: phase.promptId ?? params.promptId,
		skillId: phase.skillId,
		customInstructions: params.systemPrompt,
		systemPrompt,
		skillPrompt,
		mcpSystemContext,
		additionalContextSection,
		guidePromptSection,
		fullSystemPrompt
	});
	return fullSystemPrompt;
}

export function createWorkflowPendingContinuation(
	phaseParams: AiChatParams,
	options: ProviderChatOptions,
	agentResult: Extract<DeepSeekAgentResult, { status: "approval_required" }>,
	phase: WorkflowPhase,
	workflowState: WorkflowRunState,
	requestId: string,
	userCreatedAt: string,
	streamPhase: boolean
): PendingAiContinuation {
	return createPendingAiContinuation(
		phaseParams,
		options,
		agentResult.continuation,
		phase.allowedTools,
		workflowState.originalParams.message,
		requestId,
		userCreatedAt,
		streamPhase,
		workflowState
	);
}

export async function continueWorkflowExecution(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	mcpHost: McpHost,
	options: ProviderChatOptions,
	workflowState: WorkflowRunState,
	userCreatedAt: string,
	initialAgentResult?: DeepSeekAgentResult | undefined,
	persistRequestId: string = requestId,
	abortSignal?: AbortSignal | undefined,
	initialToolObservations: WorkflowToolObservation[] = []
): Promise<void> {
	let state: WorkflowRunState = workflowState;
	let plan: WorkflowPlan = state.plan;
	let phaseOutputs = state.phaseOutputs;
	let agentResultOverride: DeepSeekAgentResult | undefined = initialAgentResult;
	let agentResultOverrideToolObservations: WorkflowToolObservation[] = initialToolObservations;
	const streamFinal: boolean = state.originalParams.options?.stream === true;
	const planningContext: string = state.planningContext ?? "";

	for (let index: number = state.phaseIndex; index < plan.phases.length; index += 1) {
		const phase: WorkflowPhase | undefined = plan.phases[index];
		if (phase === undefined) {
			break;
		}

		const phaseRunId: string = createWorkflowPhaseRunId(phase.id);
		if (phase.toolGroup === "summarize") {
			const blockingOutcome: WorkflowPhaseOutput | null = findBlockingOutcomeBeforeSummarize(phaseOutputs);
			if (blockingOutcome !== null) {
				const guardMessage: string = `总结阶段被阻止：阶段「${blockingOutcome.title}」仍处于 ${blockingOutcome.status}，不能交付完成总结。`;
				const blockedOutcome: WorkflowPhaseOutput = {
					phaseId: phase.id,
					phaseRunId,
					title: phase.title,
					status: "blocked",
					summary: guardMessage,
					evidence: [],
					failedChecks: blockingOutcome.failedChecks,
					requiredFixes: blockingOutcome.requiredFixes,
					modifiedArtifacts: [],
					verifiedArtifacts: [],
					toolObservations: [],
					sourcePhaseId: blockingOutcome.phaseId,
					blockedReason: guardMessage
				};
				phaseOutputs = appendPhaseOutput(phaseOutputs, phase, blockedOutcome);
				plan = updateWorkflowPhaseStatus(plan, phase.id, "failed");
				sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
					workflowId: plan.id,
					phaseId: phase.id,
					phaseRunId,
					outcome: blockedOutcome
				}, persistRequestId);
				sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);
				throw new WorkflowExecutionError(guardMessage, plan, new Error(guardMessage), phaseOutputs);
			}
		}

		plan = updateWorkflowPhaseStatus(plan, phase.id, "running");
		state = { ...state, plan, phaseIndex: index, phaseOutputs, activePhaseRunId: phaseRunId };
		sendWorkflowEvent(socket, requestId, session, "workflow.phase.started", {
			workflowId: plan.id,
			phaseId: phase.id,
			phaseRunId,
			title: phase.title,
			toolGroup: phase.toolGroup ?? null,
			skillId: phase.skillId ?? null,
			acceptanceCriteria: phase.acceptanceCriteria ?? [],
			repairOf: phase.repairOf ?? null,
			repairRound: phase.repairRound ?? 0
		}, persistRequestId);
		sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);

		const phaseMessage: string = createPhaseMessage(state.originalParams, plan, phase, phaseOutputs);
		const isFinalPhase: boolean = index >= plan.phases.length - 1;
		const streamPhase: boolean = isFinalPhase && streamFinal;
		const phaseParams: AiChatParams = createPhaseParams(state.originalParams, phase, phaseMessage, streamPhase);
		const carriedGuidePromptSection: string = state.guidePromptSection ?? "";
		state = { ...state, guidePromptSection: undefined };
		const pendingGuidePromptSection: string = consumePendingGuideSection(socket, requestId, session, persistRequestId);
		const guidePromptSection: string = [
			carriedGuidePromptSection,
			pendingGuidePromptSection
		].filter((section: string): boolean => section.length > 0).join("\n\n");
		const fullSystemPrompt: string = await createWorkflowPhasePrompt(phase, phaseParams, mcpHost, session, requestId, guidePromptSection);
		let agentResult: DeepSeekAgentResult;
		let phaseToolStats: WorkflowPhaseToolStats = createEmptyWorkflowPhaseToolStats();
		let phaseToolObservations: WorkflowToolObservation[] = [];
		try {
			if (agentResultOverride !== undefined) {
				agentResult = agentResultOverride;
				phaseToolStats.approvalEvents = 1;
				phaseToolStats.writeToolEvents = 1;
				phaseToolObservations = agentResultOverrideToolObservations.length > 0 ? agentResultOverrideToolObservations : [{
					toolCallId: `${phaseRunId}-approved-continuation`,
					toolName: "approved_tool_continuation",
					risk: "write",
					status: "succeeded",
					parsedResult: {
						ok: true,
						validationStatus: "passed",
						summary: "审批通过后的工具调用已执行，LLM continuation 已恢复。"
					},
					artifactRefs: []
				}];
				agentResultOverrideToolObservations = [];
			} else {
				let phaseRunResult: WorkflowPhaseRunResult = await runWorkflowPhase(
					socket,
					phaseParams,
					options,
					state.history,
					fullSystemPrompt,
					phase,
					mcpHost,
					session,
					requestId,
					persistRequestId,
					plan.id,
					phaseRunId,
					streamPhase,
					abortSignal
				);
				agentResult = phaseRunResult.agentResult;
				phaseToolStats = phaseRunResult.toolStats;
				phaseToolObservations = phaseRunResult.toolObservations;

				if (
					agentResult.status === "completed"
					&& shouldRequireWorkflowWriteTool(phase)
					&& !didWorkflowWritePhaseExecute(phase, phaseToolStats)
				) {
					const retryPhaseParams: AiChatParams = createPhaseParams(
						state.originalParams,
						phase,
						createWorkflowWriteGuardRetryMessage(phaseMessage),
						false
					);
					phaseRunResult = await runWorkflowPhase(
						socket,
						retryPhaseParams,
						options,
						state.history,
						fullSystemPrompt,
						phase,
						mcpHost,
						session,
						requestId,
						persistRequestId,
						plan.id,
						phaseRunId,
						false,
						abortSignal
					);
					agentResult = phaseRunResult.agentResult;
					phaseToolStats = phaseRunResult.toolStats;
					phaseToolObservations = phaseRunResult.toolObservations;
				}
			}
		} catch (error: unknown) {
			throw new WorkflowExecutionError(error instanceof Error ? error.message : "Workflow phase failed", plan, error);
		}
		agentResultOverride = undefined;

		if (agentResult.status === "approval_required") {
			plan = updateWorkflowPhaseStatus(plan, phase.id, "paused");
			const approvalOutcome: WorkflowPhaseOutput = createWorkflowPhaseOutcome(phase, phaseRunId, "", phaseToolObservations);
			phaseOutputs = appendPhaseOutput(phaseOutputs, phase, approvalOutcome);
			const pausedState: WorkflowRunState = { ...state, plan, phaseIndex: index, phaseOutputs, activePhaseRunId: phaseRunId };
			const pendingContinuation: PendingAiContinuation = createWorkflowPendingContinuation(
				phaseParams,
				options,
				agentResult,
				phase,
				pausedState,
				persistRequestId,
				userCreatedAt,
				streamPhase
			);
			await registerPendingApprovalContinuation(session, mcpHost, agentResult.approvalId, pendingContinuation);
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: approvalOutcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);
			sendAgentPaused(socket, requestId, session, plan.id, agentResult, persistRequestId);
			return;
		}

		if (agentResult.status === "protocol_violation") {
			const protocolOutcome: WorkflowPhaseOutput = {
				phaseId: phase.id,
				phaseRunId,
				title: phase.title,
				status: "blocked",
				summary: agentResult.reason,
				evidence: [],
				failedChecks: [{
					code: "protocol_violation",
					message: agentResult.reason,
					severity: "error"
				}],
				requiredFixes: ["模型必须通过 API tool_calls 调用工具，不能在文本中输出 XML/DSML/裸工具标签。"],
				modifiedArtifacts: [],
				verifiedArtifacts: [],
				toolObservations: phaseToolObservations,
				blockedReason: agentResult.reason
			};
			phaseOutputs = appendPhaseOutput(phaseOutputs, phase, protocolOutcome);
			plan = updateWorkflowPhaseStatus(plan, phase.id, "failed");
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: protocolOutcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs, phaseRunId);
			throw new WorkflowExecutionError(agentResult.reason, plan, new Error(agentResult.reason), phaseOutputs);
		}

		if (shouldRequireWorkflowWriteTool(phase) && !didWorkflowWritePhaseExecute(phase, phaseToolStats)) {
			const guardMessage: string = `写入阶段「${phase.title}」没有实际调用写入工具或触发审批，已阻止将该 Todo 标记为完成。`;
			throw new WorkflowExecutionError(
				guardMessage,
				plan,
				new Error(guardMessage)
			);
		}

		const phaseOutcome: WorkflowPhaseOutput = applyDeterministicVerificationGate(
			phase,
			createWorkflowPhaseOutcome(phase, phaseRunId, agentResult.text, phaseToolObservations),
			phaseOutputs
		);
		if (phaseOutcome.status === "needs_fix") {
			if (countWorkflowAutoRepairRounds(plan) >= MAX_WORKFLOW_AUTO_REPAIR_ROUNDS) {
				const guardMessage: string = `验证阶段「${phase.title}」仍发现需要修复的问题，已达到自动修复次数上限。`;
				const blockedOutcome: WorkflowPhaseOutput = {
					...phaseOutcome,
					status: "blocked",
					summary: guardMessage,
					blockedReason: guardMessage
				};
				phaseOutputs = appendPhaseOutput(phaseOutputs, phase, blockedOutcome);
				plan = updateWorkflowPhaseStatus(plan, phase.id, "failed");
				sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
					workflowId: plan.id,
					phaseId: phase.id,
					phaseRunId,
					outcome: blockedOutcome
				}, persistRequestId);
				sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
				throw new WorkflowExecutionError(
					guardMessage,
					plan,
					new Error(`${guardMessage}\n\n${phaseOutcome.requiredFixes.join("\n")}`),
					phaseOutputs
				);
			}

			phaseOutputs = appendPhaseOutput(phaseOutputs, phase, phaseOutcome);
			plan = updateWorkflowPhaseStatus(plan, phase.id, "failed");
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: phaseOutcome
			}, persistRequestId);
			plan = insertWorkflowAutoRepairPhases(plan, index + 1, phase, phaseOutcome.summary, phaseOutcome.failedChecks);
			state = { ...state, plan, phaseIndex: index + 1, phaseOutputs };
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
			continue;
		}

		if (phaseOutcome.status === "blocked" || phaseOutcome.status === "failed") {
			phaseOutputs = appendPhaseOutput(phaseOutputs, phase, phaseOutcome);
			plan = updateWorkflowPhaseStatus(plan, phase.id, "failed");
			sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
				workflowId: plan.id,
				phaseId: phase.id,
				phaseRunId,
				outcome: phaseOutcome
			}, persistRequestId);
			sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
			throw new WorkflowExecutionError(phaseOutcome.summary, plan, new Error(phaseOutcome.summary), phaseOutputs);
		}

		phaseOutputs = appendPhaseOutput(phaseOutputs, phase, phaseOutcome);
		plan = updateWorkflowPhaseStatus(plan, phase.id, "done");
		state = { ...state, plan, phaseIndex: index + 1, phaseOutputs };
		sendWorkflowEvent(socket, requestId, session, "workflow.phase.outcome", {
			workflowId: plan.id,
			phaseId: phase.id,
			phaseRunId,
			outcome: phaseOutcome
		}, persistRequestId);
		sendWorkflowEvent(socket, requestId, session, "workflow.phase.done", {
			workflowId: plan.id,
			phaseId: phase.id,
			phaseRunId,
			title: phase.title
		}, persistRequestId);
		sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);

		if (isFinalPhase) {
			await appendChatTurnToSession(
				session,
				state.history,
				state.originalParams.message,
				agentResult.text,
				persistRequestId,
				userCreatedAt,
				undefined,
				state.originalParams.additionalContext
			);
			sendWorkflowEvent(socket, requestId, session, "workflow.done", {
				workflowId: plan.id,
				title: plan.title
			}, persistRequestId);

			if (streamFinal) {
				sendSessionEvent(socket, requestId, session, "agent.message.done", {
					runId: plan.id,
					stepRunId: phaseRunId,
					text: agentResult.text,
					context: {
						historyMessagesStored: session.messages.length,
						historyBudgetTokens: state.historyBudgetTokens,
						mcpServers: mcpHost.getConnectedServerIds()
					}
				}, persistRequestId);
			} else {
				sendSessionEvent(socket, requestId, session, "agent.message.done", {
					runId: plan.id,
					stepRunId: phaseRunId,
					text: agentResult.text,
					context: {
						historyMessagesStored: session.messages.length,
						historyBudgetTokens: state.historyBudgetTokens,
						mcpServers: mcpHost.getConnectedServerIds()
					}
				}, persistRequestId);
				sendJson(socket, {
					type: "response",
					id: requestId,
					ok: true,
					result: {
						text: agentResult.text,
						context: {
							historyMessagesStored: session.messages.length,
							historyBudgetTokens: state.historyBudgetTokens,
							mcpServers: mcpHost.getConnectedServerIds()
						}
					}
				});
			}
			return;
		}

		if (plan.source === "llm") {
			try {
				const revisionGuidePromptSection: string = consumePendingGuideSection(socket, requestId, session, persistRequestId);
				const revisionPlanningContext: string = [
					planningContext,
					revisionGuidePromptSection
				].filter((section: string): boolean => section.length > 0).join("\n\n");
				if (revisionGuidePromptSection.length > 0) {
					state = {
						...state,
						guidePromptSection: [
							state.guidePromptSection ?? "",
							revisionGuidePromptSection
						].filter((section: string): boolean => section.length > 0).join("\n\n")
					};
				}
				const revisedPlan: WorkflowPlan = await reviseLlmWorkflowPlan(
					plan,
					index,
					state.originalParams,
					phaseOutputs,
					options,
					state.history,
					revisionPlanningContext,
					abortSignal
				);
				if ((revisedPlan.revision ?? 0) !== (plan.revision ?? 0)) {
					plan = revisedPlan;
					state = { ...state, plan, phaseIndex: index + 1, phaseOutputs };
					sendWorkflowTodoSnapshot(socket, requestId, session, plan, persistRequestId, phaseOutputs);
				}
			} catch (error: unknown) {
				console.warn("[workflow] LLM plan revision failed, continuing current plan:", error);
			}
		}
	}
}

export async function startWorkflowExecution(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	mcpHost: McpHost,
	options: ProviderChatOptions,
	plan: WorkflowPlan,
	originalParams: AiChatParams,
	history: ChatMessage[],
	historyBudgetTokens: number,
	userCreatedAt: string,
	planningContext: string = "",
	guidePromptSection: string = "",
	abortSignal?: AbortSignal | undefined
): Promise<void> {
	sendWorkflowEvent(socket, requestId, session, "workflow.started", {
		workflowId: plan.id,
		requestId,
		title: plan.title,
		source: plan.source ?? "fixed",
		revision: plan.revision ?? 0,
		phases: plan.phases.map((phase: WorkflowPhase) => ({
			id: phase.id,
			title: phase.title,
			toolGroup: phase.toolGroup ?? null,
			skillId: phase.skillId ?? null
		}))
	});
	sendWorkflowTodoSnapshot(socket, requestId, session, plan);
	try {
		await continueWorkflowExecution(socket, requestId, session, mcpHost, options, {
			plan,
			phaseIndex: 0,
			phaseOutputs: [],
			originalParams,
			history,
			historyBudgetTokens,
			planningContext,
			guidePromptSection
		}, userCreatedAt, undefined, requestId, abortSignal);
	} catch (error: unknown) {
		const latestPlan: WorkflowPlan = error instanceof WorkflowExecutionError ? error.plan : plan;
		const latestPhaseOutputs: WorkflowPhaseOutput[] = error instanceof WorkflowExecutionError ? error.phaseOutputs : [];
		if (isCancellationError(error instanceof WorkflowExecutionError ? error.originalError : error, abortSignal)) {
			const pausedPlan: WorkflowPlan = markRemainingWorkflowTodos(latestPlan, "paused");
			sendWorkflowTodoSnapshot(socket, requestId, session, pausedPlan, requestId, latestPhaseOutputs);
			throw error;
		}
		const failedPlan: WorkflowPlan = markRemainingWorkflowTodos(latestPlan, "failed");
		sendWorkflowTodoSnapshot(socket, requestId, session, failedPlan, requestId, latestPhaseOutputs);
		sendWorkflowEvent(socket, requestId, session, "workflow.error", {
			workflowId: latestPlan.id,
			title: latestPlan.title,
			message: error instanceof Error ? error.message : "Workflow failed"
		});
		throw error;
	}
}
