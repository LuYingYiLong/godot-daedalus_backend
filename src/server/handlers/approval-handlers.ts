import WebSocket from "ws";
import { composeSystemPrompt, listPromptTemplates } from "../../prompts/registry.js";
import type { AdditionalContextItem, AiChatParams, ChatMessage, ClientRequest, ModelProfile, ProviderId, ServerEvent } from "../../protocol/types.js";
import type { ProviderAgentResult } from "../../providers/agent-types.js";
import { continueProviderAgent, continueProviderAgentStreaming } from "../../providers/provider-agent.js";
import type { OnToolEvent, ToolEvent } from "../../tools/tool-dispatcher.js";
import { parseToolResultSummary } from "../../tools/tool-result-parser.js";
import { chatWithDeepSeek, createDeepSeekClient, resolveChatModel, type ProviderChatOptions } from "../../providers/deepseek-client.js";
import { McpHost } from "../../mcp/mcp-host.js";
import type { CustomMcpServerRuntimeStatus } from "../../mcp/mcp-host.js";
import {
	addCustomMcpServerConfig,
	listCustomMcpServerSummaries,
	removeCustomMcpServerConfig,
	setCustomMcpServerEnabled,
	type CustomMcpServerSummary
} from "../../mcp/custom-mcp-config-store.js";
import { sendJson } from "../send-json.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDefaultModelProfile, resolveModelProfile } from "../../tokens/model-profiles.js";
import { type TokenCounter } from "../../tokens/token-counter.js";
import { createTokenCounter } from "../../tokens/token-counter-factory.js";
import { computeInputBudget, selectMessagesWithinBudget } from "../../session/session-compressor.js";
import { composeSkillPrompt, getSkill, isSkillId, listSkills } from "../../skills/registry.js";
import type { SkillId } from "../../skills/registry.js";
import {
	createRuntimeWorkspace,
	loadWorkspaces,
	findWorkspace,
	getDefaultWorkspace,
	upsertRuntimeWorkspace
} from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
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
} from "../../session/session-store.js";
import {
	clearProviderConfig,
	getProviderConfigStatus,
	loadProviderConfigWithSecret,
	saveProviderConfig,
	type ProviderConfigWithSecret
} from "../../providers/provider-config-store.js";
import { listProviderModels } from "../../providers/provider-models.js";
import { estimateProviderMessagesTokens, estimateProviderTextTokens } from "../../providers/provider-token-estimator.js";
import {
	createCurrentUserMessage,
	getImageAttachments,
	hasImageAttachments,
	modelSupportsImageInput,
	ProviderImageInputError
} from "../../providers/provider-image-content.js";
import { getProviderDefaultBaseUrl, getProviderDefaultModel, getProviderDisplayName } from "../../providers/provider-registry.js";
import { classifyProviderError, createProviderStatusEvent } from "../../providers/provider-error.js";
import { generateSessionTitle, shouldApplyGeneratedSessionTitle } from "../session-title.js";
import { createSingleAnswerPlan, planWorkflow, READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "../../workflow/planner.js";
import { createLlmWorkflowPlan, reviseLlmWorkflowPlan } from "../../workflow/llm-planner.js";
import {
	applyDeterministicVerificationGate,
	applyToolEventToWorkflowObservations,
	createWorkflowPhaseOutcome,
	createWorkflowPhaseRunId,
	findBlockingOutcomeBeforeSummarize
} from "../../workflow/outcome.js";
import {
	appendPhaseOutput,
	createPhaseMessage,
	createPhaseParams,
	createPhasePrompt,
	createWorkflowTodoSnapshot,
	markRemainingWorkflowTodos,
	updateWorkflowPhaseStatus
} from "../../workflow/runner.js";
import { countWorkflowAutoRepairRounds, insertWorkflowAutoRepairPhases } from "../../workflow/repair.js";
import type { WorkflowPhase, WorkflowPhaseOutput, WorkflowPlan, WorkflowRunState, WorkflowToolObservation } from "../../workflow/types.js";
import {
	clearActiveSession,
	type ClientSession,
	type PendingAiContinuation,
	type PendingGuide,
	type ThinkingEventBuffer
} from "../client-session.js";
import { getToolPolicy } from "../../tools/tool-policy.js";
import type { PendingApproval } from "../../tools/approval-gateway.js";
import { getLlmToolExecutionIdentity } from "../../tools/tool-idempotency.js";
import { resolveToolMapping } from "../../tools/tool-mapping.js";
import {
	createPersistedApprovalRequestedData,
	createRuntimePendingContinuation,
	foldPendingApprovalStates,
	serializePendingApprovalState,
	type PendingApprovalState
} from "../../session/approval-persistence.js";
import { createBackendHealthResult } from "../backend-health.js";
import {
	createSlashCommandListResult,
	handleSlashCommand,
	type SlashCommandResult
} from "../slash-commands.js";

import { normalizeChatParamsForMode, resolveAllowedToolsForChatParams } from "../chat-mode.js";
import { logPromptTrace, logProjectInstructionTrace } from "../prompt-trace.js";
import { isCancellationError, sendAgentCancelled, sendAiCancelled, beginRequestExecution, finishRequestExecution, parseMessage } from "../request-lifecycle.js";
import { estimateTextTokens, estimateMessagesTokens, computeHistoryBudget, appendChatTurnToSession, selectHistoryForModel, createSummaryMessage, loadSessionCompressorPrompt } from "../token-budget.js";
import { getSessionProjectPath, toChatMessage, clampSessionOpenMessageLimit, createPreviewValue, createSessionEventPreview, createTimelinePageResult, startFullSessionLoad, waitForFullSessionLoad } from "../session-preview.js";
import { createProviderChatOptions } from "../provider-chat-options.js";
import { clipTextByChars, cloneAdditionalContextItems, getAdditionalContextDataRecord, getContextNumber, getContextString, createLineColumnRangeText, appendScriptSelectionPromptLines, appendFilesystemSelectionPromptLines, createAdditionalContextPromptSection } from "../additional-context.js";
import { MAX_GUIDE_TEXT_CHARS, createGuideId, createPendingGuide, serializePendingGuide, findPendingGuideIndexById, findPendingGuideByClientId, readEventDataObject, hydratePendingGuides, persistGuideEvent, formatGuidePromptSection, consumePendingGuideSection } from "../pending-guides.js";
import { DEFAULT_NEXT_STEP_HINT_COUNT, MAX_NEXT_STEP_HINT_COUNT, parseJsonObjectLoose, normalizeNextStepHints, createNextStepHintPrompt, createNextStepHints } from "../next-step-hints.js";
import type { NextStepHint } from "../next-step-hints.js";
import { WorkflowExecutionError } from "../workflow/workflow-error.js";
import type { WorkflowPhaseToolStats, WorkflowPhaseRunResult } from "../workflow/shared-types.js";
import { MAX_WORKFLOW_AUTO_REPAIR_ROUNDS } from "../workflow/limits.js";
import {
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
	maybeScheduleSessionTitleGeneration
} from "../session-events.js";

import {
	createPendingAiContinuation,
	persistApprovalRequested,
	registerPendingApprovalContinuation,
	loadHydratedPendingApprovalStates,
	createMemoryPendingApprovalStates,
	findPendingApprovalState,
	restorePendingContinuationForApproval,
	validatePendingApprovalBeforeExecution,
	createApprovedWorkflowToolObservation,
	sendAgentPaused,
	sendContinuedAgentResult
} from "../approval-continuation.js";
import { createAgentToolEventForwarder, createEmptyWorkflowPhaseToolStats, updateWorkflowPhaseToolStats, shouldRequireWorkflowWriteTool, didWorkflowWritePhaseExecute, isWorkflowProposalPhase, createWorkflowWriteGuardRetryMessage } from "../workflow/tool-events.js";
import { persistFileEditBatch } from "../file-edit-batches.js";
import { sendWorkflowEvent, mapWorkflowEventToAgentEvent, convertWorkflowSnapshotToAgentSnapshot, sendWorkflowTodoSnapshot } from "../workflow/events.js";
import { runWorkflowPhase, createWorkflowPhasePrompt } from "../workflow/phase-runner.js";
import { createWorkflowPendingContinuation, continueWorkflowExecution } from "../workflow/continuation.js";
import { startWorkflowExecution } from "../workflow/executor.js";
import { ensureProviderConfigured } from "./provider-handlers.js";
import { findSessionWithPendingApproval } from "../client-connections.js";
import { withMcpRequestContext } from "../../mcp/request-context.js";

function createSessionInfoResult(session: ClientSession, mcpHost: McpHost, historyTokensStored: number | null = null): Record<string, unknown> {
	return {
		provider: session.activeProvider,
		providerDisplayName: getProviderDisplayName(session.activeProvider),
		providerConfigured: session.providerApiKey !== undefined,
		model: session.providerModel ?? session.modelProfile.model,
		historyMessagesStored: session.messages.length,
		historyTokensStored,
		summaryActive: session.summaryMessage !== undefined,
		summaryLength: session.summaryMessage?.content.length ?? 0,
		summaryCoveredMessageCount: session.summaryCoveredMessageCount ?? 0,
		contextWindowTokens: session.modelProfile.contextWindowTokens,
		maxOutputTokens: session.modelProfile.maxOutputTokens,
		defaultOutputReserveTokens: session.modelProfile.defaultOutputReserveTokens,
		safetyMarginTokens: session.modelProfile.safetyMarginTokens,
		approvalMode: session.approvalGateway.getMode(),
		pendingApprovals: session.approvalGateway.listPending().length,
		pendingGuides: session.pendingGuides.length,
		mcpServers: mcpHost.getConnectedServerIds(session.activeWorkspace?.id),
		customMcpServerStatus: mcpHost.getCustomServerStatusesForWorkspace(session.activeWorkspace?.id),
		godotDiagnostics: mcpHost.getDiagnosticsBridge().getCachedStatus(),
		godotExecutablePath: session.activeWorkspace?.godotExecutablePath ?? session.godotExecutablePath ?? null,
		godotProjectPath: getSessionProjectPath(session) || null,
		activeWorkspace: session.activeWorkspace ? {
			id: session.activeWorkspace.id,
			name: session.activeWorkspace.name,
			kind: session.activeWorkspace.kind,
			rootPath: session.activeWorkspace.rootPath,
			godotExecutablePath: session.activeWorkspace.godotExecutablePath ?? null
		} : null,
		activeSkillId: session.activeSkillId ?? null
	};
}

import { createProviderRuntimeContext, createSafeMarkdownFence, createMcpSystemContext } from "../prompt-context.js";

export async function handleApprovalRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "approval.list":
	{
		const hydrated = await loadHydratedPendingApprovalStates(session);
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				pending: hydrated.states.map(serializePendingApprovalState),
				mode: session.approvalGateway.getMode()
			}
		});
		break;
	}

	case "approval.mode.set":
		session.approvalGateway.setMode(request.params.mode);
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				mode: session.approvalGateway.getMode(),
				pendingApprovals: session.approvalGateway.listPending().length
			}
		});
		break;

	case "approval.approve": {
		const ownerSession: ClientSession | undefined = session.approvalGateway.getPending(request.params.approvalId) !== undefined
			? session
			: findSessionWithPendingApproval(request.params.approvalId);
		if (ownerSession !== undefined && ownerSession !== session) {
			await withMcpRequestContext({
				workspaceId: ownerSession.activeWorkspace?.id,
				editorInstanceId: ownerSession.editorInstanceId
			}, async (): Promise<void> => {
				await handleApprovalRequest(socket, request, ownerSession, mcpHost);
			});
			break;
		}
		const abortController: AbortController = new AbortController();
		session.activeAbortControllers.set(request.id, abortController);
		try {
			const apiKey: string | undefined = await ensureProviderConfigured(session);
			const hydrated = await loadHydratedPendingApprovalStates(session, apiKey);
			const pending = session.approvalGateway.getPending(request.params.approvalId);
			if (!pending) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "approval_not_found", message: `Approval not found: ${request.params.approvalId}` }
				});
				break;
			}

			const validationError: string | null = await validatePendingApprovalBeforeExecution(session, mcpHost, pending);
			if (validationError !== null) {
				if (session.sessionId !== undefined) {
					await appendApprovalEvent(session.sessionId, pending.approvalId, findPendingApprovalState(hydrated.states, pending.approvalId)?.requestId ?? request.id, "failed", {
						message: validationError
					});
				}
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "approval_validation_failed", message: validationError }
				});
				break;
			}

			const pendingState: PendingApprovalState | undefined = findPendingApprovalState(hydrated.states, request.params.approvalId);
			const pendingContinuation: PendingAiContinuation | undefined = await restorePendingContinuationForApproval(session, pendingState, apiKey);
			if (pendingState?.continuation !== undefined && pendingContinuation === undefined) {
				const message: string = `当前没有可用的 ${getProviderDisplayName(session.activeProvider)} API key，无法恢复审批后的 LLM continuation。请先配置 provider 后重试。`;
				if (session.sessionId !== undefined) {
					await appendApprovalEvent(session.sessionId, pending.approvalId, pendingState.requestId, "failed", { message });
				}
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "provider_not_configured", message }
				});
				break;
			}
			const approvalPersistRequestId: string = pendingContinuation?.requestId ?? pendingState?.requestId ?? request.id;
			if (session.sessionId !== undefined) {
				await appendApprovalEvent(session.sessionId, pending.approvalId, approvalPersistRequestId, "approved", {
					approvedAt: new Date().toISOString()
				});
				await appendApprovalEvent(session.sessionId, pending.approvalId, approvalPersistRequestId, "executing", {
					startedAt: new Date().toISOString()
				});
			}
			const result = await session.approvalGateway.approve(request.params.approvalId, mcpHost);
			const approvedToolObservation: WorkflowToolObservation = createApprovedWorkflowToolObservation(pending, result.content);
			if (session.sessionId !== undefined) {
				await appendApprovalEvent(session.sessionId, pending.approvalId, approvalPersistRequestId, "executed", {
					resultChars: result.content.length,
					cached: result.cached === true,
					executedAt: new Date().toISOString()
				});
			}

			const { fileEditDraft: _fileEditDraft, ...publicApprovalResult } = result;
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					approved: true,
					approvalId: request.params.approvalId,
					result: publicApprovalResult,
					continued: pendingContinuation !== undefined
				}
			});
			const continuationRunId: string = pendingContinuation?.workflowState?.plan.id ?? pendingContinuation?.requestId ?? request.id;
			const continuationStepRunId: string = pendingContinuation?.workflowState?.activePhaseRunId ?? pendingContinuation?.requestId ?? request.id;
			const resultPersistRequestId: string = pendingContinuation?.requestId ?? request.id;
			const fileEditBatch = persistFileEditBatch(
				session.sessionId,
				resultPersistRequestId,
				pending.toolCallId,
				pending.llmToolName,
				result.fileEditDraft
			);
			sendSessionEvent(socket, request.id, session, "agent.tool.approved", {
				type: "agent.tool.approved",
				runId: continuationRunId,
				stepRunId: continuationStepRunId,
				approvalId: request.params.approvalId,
				toolName: pending.llmToolName
			}, resultPersistRequestId);
			sendSessionEvent(socket, request.id, session, "agent.tool.result", {
				type: "agent.tool.result",
				runId: continuationRunId,
				stepRunId: continuationStepRunId,
				step: pendingContinuation?.continuation.nextStep ?? 0,
				toolCallId: pending.toolCallId,
				toolName: pending.llmToolName,
				resultChars: result.content.length,
				truncated: false,
				cached: result.cached === true,
				...approvedToolObservation.parsedResult,
				...(fileEditBatch === undefined ? {} : { fileEditBatch })
			}, resultPersistRequestId);

			if (pendingContinuation === undefined) {
				session.messages.push({
					role: "system",
					content: `[工具执行结果] ${pending.llmToolName} 已通过审批并执行完成：\n${result.content.slice(0, 2000)}`
				});
				break;
			}

			session.pendingAiContinuations.delete(request.params.approvalId);
			const onToolEvent: OnToolEvent = createAgentToolEventForwarder(
				socket,
				request.id,
				session,
				continuationRunId,
				continuationStepRunId,
				pendingContinuation.requestId,
				mcpHost
			);
			const agentResult: ProviderAgentResult = pendingContinuation.stream
				? await continueProviderAgentStreaming(
					pendingContinuation.params,
					pendingContinuation.options,
					pendingContinuation.continuation,
					{
						toolCallId: pending.toolCallId,
						content: result.content
					},
					mcpHost,
					session.approvalGateway,
					pendingContinuation.allowedToolNames,
					onToolEvent,
					abortController.signal
				)
				: await continueProviderAgent(
					pendingContinuation.params,
					pendingContinuation.options,
					pendingContinuation.continuation,
					{
						toolCallId: pending.toolCallId,
						content: result.content
					},
					mcpHost,
					session.approvalGateway,
					pendingContinuation.allowedToolNames,
					onToolEvent,
					abortController.signal
				);

			if (pendingContinuation.workflowState !== undefined) {
				await continueWorkflowExecution(
					socket,
					request.id,
					session,
					mcpHost,
					pendingContinuation.options,
					pendingContinuation.workflowState,
					pendingContinuation.userCreatedAt,
					agentResult,
					pendingContinuation.requestId,
					abortController.signal,
					[approvedToolObservation]
				);
				break;
			}

			await sendContinuedAgentResult(
				socket,
				request.id,
				session,
				mcpHost,
				agentResult,
				pendingContinuation
			);
		} catch (error: unknown) {
			if (isCancellationError(error, abortController.signal)) {
				sendAgentCancelled(socket, request.id, session);
				break;
			}
			if (session.sessionId !== undefined) {
				await appendApprovalEvent(session.sessionId, request.params.approvalId, request.id, "failed", {
					message: error instanceof Error ? error.message : "Approval failed"
				});
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "approval_error",
					message: error instanceof Error ? error.message : "Approval failed"
				}
			});
		} finally {
			session.activeAbortControllers.delete(request.id);
		}
		break;
	}

	case "approval.reject": {
		const ownerSession: ClientSession | undefined = session.approvalGateway.getPending(request.params.approvalId) !== undefined
			? session
			: findSessionWithPendingApproval(request.params.approvalId);
		if (ownerSession !== undefined && ownerSession !== session) {
			await withMcpRequestContext({
				workspaceId: ownerSession.activeWorkspace?.id,
				editorInstanceId: ownerSession.editorInstanceId
			}, async (): Promise<void> => {
				await handleApprovalRequest(socket, request, ownerSession, mcpHost);
			});
			break;
		}
		try {
			const hydrated = await loadHydratedPendingApprovalStates(session);
			const pendingState: PendingApprovalState | undefined = findPendingApprovalState(hydrated.states, request.params.approvalId);
			const rejected = session.approvalGateway.reject(request.params.approvalId);
			session.pendingAiContinuations.delete(request.params.approvalId);
			if (session.sessionId !== undefined) {
				await appendApprovalEvent(session.sessionId, request.params.approvalId, pendingState?.requestId ?? request.id, "rejected", {
					rejectedAt: new Date().toISOString()
				});
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { rejected: true, approvalId: request.params.approvalId, toolName: rejected.llmToolName }
			});
			sendSessionEvent(socket, request.id, session, "agent.tool.rejected", {
				type: "agent.tool.rejected",
				runId: pendingState?.requestId ?? request.id,
				stepRunId: pendingState?.requestId ?? request.id,
				approvalId: request.params.approvalId,
				toolName: rejected.llmToolName
			}, pendingState?.requestId ?? request.id);
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "approval_error",
					message: error instanceof Error ? error.message : "Rejection failed"
				}
			});
		}
		break;
	}

		default:
			throw new Error(`Unsupported approval method: ${request.method}`);
	}
}
