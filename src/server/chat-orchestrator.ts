import WebSocket from "ws";
import { composeSystemPrompt, listPromptTemplates } from "../prompts/registry.js";
import type { AdditionalContextItem, AiChatParams, ChatMessage, ClientRequest, ModelProfile, ProviderId, ServerEvent } from "../protocol/types.js";
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
import { composeExplicitSkillPrompt, composeSkillCatalogPrompt, resolveBuiltinToolRestriction, resolveExplicitSkills } from "../skills/runtime.js";
import type { CatalogSkill, SkillWorkspace } from "../skills/types.js";
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
	appendSessionEvent, appendApprovalEvent, appendWorkflowEvent, appendAgentEvent, clearSessionEvents, readApprovalEvents, updateSessionMetadata,
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
	hasImageAttachments,
	ProviderImageInputError
} from "../providers/provider-image-content.js";
import { preprocessImageAttachmentsForTextModel, type ImageRecognitionPreprocessResult } from "../providers/image-recognition.js";
import { hydrateImageAttachmentContexts } from "../session/session-attachments.js";
import { resolveProviderTaskModelOptions } from "../providers/task-model-routing.js";
import { getProviderDefaultBaseUrl, getProviderDefaultModel, getProviderDisplayName, isProviderId } from "../providers/provider-registry.js";
import { classifyProviderError, createProviderStatusEvent } from "../providers/provider-error.js";
import { isFirstSessionUserTurn } from "./session-title.js";
import { createReadOnlyFactWorkflowPlan, createSingleAnswerPlan, isCurrentProjectFactRequest, planWorkflow, planWorkflowAfterLlmPlannerFailure, READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "../workflow/planner.js";
import { createLlmWorkflowPlan, reviseLlmWorkflowPlan } from "../workflow/llm-planner.js";
import { createGodotTemplateWorkflowPlan } from "../workflow/godot-template-planner.js";
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
import { createWorkspaceToolCatalog, filterToolNamesForWorkspace, getNoWorkspaceToolNames } from "../tools/tool-catalog.js";
import { ApprovalGateway, ReadOnlyToolApprovalGateway, type PendingApproval } from "../tools/approval-gateway.js";
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
import { serializeMessageQueue } from "./message-queue.js";
import { clearWorkbenchComposer, emitWorkbenchUpdated, serializeWorkbench, setWorkbenchActiveRun, setWorkbenchNextStepHints } from "./workbench.js";

import { normalizeChatParamsForMode, resolveAllowedToolsForChatParams } from "./chat-mode.js";
import { logPromptTrace, logProjectInstructionTrace } from "./prompt-trace.js";
import { isCancellationError, sendAiCancelled, beginRequestExecution, finishRequestExecution, parseMessage } from "./request-lifecycle.js";
import { estimateTextTokens, estimateMessagesTokens, estimateTextTokensForProvider, estimateCurrentMessageTokensForProvider, computeHistoryBudget, appendChatTurnToSession, appendUserMessageToSession, appendFailedChatTurnToSession, selectHistoryForModel, createSummaryMessage, loadSessionCompressorPrompt, filterLlmContextMessages } from "./token-budget.js";
import { getSessionProjectPath, toChatMessage, clampSessionOpenMessageLimit, createPreviewValue, createTimelinePageResult, startFullSessionLoad, waitForFullSessionLoad } from "./session-preview.js";
import { createProviderChatOptions } from "./provider-chat-options.js";
import { createRuntimeSessionUiMetadata } from "./session-ui-metadata.js";
import { createGodotRuntimeStatus } from "./godot-runtime-status.js";
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
	cancelPendingApprovalsForRequest,
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
import { ensureProviderConfigured } from "../application/provider-session-service.js";
import { beginSessionRun, finishSessionRun } from "./client-connections.js";
import { logger } from "../logger.js";
import { createInitialPlan } from "./plan-mode.js";
import { createPlanGetResult, type StoredPlan } from "./plan-store.js";
import { getUserPrompt } from "../user-prompt-store.js";
import { compressSessionHistory } from "./session-compression.js";
import { getWebSearchSettingsStatus, isWebSearchToolAvailable } from "../web-search-settings-store.js";

const WEB_SEARCH_TOOL_NAME: string = "mcp_web_search";

function applyChatRequestModelSnapshot(session: ClientSession, params: AiChatParams): boolean {
	if (params.provider === undefined && params.model === undefined) {
		return false;
	}

	const nextProvider: ProviderId = params.provider ?? session.activeProvider;
	if (!isProviderId(nextProvider)) {
		return false;
	}

	const providerChanged: boolean = nextProvider !== session.activeProvider;
	const currentModel: string = session.providerModel ?? session.modelProfile.model ?? getProviderDefaultModel(session.activeProvider);
	const requestedModel: string | undefined = params.model?.trim();
	const nextModel: string = requestedModel !== undefined && requestedModel.length > 0
		? requestedModel
		: providerChanged
			? getProviderDefaultModel(nextProvider)
			: currentModel;
	if (!providerChanged && nextModel === currentModel) {
		return false;
	}

	session.activeProvider = nextProvider;
	session.providerModel = nextModel;
	session.modelProfile = resolveModelProfile(nextProvider, nextModel);
	if (providerChanged) {
		session.providerApiKey = undefined;
		session.providerBaseUrl = undefined;
	}
	return true;
}

function isImageGenerationOnlyToolRestriction(toolNames: readonly string[] | undefined): boolean {
	return toolNames !== undefined && toolNames.length === 1 && toolNames[0] === "mcp_image_generate";
}

function removeWebSearchToolName(allowedToolNames: readonly string[] | undefined, session: ClientSession): readonly string[] {
	const toolNames: readonly string[] = allowedToolNames ?? createWorkspaceToolCatalog({
		workspaceId: session.activeWorkspace?.id,
		editorInstanceId: session.editorInstanceId,
		sessionId: session.sessionId
	}).getEntries().map((entry): string => entry.id);
	return toolNames.filter((toolName: string): boolean => toolName !== WEB_SEARCH_TOOL_NAME);
}

async function resolveSearchAwareToolNames(
	allowedToolNames: readonly string[] | undefined,
	session: ClientSession,
	webSearchEnabled: boolean
): Promise<readonly string[] | undefined> {
	if (!webSearchEnabled) {
		return removeWebSearchToolName(allowedToolNames, session);
	}
	if (await isWebSearchToolAvailable()) {
		return allowedToolNames;
	}
	return removeWebSearchToolName(allowedToolNames, session);
}

async function createWebSearchUnavailableMessage(): Promise<string> {
	const status = await getWebSearchSettingsStatus();
	if (!status.selectedSupported) {
		return "The selected web search model does not support provider-native search. Choose a Search-capable model in Search settings.";
	}
	if (!status.configured) {
		return `Configure ${getProviderDisplayName(status.provider)} API key in Provider settings before using web search.`;
	}
	return "Web search is unavailable. Check Search settings and provider configuration.";
}

function filterWebSearchFromWorkflowPlan(plan: WorkflowPlan): WorkflowPlan {
	return {
		...plan,
		phases: plan.phases.map((phase: WorkflowPhase): WorkflowPhase => {
			if (!phase.allowedTools.includes(WEB_SEARCH_TOOL_NAME)) {
				return phase;
			}
			return {
				...phase,
				allowedTools: phase.allowedTools.filter((toolName: string): boolean => toolName !== WEB_SEARCH_TOOL_NAME)
			};
		})
	};
}

class ContextTooLargeError extends Error {
	readonly code: string = "context_too_large";

	constructor(message: string) {
		super(message);
		this.name = "ContextTooLargeError";
	}
}

type ContextUsageEstimate = {
	usedTokens: number;
	contextWindowTokens: number;
	percent: number;
	availableTokens: number;
	historyTokens: number;
	currentMessageTokens: number;
	systemAndContextTokens: number;
	outputReserveTokens: number;
	safetyMarginTokens: number;
};

function getFullContextHistoryMessages(session: ClientSession, excludeRequestId?: string | undefined): ChatMessage[] {
	const filterRequest = (messages: ChatMessage[]): ChatMessage[] => excludeRequestId === undefined
		? messages
		: messages.filter((message: ChatMessage): boolean => message.requestId !== excludeRequestId);
	if (session.summaryMessage === undefined) {
		return filterRequest(filterLlmContextMessages(session.messages));
	}

	const recentSourceMessages: ChatMessage[] = session.summaryCoveredMessageCount !== undefined
		? session.messages.slice(session.summaryCoveredMessageCount)
		: session.messages;
	return [session.summaryMessage, ...filterRequest(filterLlmContextMessages(recentSourceMessages))];
}

async function estimateFullContextUsage(
	session: ClientSession,
	requestId: string,
	options: ProviderChatOptions,
	params: AiChatParams,
	systemPrompt: string,
	contextPrompt: string,
	abortSignal?: AbortSignal | undefined
): Promise<ContextUsageEstimate> {
	const systemPromptTokens: number = await estimateTextTokensForProvider(options, systemPrompt, abortSignal);
	const contextPromptTokens: number = await estimateTextTokensForProvider(options, contextPrompt, abortSignal);
	const currentMessageTokens: number = await estimateCurrentMessageTokensForProvider(options, params, abortSignal);
	const historyTokens: number = await estimateMessagesTokens(getFullContextHistoryMessages(session, requestId));
	const outputReserveTokens: number = params.options?.maxTokens ?? session.modelProfile.defaultOutputReserveTokens;
	const safetyMarginTokens: number = session.modelProfile.safetyMarginTokens;
	const usedTokens: number = Math.max(0, systemPromptTokens + contextPromptTokens + currentMessageTokens + historyTokens + outputReserveTokens + safetyMarginTokens);
	const contextWindowTokens: number = session.modelProfile.contextWindowTokens;
	const percent: number = contextWindowTokens > 0
		? Math.min(100, Math.round((usedTokens / contextWindowTokens) * 1000) / 10)
		: 0;
	return {
		usedTokens,
		contextWindowTokens,
		percent,
		availableTokens: Math.max(0, contextWindowTokens - usedTokens),
		historyTokens,
		currentMessageTokens,
		systemAndContextTokens: systemPromptTokens + contextPromptTokens,
		outputReserveTokens,
		safetyMarginTokens
	};
}

async function maybeAutoCompressContextBeforeRun(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	apiKey: string,
	options: ProviderChatOptions,
	params: AiChatParams,
	systemPrompt: string,
	contextPrompt: string,
	abortSignal?: AbortSignal | undefined
): Promise<ContextUsageEstimate> {
	let estimate: ContextUsageEstimate = await estimateFullContextUsage(session, requestId, options, params, systemPrompt, contextPrompt, abortSignal);
	if (estimate.percent >= 85 && session.messages.length > 8) {
		sendSessionEvent(socket, requestId, session, "ai.status", {
			stage: "context_compress",
			title: "Compressing context",
			details: "Compressing conversation history",
			message: "Compressing conversation history",
			percent: estimate.percent,
			usedTokens: estimate.usedTokens,
			contextWindowTokens: estimate.contextWindowTokens
		});
		const compression = await compressSessionHistory(session, apiKey, 8);
		sendSessionEvent(socket, requestId, session, "ai.status", {
			stage: "context_compress_done",
			title: compression.compressed ? "Context compressed" : "Context compression skipped",
			details: compression.compressed ? "Conversation history compressed" : compression.reason,
			message: compression.compressed ? "Conversation history compressed" : compression.reason,
			compressed: compression.compressed
		});
		estimate = await estimateFullContextUsage(session, requestId, options, params, systemPrompt, contextPrompt, abortSignal);
	}

	if (estimate.usedTokens > estimate.contextWindowTokens) {
		sendSessionEvent(socket, requestId, session, "ai.status", {
			stage: "context_too_large",
			status: "error",
			title: "Context too large",
			details: "Context is larger than the selected model window",
			message: "Context is larger than the selected model window",
			percent: estimate.percent,
			usedTokens: estimate.usedTokens,
			contextWindowTokens: estimate.contextWindowTokens
		});
		throw new ContextTooLargeError(`当前会话上下文约 ${estimate.usedTokens.toLocaleString()} tokens，超过所选模型窗口 ${estimate.contextWindowTokens.toLocaleString()} tokens。请压缩会话、减少附件或切换到更大上下文模型。`);
	}

	return estimate;
}

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
		messageQueue: serializeMessageQueue(session),
		workbench: serializeWorkbench(session),
		mcpServers: mcpHost.getConnectedServerIds(session.activeWorkspace?.id),
		customMcpServerStatus: mcpHost.getCustomServerStatusesForWorkspace(session.activeWorkspace?.id),
		godotDiagnostics: mcpHost.getDiagnosticsBridge().getCachedStatus(),
		godotRuntime: createGodotRuntimeStatus(session, mcpHost),
		godotExecutablePath: session.activeWorkspace?.godotExecutablePath ?? session.godotExecutablePath ?? null,
		godotProjectPath: getSessionProjectPath(session) || null,
		activeWorkspace: session.activeWorkspace ? {
			id: session.activeWorkspace.id,
			name: session.activeWorkspace.name,
			kind: session.activeWorkspace.kind,
			rootPath: session.activeWorkspace.rootPath,
			godotExecutablePath: session.activeWorkspace.godotExecutablePath ?? null
		} : null,
		activeSkillId: null
	};
}

