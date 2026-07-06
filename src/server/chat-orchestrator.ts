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
import { resolveToolMapping } from "../tools/tool-mapping.js";
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

import { normalizeChatParamsForMode, resolveAllowedToolsForChatParams } from "./chat-mode.js";
import { logPromptTrace, logProjectInstructionTrace } from "./prompt-trace.js";
import { isCancellationError, sendAgentCancelled, sendAiCancelled, beginRequestExecution, finishRequestExecution, parseMessage } from "./request-lifecycle.js";
import { estimateTextTokens, estimateMessagesTokens, computeHistoryBudget, appendChatTurnToSession, selectHistoryForModel, createSummaryMessage, loadSessionCompressorPrompt } from "./token-budget.js";
import { getSessionProjectPath, toChatMessage, clampSessionOpenMessageLimit, createPreviewValue, createSessionEventPreview, createTimelinePageResult, startFullSessionLoad, waitForFullSessionLoad } from "./session-preview.js";
import { createProviderChatOptions } from "./provider-chat-options.js";
import { clipTextByChars, cloneAdditionalContextItems, getAdditionalContextDataRecord, getContextNumber, getContextString, createLineColumnRangeText, appendScriptSelectionPromptLines, appendFilesystemSelectionPromptLines, createAdditionalContextPromptSection } from "./additional-context.js";
import { MAX_GUIDE_TEXT_CHARS, createGuideId, createPendingGuide, serializePendingGuide, findPendingGuideIndexById, findPendingGuideByClientId, readEventDataObject, hydratePendingGuides, persistGuideEvent, formatGuidePromptSection, consumePendingGuideSection } from "./pending-guides.js";
import { DEFAULT_NEXT_STEP_HINT_COUNT, MAX_NEXT_STEP_HINT_COUNT, parseJsonObjectLoose, normalizeNextStepHints, createNextStepHintPrompt, createNextStepHints } from "./next-step-hints.js";
import type { NextStepHint } from "./next-step-hints.js";
import { WorkflowExecutionError } from "./workflow/workflow-error.js";
import type { WorkflowPhaseToolStats, WorkflowPhaseRunResult } from "./workflow/shared-types.js";
import { MAX_WORKFLOW_AUTO_REPAIR_ROUNDS } from "./workflow/limits.js";
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
} from "./session-events.js";

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
} from "./approval-continuation.js";
import { createAgentToolEventForwarder, createEmptyWorkflowPhaseToolStats, updateWorkflowPhaseToolStats, shouldRequireWorkflowWriteTool, didWorkflowWritePhaseExecute, isWorkflowProposalPhase, createWorkflowWriteGuardRetryMessage } from "./workflow/tool-events.js";
import { sendWorkflowEvent, mapWorkflowEventToAgentEvent, convertWorkflowSnapshotToAgentSnapshot, sendWorkflowTodoSnapshot } from "./workflow/events.js";
import { runWorkflowPhase, createWorkflowPhasePrompt } from "./workflow/phase-runner.js";
import { createWorkflowPendingContinuation, continueWorkflowExecution } from "./workflow/continuation.js";
import { startWorkflowExecution } from "./workflow/executor.js";
import { ensureProviderConfigured } from "./handlers/provider-handlers.js";

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
		mcpServers: mcpHost.getConnectedServerIds(),
		customMcpServerStatus: mcpHost.getCustomServerStatuses(),
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

import { createProviderRuntimeContext, createSafeMarkdownFence, createMcpSystemContext } from "./prompt-context.js";

