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
import {
	createAgentToolEventForwarder,
	createEmptyWorkflowPhaseToolStats,
	updateWorkflowPhaseToolStats,
	shouldRequireWorkflowWriteTool,
	didWorkflowWritePhaseExecute,
	isWorkflowProposalPhase,
	createWorkflowWriteGuardRetryMessage,
	sendWorkflowEvent,
	mapWorkflowEventToAgentEvent,
	convertWorkflowSnapshotToAgentSnapshot,
	sendWorkflowTodoSnapshot,
	runWorkflowPhase,
	createWorkflowPhasePrompt,
	createWorkflowPendingContinuation,
	continueWorkflowExecution,
	startWorkflowExecution
} from "./workflow-execution.js";
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

export async function handleSessionRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "session.reset":
			session.messages = [];
			session.fullSessionLoadPromise = undefined;
			session.summaryMessage = undefined;
			session.summaryCoveredMessageCount = undefined;
			session.pendingGuides = [];
			if (session.sessionId) {
				await clearSessionEvents(session.sessionId);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					reset: true,
					historyMessagesStored: session.messages.length
				}
			});
			break;

		case "session.info":
			await waitForFullSessionLoad(session);
			await loadHydratedPendingApprovalStates(session);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: createSessionInfoResult(session, mcpHost, await estimateMessagesTokens(session.messages))
			});
			break;

		case "session.create": {
			const workspaceId: string | undefined = request.params.workspaceId ?? session.activeWorkspace?.id;
			const skillId: SkillId | undefined = request.params.skillId ?? session.activeSkillId;
			let workspace: WorkspaceConfig | undefined;

			if (workspaceId) {
				workspace = findWorkspace(workspaceId);

				if (!workspace) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "workspace_not_found",
							message: `Workspace not found: ${workspaceId}`
						}
					});
					break;
				}

				try {
					await mcpHost.switchWorkspace(workspace);
				} catch (error: unknown) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: false,
						error: {
							code: "workspace_switch_failed",
							message: error instanceof Error ? error.message : "Failed to switch MCP workspace"
						}
					});
					break;
				}
			}

			const metadata: SessionMetadata = await createSession(
				request.params.title,
				workspaceId,
				skillId
			);
			session.sessionId = metadata.id;
			session.sessionTitle = metadata.title;
			session.messages = [];
			session.fullSessionLoadPromise = undefined;
			session.summaryMessage = undefined;
			session.summaryCoveredMessageCount = undefined;
			session.pendingGuides = [];

			if (workspace) {
				session.activeWorkspace = workspace;
				session.godotProjectPath = workspace.rootPath;

				if (workspace.godotExecutablePath) {
					session.godotExecutablePath = workspace.godotExecutablePath;
				}
			}

			if (skillId) {
				session.activeSkillId = skillId;
			}

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: metadata
			});
			break;
		}

		case "session.open": {
			try {
				const openMessageLimit: number = clampSessionOpenMessageLimit(request.params.limit);
				const timeline = await openSessionRecentTimeline(request.params.sessionId, openMessageLimit);
				let workspace: WorkspaceConfig | undefined;
				let workspaceWarning: string | undefined;

				if (timeline.metadata.workspaceId) {
					workspace = findWorkspace(timeline.metadata.workspaceId);

					if (!workspace) {
						workspaceWarning = `Session workspace not found: ${timeline.metadata.workspaceId}`;
						console.warn(`[session] ${workspaceWarning}`);
					} else {
						try {
							await mcpHost.switchWorkspace(workspace);
						} catch (error: unknown) {
							workspaceWarning = error instanceof Error ? error.message : "Failed to switch MCP workspace";
							console.warn(`[session] Failed to switch workspace for ${timeline.metadata.id}:`, workspaceWarning);
							workspace = undefined;
						}
					}
				}

				session.sessionId = timeline.metadata.id;
				session.sessionTitle = timeline.metadata.title;
				session.messages = timeline.messages.map(toChatMessage);
				const storedForGuides: Awaited<ReturnType<typeof openSession>> = await openSession(request.params.sessionId);
				session.pendingGuides = hydratePendingGuides(storedForGuides.events);
				startFullSessionLoad(session, timeline.metadata.id);

				const summary = await readSummary(request.params.sessionId);
				session.summaryMessage = summary !== null ? createSummaryMessage(summary) : undefined;
				session.summaryCoveredMessageCount = summary?.messageCount;

				if (workspace) {
					session.activeWorkspace = workspace;
					session.godotProjectPath = workspace.rootPath;

					if (workspace.godotExecutablePath) {
						session.godotExecutablePath = workspace.godotExecutablePath;
					}
				}

				session.activeSkillId = timeline.metadata.activeSkillId && isSkillId(timeline.metadata.activeSkillId)
					? timeline.metadata.activeSkillId
					: undefined;

				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						opened: true,
						metadata: timeline.metadata,
						...createTimelinePageResult(timeline, openMessageLimit),
						pendingGuides: session.pendingGuides.map(serializePendingGuide),
						workspaceWarning: workspaceWarning ?? null
					}
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_not_found",
						message: error instanceof Error ? error.message : "Session not found"
					}
				});
			}
			break;
		}

		case "session.timeline": {
			const sessionId: string | undefined = request.params.sessionId ?? session.sessionId;
			if (sessionId === undefined) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session" }
				});
				break;
			}

			try {
				const limit: number = clampSessionOpenMessageLimit(request.params.limit);
				const timeline = await openSessionTimelinePage(sessionId, request.params.beforeOffset, limit);
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						timeline: true,
						sessionId,
						...createTimelinePageResult(timeline, limit)
					}
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "session_timeline_error",
						message: error instanceof Error ? error.message : "Failed to load session timeline"
					}
				});
			}
			break;
		}

		case "session.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { sessions: await listSessions() }
			});
			break;

		case "session.archive": {
			if (session.sessionId === request.params.sessionId) {
				await waitForFullSessionLoad(session);
				await waitForSessionEventPersistence(session);
			}

			const metadata: SessionMetadata = await archiveSession(request.params.sessionId);
			if (session.sessionId === request.params.sessionId) {
				clearActiveSession(session);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { archived: true, metadata }
			});
			break;
		}

		case "session.archived.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { archivedSessions: await listArchivedSessions() }
			});
			break;

		case "session.archived.restore": {
			const metadata: SessionMetadata = await restoreArchivedSession(request.params.sessionId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { restored: true, metadata }
			});
			break;
		}

		case "session.archived.delete":
			await deleteArchivedSession(request.params.sessionId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { deletedArchived: true, sessionId: request.params.sessionId }
			});
			break;

		case "session.save":
			await waitForFullSessionLoad(session);
			if (!session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session to save. Create one first with session.create." }
				});
				break;
			}
			await waitForSessionEventPersistence(session);
			await saveSession(session.sessionId, session.messages, {
				workspaceId: session.activeWorkspace?.id,
				activeSkillId: session.activeSkillId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { saved: true, sessionId: session.sessionId, messageCount: session.messages.length }
			});
			break;

		case "session.delete":
			await deleteSession(request.params.sessionId);
			if (session.sessionId === request.params.sessionId) {
				clearActiveSession(session);
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: { deleted: true, sessionId: request.params.sessionId }
			});
			break;

		case "session.rename": {
			const metadata: SessionMetadata = await renameSession(request.params.sessionId, request.params.title);
			if (session.sessionId === request.params.sessionId) {
				session.sessionTitle = metadata.title;
			}
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: metadata
			});
			break;
		}

		case "session.compress": {
			await waitForFullSessionLoad(session);
			if (!session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session" }
				});
				break;
			}

			const apiKey: string | undefined = await ensureProviderConfigured(session);
			if (!apiKey) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_api_key", message: `${getProviderDisplayName(session.activeProvider)} API key not configured` }
				});
				break;
			}

			try {
				const keepRecent = request.params?.keepRecent ?? 8;
				const allMessages: ChatMessage[] = session.messages;

				if (allMessages.length <= keepRecent) {
					sendJson(socket, {
						type: "response",
						id: request.id,
						ok: true,
						result: { compressed: false, reason: "Not enough messages", messageCount: allMessages.length }
					});
					break;
				}

				const oldMessages = allMessages.slice(0, allMessages.length - keepRecent);
				const conversationText = oldMessages
					.map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
					.join("\n");

				const client = createDeepSeekClient(createProviderChatOptions(session, apiKey));
				const compressorOptions: ProviderChatOptions = createProviderChatOptions(session, apiKey);
				const compressorPrompt: string = await loadSessionCompressorPrompt();
				const completion = await client.chat.completions.create({
					model: resolveChatModel(compressorOptions),
					messages: [
						{
							role: "system",
							content: compressorPrompt
						},
						{ role: "user", content: conversationText }
					],
					max_tokens: 800
				});

				const summaryContent: string = completion.choices[0]?.message?.content ?? "(empty summary)";

				const summaryObj: SessionSummary = {
					content: summaryContent,
					messageCount: oldMessages.length,
					tokenEstimate: Math.ceil(conversationText.length / 3),
					generatedAt: new Date().toISOString()
				};

				await writeSummary(session.sessionId, summaryObj);
				const recentMessages = allMessages.slice(allMessages.length - keepRecent);
				session.summaryMessage = createSummaryMessage(summaryObj);
				session.summaryCoveredMessageCount = summaryObj.messageCount;
				session.messages = allMessages;

				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: true,
					result: {
						compressed: true,
						oldMessageCount: oldMessages.length,
						keptMessageCount: recentMessages.length,
						summaryLength: summaryContent.length
					}
				});
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "compress_error",
						message: error instanceof Error ? error.message : "Compression failed"
					}
				});
			}
			break;
		}

		case "session.summary": {
			if (!session.sessionId) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: { code: "no_session", message: "No active session" }
				});
				break;
			}

			const summary = await readSummary(session.sessionId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: summary ?? { content: null, reason: "No summary yet" }
			});
			break;
		}

		default:
			throw new Error(`Unsupported session request method: ${request.method}`);
	}
}