import { createProviderRuntimeContext, createSafeMarkdownFence, createMcpSystemContext } from "./prompt-context.js";

export async function handleChatRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "ai.cancel": {
			const controller: AbortController | undefined = session.activeAbortControllers.get(request.params.requestId);
			if (controller !== undefined) {
				setWorkbenchActiveRun(session, {
					status: "cancelling",
					requestId: request.params.requestId
				});
				emitWorkbenchUpdated(socket, request.id, session);
				controller.abort();
				session.activeAbortControllers.delete(request.params.requestId);
			}
			const cancelledApprovalIds: string[] = await cancelPendingApprovalsForRequest(session, request.params.requestId);
			if (cancelledApprovalIds.length > 0) {
				session.activeRunRequestId = session.activeRunRequestId === request.params.requestId
					? undefined
					: session.activeRunRequestId;
				setWorkbenchActiveRun(session, {
					status: "idle",
					requestId: request.params.requestId
				});
				emitWorkbenchUpdated(socket, request.id, session);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					cancelled: controller !== undefined || cancelledApprovalIds.length > 0,
					requestId: request.params.requestId,
					cancelledApprovalIds
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

			const rawParams: AiChatParams = slashCommandResult.type === "ai"
				? slashCommandResult.params
				: request.params;
			const params: AiChatParams = normalizeChatParamsForMode({
				...rawParams,
				message: rawParams.message.length > 0 ? rawParams.message : session.workbenchComposer.text,
				mode: rawParams.mode ?? session.workbenchComposer.chatMode,
				additionalContext: rawParams.additionalContext ?? session.workbenchComposer.additionalContext
			});
			const modelSnapshotChanged: boolean = applyChatRequestModelSnapshot(session, params);
			if (modelSnapshotChanged && session.sessionId !== undefined) {
				await updateSessionMetadata(session.sessionId, createRuntimeSessionUiMetadata(session));
			}
			const webSearchEnabled: boolean = params.webSearchEnabled === true;
			const webSearchAvailable: boolean = webSearchEnabled ? await isWebSearchToolAvailable() : false;
			if (webSearchEnabled && !webSearchAvailable) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "web_search_unavailable",
						message: await createWebSearchUnavailableMessage()
					}
				});
				break;
			}
			const apiKey: string | undefined = await ensureProviderConfigured(session);

			if (!apiKey) {
				logger.warn("ai", "provider_not_configured", {
					requestId: request.id,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					provider: session.activeProvider
				});
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

			const sessionRun = beginSessionRun(session.sessionId, request.id);
			if (session.activeRunRequestId !== undefined || !sessionRun.ok) {
				const activeRequestId: string = session.activeRunRequestId ?? (sessionRun.ok ? request.id : sessionRun.activeRequestId);
				logger.warn("ai", "session_busy", {
					requestId: request.id,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					activeRequestId
				});
				sendSessionEvent(socket, request.id, session, "session.run.busy", {
					sessionId: session.sessionId ?? null,
					activeRequestId,
					rejectedRequestId: request.id
				});
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_busy",
						message: "This session already has an active AI run."
					}
				});
				break;
			}

			const abortController: AbortController = new AbortController();
			session.activeAbortControllers.set(request.id, abortController);
			session.activeRunRequestId = request.id;
			const runStartedAtMs: number = Date.now();
			const turnStartedAt: string = new Date().toISOString();
			let persistedParams: AiChatParams = params;
			setWorkbenchActiveRun(session, {
				status: "streaming",
				requestId: request.id,
				startedAt: turnStartedAt
			});
			emitWorkbenchUpdated(socket, request.id, session);

			try {
				const options: ProviderChatOptions = createProviderChatOptions(session, apiKey);
				const isFirstUserTurn: boolean = isFirstSessionUserTurn(session.messages, request.id);
				maybeScheduleSessionTitleGeneration(socket, request.id, session, params, options, isFirstUserTurn);
				const hydratedParams: AiChatParams = await hydrateImageAttachmentContexts(session.sessionId, params);
				const imagePreprocess: ImageRecognitionPreprocessResult = await preprocessImageAttachmentsForTextModel(
					hydratedParams,
					options,
					abortController.signal,
					(progress): void => {
						sendSessionEvent(socket, request.id, session, "ai.status", progress);
					}
				);
				const storedUserPrompt: string = await getUserPrompt();
				const effectiveParams: AiChatParams = {
					...imagePreprocess.params,
					systemPrompt: imagePreprocess.params.systemPrompt ?? (storedUserPrompt.length > 0 ? storedUserPrompt : undefined)
				};
				persistedParams = effectiveParams;
				logger.info("ai", "chat_started", {
					requestId: request.id,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					editorInstanceId: session.editorInstanceId,
					provider: options.provider,
					model: resolveChatModel(options),
					mode: effectiveParams.mode,
					messageChars: effectiveParams.message.length,
					additionalContextCount: effectiveParams.additionalContext?.length ?? 0,
					hasImages: hasImageAttachments(effectiveParams),
					imageRecognized: imagePreprocess.recognized,
					retryFromRequestId: effectiveParams.retryFromRequestId
				});
				const requestHasImages: boolean = hasImageAttachments(effectiveParams);
				if (effectiveParams.mode === "plan") {
					const plan: StoredPlan = await createInitialPlan(
						socket,
						request.id,
						session,
						effectiveParams,
						options,
						mcpHost,
						turnStartedAt,
						abortController.signal
					);
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: true,
						result: createPlanGetResult(plan)
					});
					break;
				}
				const skillWorkspace: SkillWorkspace | undefined = session.activeWorkspace !== undefined
					? { id: session.activeWorkspace.id, rootPath: session.activeWorkspace.rootPath }
					: undefined;
				const explicitSkills: CatalogSkill[] = skillWorkspace !== undefined
					? await resolveExplicitSkills(skillWorkspace, effectiveParams.skillRefs ?? [])
					: [];
				const builtinToolRestriction: readonly string[] | undefined = resolveBuiltinToolRestriction(explicitSkills);
				const imageGenerationOnly: boolean = isImageGenerationOnlyToolRestriction(builtinToolRestriction);
				let allowedToolNames: readonly string[] | undefined = resolveAllowedToolsForChatParams(effectiveParams, builtinToolRestriction, session.activeWorkspace?.id);
				if (imageGenerationOnly) {
					allowedToolNames = builtinToolRestriction;
				}
				if (allowedToolNames !== undefined && !allowedToolNames.includes("mcp_skills_load")) {
					allowedToolNames = [...allowedToolNames, "mcp_skills_load"];
				}
				if (session.activeWorkspace === undefined) {
					allowedToolNames = allowedToolNames !== undefined
						? filterToolNamesForWorkspace(allowedToolNames, undefined)
						: getNoWorkspaceToolNames();
				}
				allowedToolNames = await resolveSearchAwareToolNames(allowedToolNames, session, webSearchEnabled);
				const promptId = effectiveParams.promptId ?? explicitSkills.find((skill): boolean => skill.defaultPromptId !== undefined)?.defaultPromptId;
				const systemPrompt: string = await composeSystemPrompt(
					promptId,
					effectiveParams.systemPrompt,
					createProviderRuntimeContext(session),
					effectiveParams.mode
				);
				const skillPrompt: string = composeExplicitSkillPrompt(explicitSkills);
				const skillCatalogPrompt: string = skillWorkspace !== undefined ? await composeSkillCatalogPrompt(skillWorkspace) : "";
				const mcpSystemContext: string = await createMcpSystemContext(mcpHost, session);
				const additionalContextSection: string = createAdditionalContextPromptSection(effectiveParams.additionalContext);
				const guidePromptSection: string = consumePendingGuideSection(socket, request.id, session);
				const fullSystemPrompt: string = systemPrompt
					+ (skillPrompt.length > 0 ? `\n\n${skillPrompt}` : "")
					+ (skillCatalogPrompt.length > 0 ? `\n\n${skillCatalogPrompt}` : "")
					+ mcpSystemContext
					+ (additionalContextSection.length > 0 ? `\n\n${additionalContextSection}` : "")
					+ (guidePromptSection.length > 0 ? `\n\n${guidePromptSection}` : "");
				logPromptTrace({
					requestId: request.id,
					promptId,
					skillId: effectiveParams.skillRefs?.join(","),
					customInstructions: effectiveParams.systemPrompt,
					systemPrompt,
					skillPrompt,
					mcpSystemContext,
					additionalContextSection,
					guidePromptSection,
					fullSystemPrompt
				});
				if (effectiveParams.retryFromRequestId !== undefined && session.sessionId !== undefined) {
					await waitForSessionEventPersistence(session);
					const rewoundMessages: StoredMessage[] = await rewindSessionFromRequest(session.sessionId, effectiveParams.retryFromRequestId);
					session.messages = rewoundMessages.map(toChatMessage);
					session.fullSessionLoadPromise = undefined;
					session.summaryMessage = undefined;
					session.summaryCoveredMessageCount = undefined;
				}
				await appendUserMessageToSession(
					session,
					effectiveParams.message,
					request.id,
					turnStartedAt,
					effectiveParams.additionalContext
				);
				await maybeAutoCompressContextBeforeRun(
					socket,
					request.id,
					session,
					apiKey,
					options,
					effectiveParams,
					systemPrompt,
					skillPrompt + skillCatalogPrompt + mcpSystemContext + additionalContextSection + guidePromptSection,
					abortController.signal
				);
				const historyBudgetTokens: number = await computeHistoryBudget(
					session.modelProfile,
					options,
					effectiveParams,
					systemPrompt,
					skillPrompt + skillCatalogPrompt + mcpSystemContext + additionalContextSection + guidePromptSection,
					abortController.signal
				);
				const history: ChatMessage[] = await selectHistoryForModel(session, historyBudgetTokens, request.id);
				let workflowPlan: WorkflowPlan | null = null;
				if (builtinToolRestriction !== undefined && (effectiveParams.mode !== "ask" || imageGenerationOnly)) {
					workflowPlan = createSingleAnswerPlan(effectiveParams, allowedToolNames);
				} else if (requestHasImages) {
					workflowPlan = createSingleAnswerPlan(effectiveParams, []);
				} else if (session.activeWorkspace === undefined) {
					workflowPlan = createSingleAnswerPlan(effectiveParams, allowedToolNames);
				} else if (slashCommandResult.type === "none") {
					if (effectiveParams.mode === "ask" && isCurrentProjectFactRequest(effectiveParams.message)) {
						workflowPlan = createReadOnlyFactWorkflowPlan(effectiveParams);
					} else if (effectiveParams.options?.workflow !== "llm_planned") {
						workflowPlan = createGodotTemplateWorkflowPlan(effectiveParams);
					}
					if (workflowPlan === null) {
						if (effectiveParams.options?.workflow === "llm_planned") {
							try {
								const plannerOptions: ProviderChatOptions = (await resolveProviderTaskModelOptions("workflowPlanner", options)).options;
								workflowPlan = await createLlmWorkflowPlan(effectiveParams, plannerOptions, history, skillPrompt + skillCatalogPrompt + mcpSystemContext + additionalContextSection + guidePromptSection, abortController.signal);
							} catch (error: unknown) {
								logger.warn("ai", "llm_workflow_planner_failed_fallback", {
									requestId: request.id,
									sessionId: session.sessionId,
									message: error instanceof Error ? error.message : "LLM planner failed"
								});
								workflowPlan = planWorkflowAfterLlmPlannerFailure(effectiveParams);
							}
						} else {
							workflowPlan = planWorkflow(effectiveParams);
						}
					}
				}

				if (workflowPlan === null) {
					workflowPlan = createSingleAnswerPlan(effectiveParams, allowedToolNames);
				}
				if (!webSearchEnabled) {
					workflowPlan = filterWebSearchFromWorkflowPlan(workflowPlan);
				}
				logger.info("ai", "workflow_planned", {
					requestId: request.id,
					sessionId: session.sessionId,
					workflowSource: workflowPlan.source ?? null,
					workflowPhaseCount: workflowPlan.phases.length,
					workflowPhaseIds: workflowPlan.phases.map((phase: WorkflowPhase): string => phase.id),
					historyMessages: history.length,
					historyBudgetTokens,
					allowedToolCount: allowedToolNames?.length ?? null
				});

				const originalApprovalGateway: ApprovalGateway = session.approvalGateway;
				if (effectiveParams.mode === "ask" && !imageGenerationOnly) {
					session.approvalGateway = new ReadOnlyToolApprovalGateway(allowedToolNames ?? []);
				}
				try {
					await startWorkflowExecution(
						socket,
						request.id,
						session,
						mcpHost,
						options,
						workflowPlan,
						effectiveParams,
						history,
						historyBudgetTokens,
						turnStartedAt,
						skillPrompt + skillCatalogPrompt + mcpSystemContext + additionalContextSection + guidePromptSection,
						guidePromptSection,
						abortController.signal
					);
				} finally {
					session.approvalGateway = originalApprovalGateway;
				}
				logger.info("ai", "chat_finished", {
					requestId: request.id,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					durationMs: Date.now() - runStartedAtMs
				});
				clearWorkbenchComposer(session, true);
				emitWorkbenchUpdated(socket, request.id, session);
				break;
			} catch (error: unknown) {
				if (isCancellationError(error, abortController.signal)) {
					logger.warn("ai", "chat_cancelled", {
						requestId: request.id,
						sessionId: session.sessionId,
						workspaceId: session.activeWorkspace?.id,
						durationMs: Date.now() - runStartedAtMs
					});
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: true,
						result: {
							cancelled: true,
							requestId: request.id
						}
					});
					break;
				}
				if (error instanceof ProviderImageInputError) {
					logger.warn("ai", "image_input_rejected", {
						requestId: request.id,
						sessionId: session.sessionId,
						code: error.code,
						message: error.message
					});
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
				if (error instanceof ContextTooLargeError) {
					logger.warn("ai", "context_too_large", {
						requestId: request.id,
						sessionId: session.sessionId,
						workspaceId: session.activeWorkspace?.id,
						message: error.message
					});
					sendSessionEvent(socket, request.id, session, "agent.run.error", {
						runId: request.id,
						code: error.code,
						message: error.message
					});
					await waitForSessionEventPersistence(session);
					await appendFailedChatTurnToSession(
						session,
						persistedParams.message,
						{
							code: error.code,
							message: error.message
						},
						request.id,
						turnStartedAt,
						undefined,
						persistedParams.additionalContext
					);
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
				logger.error("ai", "chat_failed", error, {
					requestId: request.id,
					sessionId: session.sessionId,
					workspaceId: session.activeWorkspace?.id,
					code: providerError.code,
					durationMs: Date.now() - runStartedAtMs
				});
				sendSessionEvent(socket, request.id, session, "agent.run.error", {
					runId: request.id,
					code: providerError.code,
					message: providerError.message
				});
				await waitForSessionEventPersistence(session);
				await appendFailedChatTurnToSession(
					session,
					persistedParams.message,
					{
						code: providerError.code,
						message: providerError.message
					},
					request.id,
					turnStartedAt,
					undefined,
					persistedParams.additionalContext
				);
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
				if (session.activeRunRequestId === request.id) {
					session.activeRunRequestId = undefined;
				}
				setWorkbenchActiveRun(session, {
					status: session.approvalGateway.listPending().length > 0 ? "approval" : "idle",
					requestId: request.id
				});
				emitWorkbenchUpdated(socket, request.id, session);
				finishSessionRun(session.sessionId, request.id);
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
				setWorkbenchNextStepHints(session, hints, request.params?.trigger ?? "done", request.params?.anchorRequestId);
				emitWorkbenchUpdated(socket, request.id, session);
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