export async function handleChatRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "ai.cancel": {
			const controller: AbortController | undefined = session.activeAbortControllers.get(request.params.requestId);
			if (controller !== undefined) {
				controller.abort();
				session.activeAbortControllers.delete(request.params.requestId);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					cancelled: controller !== undefined,
					requestId: request.params.requestId
				}
			});
			break;
		}

		case "ai.chat": {
			await waitForFullSessionLoad(session);
			const slashCommandResult: SlashCommandResult = await handleSlashCommand({
				socket,
				request,
				session,
				mcpHost,
				createSessionInfo: createSessionInfoResult
			});
			if (slashCommandResult.type === "handled") {
				break;
			}

			const params: AiChatParams = normalizeChatParamsForMode(slashCommandResult.type === "ai"
				? slashCommandResult.params
				: request.params);
			const apiKey: string | undefined = await ensureProviderConfigured(session);

			if (!apiKey) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "provider_not_configured",
						message: `${getProviderDisplayName(session.activeProvider)} API key is not configured. Save it with provider.config.set first.`
					}
				});
				break;
			}

			const abortController: AbortController = new AbortController();
			session.activeAbortControllers.set(request.id, abortController);

			try {
				const turnStartedAt: string = new Date().toISOString();
				const options: ProviderChatOptions = createProviderChatOptions(session, apiKey);
				const requestHasImages: boolean = hasImageAttachments(params);
				if (requestHasImages) {
					getImageAttachments(params.additionalContext);
					const activeModelId: string = resolveChatModel(options);
					if (!await modelSupportsImageInput(options.provider, activeModelId)) {
						sendJson(socket, {
							type: "response",
							id: request.id,
							ok: false,
							error: {
								code: "model_does_not_support_images",
								message: `${getProviderDisplayName(options.provider)} model ${activeModelId} does not support image input. Switch to a model with image capability.`
							}
						});
						break;
					}
				}
				const activeSkillId: SkillId | undefined = params.skillId ?? session.activeSkillId;
				const activeSkill = activeSkillId !== undefined ? getSkill(activeSkillId) : undefined;
				const allowedToolNames: readonly string[] | undefined = resolveAllowedToolsForChatParams(params, activeSkill?.allowedTools);
				const promptId = params.promptId ?? (activeSkillId !== undefined ? getSkill(activeSkillId).defaultPromptId : undefined);
				const systemPrompt: string = await composeSystemPrompt(
					promptId,
					params.systemPrompt,
					createProviderRuntimeContext(session),
					params.mode
				);
				const skillPrompt: string = await composeSkillPrompt(activeSkillId);
				const mcpSystemContext: string = await createMcpSystemContext(mcpHost, session);
				const additionalContextSection: string = createAdditionalContextPromptSection(params.additionalContext);
				const guidePromptSection: string = consumePendingGuideSection(socket, request.id, session);
				const fullSystemPrompt: string = systemPrompt
					+ (skillPrompt.length > 0 ? `\n\n${skillPrompt}` : "")
					+ mcpSystemContext
					+ (additionalContextSection.length > 0 ? `\n\n${additionalContextSection}` : "")
					+ (guidePromptSection.length > 0 ? `\n\n${guidePromptSection}` : "");
				logPromptTrace({
					requestId: request.id,
					promptId,
					skillId: activeSkillId,
					customInstructions: params.systemPrompt,
					systemPrompt,
					skillPrompt,
					mcpSystemContext,
					additionalContextSection,
					guidePromptSection,
					fullSystemPrompt
				});
				if (params.retryFromRequestId !== undefined && session.sessionId !== undefined) {
					await waitForSessionEventPersistence(session);
					const rewoundMessages: StoredMessage[] = await rewindSessionFromRequest(session.sessionId, params.retryFromRequestId);
					session.messages = rewoundMessages.map(toChatMessage);
					session.fullSessionLoadPromise = undefined;
					session.summaryMessage = undefined;
					session.summaryCoveredMessageCount = undefined;
				}
				maybeScheduleSessionTitleGeneration(socket, request.id, session, params, options, session.messages.length === 0);
				const historyBudgetTokens: number = await computeHistoryBudget(
					session.modelProfile,
					options,
					params,
					systemPrompt,
					skillPrompt + mcpSystemContext + additionalContextSection + guidePromptSection,
					abortController.signal
				);
				const history: ChatMessage[] = await selectHistoryForModel(session, historyBudgetTokens);
				let workflowPlan: WorkflowPlan | null = null;
				if (requestHasImages) {
					workflowPlan = createSingleAnswerPlan(params, []);
				} else if (slashCommandResult.type === "none") {
					if (params.options?.workflow === "llm_planned") {
						try {
							workflowPlan = await createLlmWorkflowPlan(params, options, history, mcpSystemContext + additionalContextSection + guidePromptSection, abortController.signal);
						} catch (error: unknown) {
							const runId: string = `agent-run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
							sendSessionEvent(socket, request.id, session, "agent.run.started", {
								runId,
								requestId: request.id,
								title: "LLM 计划失败",
								source: "llm",
								steps: []
							});
							sendSessionEvent(socket, request.id, session, "agent.run.error", {
								runId,
								code: "planner_failed",
								message: error instanceof Error ? error.message : "LLM planner failed"
							});
							sendJson(socket, {
								type: "response",
								id: request.id,
								ok: false,
								error: {
									code: "planner_failed",
									message: error instanceof Error ? error.message : "LLM planner failed"
								}
							});
							break;
						}
					} else {
						workflowPlan = planWorkflow(params);
					}
				}

				if (workflowPlan === null) {
					workflowPlan = createSingleAnswerPlan(params, allowedToolNames);
				}

				await startWorkflowExecution(
					socket,
					request.id,
					session,
					mcpHost,
					options,
					workflowPlan,
					params,
					history,
					historyBudgetTokens,
					turnStartedAt,
					mcpSystemContext + additionalContextSection + guidePromptSection,
					guidePromptSection,
					abortController.signal
				);
				break;
			} catch (error: unknown) {
				if (isCancellationError(error, abortController.signal)) {
					sendAgentCancelled(socket, request.id, session);
					break;
				}
				if (error instanceof ProviderImageInputError) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: error.code,
							message: error.message
						}
					});
					break;
				}
				const providerError = classifyProviderError(error);
				sendSessionEvent(socket, request.id, session, "agent.run.error", {
					runId: request.id,
					code: providerError.code,
					message: providerError.message
				});
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: providerError.code,
						message: providerError.message
					}
				});
			} finally {
				session.activeAbortControllers.delete(request.id);
			}
			break;
		}

		case "ai.next_step_hints": {
			await waitForFullSessionLoad(session);
			if (request.params?.sessionId !== undefined && request.params.sessionId !== session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_mismatch",
						message: "Next-step hints can only be generated for the active session."
					}
				});
				break;
			}
			if (!session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session for next-step hints." }
				});
				break;
			}

			const apiKey: string | undefined = await ensureProviderConfigured(session);
			if (!apiKey) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "provider_not_configured",
						message: `${getProviderDisplayName(session.activeProvider)} API key is not configured. Save it with provider.config.set first.`
					}
				});
				break;
			}

			const abortController: AbortController = new AbortController();
			session.activeAbortControllers.set(request.id, abortController);
			try {
				const hints: NextStepHint[] = await createNextStepHints(
					session,
					createProviderChatOptions(session, apiKey),
					request.params?.maxHints ?? DEFAULT_NEXT_STEP_HINT_COUNT,
					request.params?.trigger ?? "done",
					request.params?.anchorRequestId,
					abortController.signal
				);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						nextStepHints: true,
						sessionId: session.sessionId,
						anchorRequestId: request.params?.anchorRequestId ?? null,
						hints,
						generatedAt: new Date().toISOString()
					}
				});
			} catch (error: unknown) {
				if (isCancellationError(error, abortController.signal)) {
					sendAiCancelled(socket, request.id);
					break;
				}
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "next_step_hints_error",
						message: error instanceof Error ? error.message : "Failed to generate next-step hints"
					}
				});
			} finally {
				session.activeAbortControllers.delete(request.id);
			}
			break;
		}


		default:
			throw new Error(`Unsupported chat request method: ${request.method}`);
	}
}
