import WebSocket from "ws";
import { composeSystemPrompt, listPromptTemplates } from "../prompts/registry.js";
import type { AdditionalContextItem, AiChatParams, ChatMessage, ClientRequest, ModelProfile, ProviderId, ServerEvent } from "../protocol/types.js";
import type { ProviderAgentResult } from "../providers/agent-types.js";
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
	sendSessionEvent,
	waitForSessionEventPersistence
} from "./session-events.js";

export const tokenCounterPromise: Promise<TokenCounter> = createTokenCounter();
export let sessionCompressorPromptCache: string | undefined;
export const DEFAULT_SESSION_OPEN_MESSAGE_LIMIT: number = 80;
export const MAX_SESSION_OPEN_MESSAGE_LIMIT: number = 500;
export const DEFAULT_SESSION_OPEN_EVENT_LIMIT: number = 80;
export const MAX_SESSION_OPEN_EVENT_LIMIT: number = 160;
export const SESSION_OPEN_PREVIEW_STRING_LIMIT: number = 1200;
export const SESSION_OPEN_PREVIEW_ARRAY_LIMIT: number = 80;
export const THINKING_EVENT_FLUSH_CHARS: number = 512;
export const REQUEST_DEDUP_TTL_MS: number = 5 * 60 * 1000;
export const MAX_COMPLETED_REQUEST_IDS: number = 512;
export const CUSTOM_INSTRUCTIONS_TRACE_WARNING_CHARS: number = 4000;
export const DEFAULT_NEXT_STEP_HINT_COUNT: number = 3;
export const MAX_NEXT_STEP_HINT_COUNT: number = 5;
export const MAX_NEXT_STEP_HINT_MESSAGE_CHARS: number = 320;
export const MAX_GUIDE_TEXT_CHARS: number = 4000;
export const MAX_WORKFLOW_AUTO_REPAIR_ROUNDS: number = 2;

export type WorkflowPhaseToolStats = {
	toolEvents: number;
	proposeToolEvents: number;
	writeToolEvents: number;
	approvalEvents: number;
};

export type WorkflowPhaseRunResult = {
	agentResult: ProviderAgentResult;
	toolStats: WorkflowPhaseToolStats;
	toolObservations: WorkflowToolObservation[];
};

export function fingerprintText(text: string): string {
	if (text.length === 0) {
		return "empty";
	}

	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function logPromptTrace(params: {
	requestId: string;
	promptId: string | undefined;
	skillId: string | undefined;
	phaseId?: string | undefined;
	customInstructions: string | undefined;
	systemPrompt: string;
	skillPrompt: string;
	mcpSystemContext: string;
	additionalContextSection?: string | undefined;
	guidePromptSection?: string | undefined;
	fullSystemPrompt: string;
}): void {
	const customInstructions: string = params.customInstructions?.trim() ?? "";
	const customTrace: string = customInstructions.length === 0
		? "none"
		: `${customInstructions.length}chars:${fingerprintText(customInstructions)}`;
	const phaseTrace: string = params.phaseId !== undefined ? ` phase=${params.phaseId}` : "";
	console.info(
		[
			`[prompt.trace] request=${params.requestId}${phaseTrace}`,
			`prompt=${params.promptId ?? "default"}`,
			`skill=${params.skillId ?? "none"}`,
			`custom=${customTrace}`,
			`system=${params.systemPrompt.length}chars:${fingerprintText(params.systemPrompt)}`,
			`skillPrompt=${params.skillPrompt.length}chars:${fingerprintText(params.skillPrompt)}`,
			`mcpContext=${params.mcpSystemContext.length}chars:${fingerprintText(params.mcpSystemContext)}`,
			`additionalContext=${(params.additionalContextSection ?? "").length}chars:${fingerprintText(params.additionalContextSection ?? "")}`,
			`guide=${(params.guidePromptSection ?? "").length}chars:${fingerprintText(params.guidePromptSection ?? "")}`,
			`full=${params.fullSystemPrompt.length}chars:${fingerprintText(params.fullSystemPrompt)}`
		].join(" ")
	);
	console.info(
		`[prompt.priority] request=${params.requestId}${phaseTrace} order=runtime_system_and_tool_safety > project_instructions > current_user_message > settings_custom_instructions > defaults`
	);

	if (customInstructions.length >= CUSTOM_INSTRUCTIONS_TRACE_WARNING_CHARS) {
		console.warn(
			`[prompt.warning] request=${params.requestId}${phaseTrace} custom_instructions_long=${customInstructions.length}chars:${fingerprintText(customInstructions)}`
		);
	}
}

export function logProjectInstructionTrace(session: ClientSession, serverId: string, fileName: string, content: string): void {
	const workspaceId: string = session.activeWorkspace?.id ?? "none";
	const sessionId: string = session.sessionId ?? "none";
	console.info(
		`[prompt.project-instruction] session=${sessionId} workspace=${workspaceId} server=${serverId} file=${fileName} chars=${content.length} sha256=${fingerprintText(content)}`
	);
}

export async function getTokenCounter(): Promise<TokenCounter> {
	return tokenCounterPromise;
}

export async function loadSessionCompressorPrompt(): Promise<string> {
	if (sessionCompressorPromptCache !== undefined) {
		return sessionCompressorPromptCache;
	}

	const promptPath: string = path.resolve(process.cwd(), "src/prompts/templates/internal/session-compressor.md");
	const content: string = await fs.readFile(promptPath, "utf8");
	const trimmedContent: string = content.trim();
	sessionCompressorPromptCache = trimmedContent;
	return trimmedContent;
}

export type NextStepHint = {
	title: string;
	message: string;
};

export function isCancellationError(error: unknown, abortSignal?: AbortSignal | undefined): boolean {
	if (abortSignal?.aborted) {
		return true;
	}
	if (!(error instanceof Error)) {
		return false;
	}

	return error.name === "AbortError" || error.message.toLowerCase().includes("cancel");
}

export function sendAgentCancelled(socket: WebSocket, requestId: string, session: ClientSession, runId: string = requestId, reason: string = "cancelled"): void {
	sendSessionEvent(socket, requestId, session, "agent.run.cancelled", {
		runId,
		requestId,
		reason
	}, requestId);
}

export function sendAiCancelled(socket: WebSocket, requestId: string, reason: string = "cancelled"): void {
	sendJson(socket, {
		type: "event",
		id: requestId,
		event: "ai.cancelled",
		data: {
			requestId,
			reason
		}
	});
}

export function pruneCompletedRequestIds(session: ClientSession, now: number = Date.now()): void {
	for (const [requestId, completedAt] of session.completedRequestIds.entries()) {
		if (now - completedAt > REQUEST_DEDUP_TTL_MS) {
			session.completedRequestIds.delete(requestId);
		}
	}

	while (session.completedRequestIds.size > MAX_COMPLETED_REQUEST_IDS) {
		const oldestRequestId: string | undefined = session.completedRequestIds.keys().next().value;
		if (oldestRequestId === undefined) {
			break;
		}
		session.completedRequestIds.delete(oldestRequestId);
	}
}

export function beginRequestExecution(socket: WebSocket, request: ClientRequest, session: ClientSession): boolean {
	if (request.id.length === 0) {
		return true;
	}

	pruneCompletedRequestIds(session);
	if (session.inFlightRequestIds.has(request.id)) {
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				duplicate: true,
				ignored: true,
				state: "in_flight",
				method: request.method
			}
		});
		return false;
	}

	if (session.completedRequestIds.has(request.id)) {
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				duplicate: true,
				ignored: true,
				state: "completed",
				method: request.method
			}
		});
		return false;
	}

	session.inFlightRequestIds.add(request.id);
	return true;
}

export function finishRequestExecution(request: ClientRequest, session: ClientSession): void {
	if (request.id.length === 0) {
		return;
	}

	session.inFlightRequestIds.delete(request.id);
	session.completedRequestIds.set(request.id, Date.now());
	pruneCompletedRequestIds(session);
}

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

export function parseMessage(data: WebSocket.RawData, isBinary: boolean): unknown {
	if (isBinary) {
		throw new Error("Binary messages are not supported");
	}

	const text: string = typeof data === "string" ? data : data.toString("utf8");
	return JSON.parse(text) as unknown;
}

export async function estimateTextTokens(text: string): Promise<number> {
	const tc: TokenCounter = await getTokenCounter();
	return tc.countText(text);
}

export async function estimateMessagesTokens(messages: ChatMessage[]): Promise<number> {
	const tc: TokenCounter = await getTokenCounter();
	let total: number = 0;

	for (const message of messages) {
		total += await tc.countText(`${message.role}: ${message.content}`);
	}

	return total;
}

export async function estimateTextTokensForProvider(options: ProviderChatOptions, text: string, abortSignal?: AbortSignal | undefined): Promise<number> {
	try {
		const providerEstimate: number | null = await estimateProviderTextTokens(options, text, abortSignal);
		if (providerEstimate !== null) {
			return providerEstimate;
		}
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : String(error);
		console.warn(`[token-counter] ${getProviderDisplayName(options.provider)} token estimate failed, using local counter: ${message}`);
	}

	return estimateTextTokens(text);
}

export async function estimateCurrentMessageTokensForProvider(options: ProviderChatOptions, params: AiChatParams, abortSignal?: AbortSignal | undefined): Promise<number> {
	if (!hasImageAttachments(params)) {
		return estimateTextTokensForProvider(options, params.message, abortSignal);
	}

	try {
		const providerEstimate: number | null = await estimateProviderMessagesTokens(options, [createCurrentUserMessage(params)], abortSignal);
		if (providerEstimate !== null) {
			return providerEstimate;
		}
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : String(error);
		console.warn(`[token-counter] ${getProviderDisplayName(options.provider)} multimodal token estimate failed, using local counter: ${message}`);
	}

	const imageTokens: number = getImageAttachments(params.additionalContext)
		.reduce((sum: number, image): number => sum + Math.ceil(image.byteSize / 384), 0);
	return await estimateTextTokens(params.message) + imageTokens;
}

export async function selectHistoryWithinBudget(messages: ChatMessage[], budgetTokens: number): Promise<ChatMessage[]> {
	const tc: TokenCounter = await getTokenCounter();
	return selectMessagesWithinBudget(messages, budgetTokens, tc);
}

export async function computeHistoryBudget(
	profile: ModelProfile,
	options: ProviderChatOptions,
	params: AiChatParams,
	systemPrompt: string,
	mcpContext: string,
	abortSignal?: AbortSignal | undefined
): Promise<number> {
	const tc: TokenCounter = await getTokenCounter();
	const outputReserveTokens: number = params.options?.maxTokens ?? profile.defaultOutputReserveTokens;
	const systemPromptTokens: number = await estimateTextTokensForProvider(options, systemPrompt, abortSignal);
	const mcpContextTokens: number = await estimateTextTokensForProvider(options, mcpContext, abortSignal);
	const currentMessageTokens: number = await estimateCurrentMessageTokensForProvider(options, params, abortSignal);

	return computeInputBudget({
		profile,
		outputReserveTokens,
		systemPromptTokens,
		mcpContextTokens,
		toolDefinitionsTokens: 0,
		currentMessageTokens,
		tokenCounter: tc
	});
}

export async function appendChatTurnToSession(
	session: ClientSession,
	_history: ChatMessage[],
	userMessage: string,
	assistantMessage: string,
	requestId: string,
	userCreatedAt: string = new Date().toISOString(),
	assistantCreatedAt: string = new Date().toISOString(),
	additionalContext?: readonly AdditionalContextItem[] | undefined
): Promise<boolean> {
	if (session.messages.some((message: ChatMessage): boolean => message.requestId === requestId)) {
		return false;
	}

	const userChatMessage: ChatMessage = { role: "user", content: userMessage, requestId, createdAt: userCreatedAt };
	const clonedAdditionalContext: AdditionalContextItem[] | undefined = cloneAdditionalContextItems(additionalContext);
	if (clonedAdditionalContext !== undefined) {
		userChatMessage.additionalContext = clonedAdditionalContext;
	}

	const nextMessages: ChatMessage[] = [
		...session.messages,
		userChatMessage,
		{ role: "assistant", content: assistantMessage, requestId, createdAt: assistantCreatedAt }
	];
	session.messages = nextMessages;
	return true;
}

export async function selectHistoryForModel(session: ClientSession, budgetTokens: number): Promise<ChatMessage[]> {
	if (session.summaryMessage === undefined) {
		return selectHistoryWithinBudget(session.messages, budgetTokens);
	}

	const summaryTokens: number = await estimateMessagesTokens([session.summaryMessage]);
	const recentBudgetTokens: number = Math.max(0, budgetTokens - summaryTokens);
	const recentSourceMessages: ChatMessage[] = session.summaryCoveredMessageCount !== undefined
		? session.messages.slice(session.summaryCoveredMessageCount)
		: session.messages;
	const recentMessages: ChatMessage[] = await selectHistoryWithinBudget(recentSourceMessages, recentBudgetTokens);
	return [session.summaryMessage, ...recentMessages];
}

export function createSummaryMessage(summary: SessionSummary): ChatMessage {
	const generatedAtText: string = summary.generatedAt.length > 0
		? ` — 生成于 ${summary.generatedAt}`
		: "";

	return {
		role: "system",
		content: `[会话摘要${generatedAtText}]\n${summary.content}`
	};
}

export function getSessionProjectPath(session: ClientSession): string {
	return session.activeWorkspace?.rootPath ?? session.godotProjectPath ?? process.env.GODOT_PROJECT_PATH ?? "";
}

export function toChatMessage(message: StoredMessage): ChatMessage {
	const chatMessage: ChatMessage = {
		role: message.role,
		content: message.content
	};

	if (message.requestId !== undefined) {
		chatMessage.requestId = message.requestId;
	}

	if (message.createdAt !== undefined) {
		chatMessage.createdAt = message.createdAt;
	}

	if (message.additionalContext !== undefined && message.additionalContext.length > 0) {
		chatMessage.additionalContext = cloneAdditionalContextItems(message.additionalContext);
	}

	return chatMessage;
}

export function clampSessionOpenMessageLimit(limit: number | undefined): number {
	if (limit === undefined) {
		return DEFAULT_SESSION_OPEN_MESSAGE_LIMIT;
	}

	return Math.min(MAX_SESSION_OPEN_MESSAGE_LIMIT, Math.max(1, Math.floor(limit)));
}

export function createPreviewValue(value: unknown, depth: number = 0): unknown {
	if (typeof value === "string") {
		if (value.length <= SESSION_OPEN_PREVIEW_STRING_LIMIT) {
			return value;
		}

		return [
			value.slice(0, SESSION_OPEN_PREVIEW_STRING_LIMIT),
			`\n\n[历史事件内容已截断，原始长度 ${value.length} 字符]`
		].join("");
	}

	if (value === null || typeof value !== "object") {
		return value;
	}

	if (depth >= 6) {
		return "[历史事件嵌套内容已截断]";
	}

	if (Array.isArray(value)) {
		const previewItems: unknown[] = value
			.slice(0, SESSION_OPEN_PREVIEW_ARRAY_LIMIT)
			.map((item: unknown): unknown => createPreviewValue(item, depth + 1));

		if (value.length > SESSION_OPEN_PREVIEW_ARRAY_LIMIT) {
			previewItems.push(`[历史事件数组已截断，原始长度 ${value.length}]`);
		}

		return previewItems;
	}

	const source: Record<string, unknown> = value as Record<string, unknown>;
	const preview: Record<string, unknown> = {};

	for (const [key, item] of Object.entries(source)) {
		preview[key] = createPreviewValue(item, depth + 1);
	}

	return preview;
}

export function createSessionEventPreview(event: StoredSessionEvent): StoredSessionEvent {
	return {
		...event,
		data: createPreviewValue(event.data)
	};
}

export function createTimelinePageResult(page: StoredSessionTimelinePage, limit: number): Record<string, unknown> {
	const eventLimit: number = Math.min(
		MAX_SESSION_OPEN_EVENT_LIMIT,
		Math.max(DEFAULT_SESSION_OPEN_EVENT_LIMIT, limit * 2)
	);
	const events: StoredSessionEvent[] = page.events.length > eventLimit
		? page.events.slice(page.events.length - eventLimit)
		: page.events;

	return {
		messageCount: page.messageCount,
		eventCount: page.eventCount,
		messagesOffset: page.messagesOffset,
		eventsIncluded: events.length,
		limit,
		eventLimit,
		hasMoreBefore: page.hasMoreBefore,
		messages: page.messages.map(toChatMessage),
		events: events.map(createSessionEventPreview),
		latestWorkflowSnapshot: page.latestWorkflowSnapshot === null ? null : createPreviewValue(page.latestWorkflowSnapshot),
		latestAgentSnapshot: page.latestAgentSnapshot === null ? null : createPreviewValue(page.latestAgentSnapshot)
	};
}

export function startFullSessionLoad(session: ClientSession, sessionId: string): void {
	const loadPromise: Promise<void> = (async (): Promise<void> => {
		try {
			const stored = await openSession(sessionId);
			if (session.sessionId !== sessionId) {
				return;
			}

			session.messages = stored.messages.map(toChatMessage);
			session.pendingGuides = hydratePendingGuides(stored.events);
		} catch (error: unknown) {
			console.error(`[session] Failed to load complete history for ${sessionId}:`, error);
		}
	})();

	const trackedPromise: Promise<void> = loadPromise.finally((): void => {
		if (session.fullSessionLoadPromise === trackedPromise) {
			session.fullSessionLoadPromise = undefined;
		}
	});
	session.fullSessionLoadPromise = trackedPromise;
}

export async function waitForFullSessionLoad(session: ClientSession): Promise<void> {
	if (session.fullSessionLoadPromise !== undefined) {
		await session.fullSessionLoadPromise;
	}
}

export function createProviderChatOptions(session: ClientSession, apiKey: string): ProviderChatOptions {
	const options: ProviderChatOptions = { provider: session.activeProvider, apiKey };
	if (session.providerModel !== undefined) {
		options.model = session.providerModel;
	}
	if (session.providerBaseUrl !== undefined) {
		options.baseUrl = session.providerBaseUrl;
	}

	return options;
}

export function createGuideId(): string {
	return `guide-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clipTextByChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}

	return text.slice(0, maxChars);
}

export function cloneAdditionalContextItems(items: readonly AdditionalContextItem[] | undefined): AdditionalContextItem[] | undefined {
	if (items === undefined || items.length === 0) {
		return undefined;
	}

	return items.map((item: AdditionalContextItem): AdditionalContextItem => ({ ...item }));
}

export function getAdditionalContextDataRecord(item: AdditionalContextItem): Record<string, unknown> | undefined {
	if (item.data === undefined || typeof item.data !== "object" || item.data === null || Array.isArray(item.data)) {
		return undefined;
	}

	return item.data as Record<string, unknown>;
}

export function getContextNumber(data: Record<string, unknown> | undefined, key: string): number | undefined {
	if (data === undefined) {
		return undefined;
	}

	const value: unknown = data[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}

	return Math.floor(value);
}

export function getContextString(data: Record<string, unknown> | undefined, key: string): string {
	const value: unknown = data?.[key];
	return typeof value === "string" ? value : "";
}

export function createLineColumnRangeText(data: Record<string, unknown> | undefined): string {
	const lineStart: number | undefined = getContextNumber(data, "lineStart");
	const columnStart: number | undefined = getContextNumber(data, "columnStart");
	const lineEnd: number | undefined = getContextNumber(data, "lineEnd");
	const columnEnd: number | undefined = getContextNumber(data, "columnEnd");
	if (lineStart === undefined || columnStart === undefined || lineEnd === undefined || columnEnd === undefined) {
		return "";
	}

	return `${lineStart}:${columnStart}-${lineEnd}:${columnEnd}`;
}

export function appendScriptSelectionPromptLines(lines: string[], item: AdditionalContextItem): void {
	const data: Record<string, unknown> | undefined = getAdditionalContextDataRecord(item);
	const rangeText: string = createLineColumnRangeText(data);
	if (rangeText.length > 0) {
		lines.push(`  - range: ${rangeText} (1-based line/column)`);
	}

	const hasSelection: boolean = data?.hasSelection === true;
	const selectedTextPreview: string = getContextString(data, "selectedTextPreview");
	const lineTextPreview: string = getContextString(data, "lineTextPreview");
	const editorTextPreview: string = getContextString(data, "editorTextPreview");
	if (hasSelection && selectedTextPreview.trim().length > 0) {
		lines.push("  - selectedTextPreview:");
		lines.push(clipTextByChars(selectedTextPreview, 2000));
		if (data?.selectedTextTruncated === true) {
			lines.push("  - selectedTextPreviewTruncated: true");
		}
	} else if (lineTextPreview.trim().length > 0) {
		lines.push(`  - currentLinePreview: ${clipTextByChars(lineTextPreview, 500)}`);
	}
	if (editorTextPreview.trim().length > 0) {
		const editorTextLineCount: number | undefined = getContextNumber(data, "editorTextLineCount");
		lines.push(`  - editorTextPreview${editorTextLineCount !== undefined ? ` (${editorTextLineCount} lines)` : ""}:`);
		lines.push(clipTextByChars(editorTextPreview, 12000));
		if (data?.editorTextTruncated === true) {
			lines.push("  - editorTextPreviewTruncated: true");
		}
	}

	if (data?.resourcePathAvailable === false) {
		lines.push("  - note: Godot 当前没有提供脚本资源路径，通常是脚本未保存或存在解析错误；优先使用 editorTextPreview 分析。");
	} else {
		lines.push("  - note: editorTextPreview 是当前脚本编辑器内容快照；如需磁盘上下文，请按 resourcePath 用读取工具按需读取。");
	}
}

export function appendFilesystemSelectionPromptLines(lines: string[], item: AdditionalContextItem): void {
	const data: Record<string, unknown> | undefined = getAdditionalContextDataRecord(item);
	const selectedPaths: unknown = data?.selectedPaths;
	if (!Array.isArray(selectedPaths)) {
		lines.push("  - note: 文件系统选择只提供资源引用；文件内容需要用 MCP read/search 工具按需读取。");
		return;
	}

	const pathLines: string[] = [];
	for (const selectedPath of selectedPaths.slice(0, 20)) {
		if (typeof selectedPath !== "object" || selectedPath === null || Array.isArray(selectedPath)) {
			continue;
		}

		const selectedPathRecord: Record<string, unknown> = selectedPath as Record<string, unknown>;
		const resourcePath: string = typeof selectedPathRecord.resourcePath === "string" ? selectedPathRecord.resourcePath : "";
		if (resourcePath.length === 0) {
			continue;
		}
		const selectedKind: string = typeof selectedPathRecord.kind === "string" ? selectedPathRecord.kind : "file";
		pathLines.push(`    - ${selectedKind}: ${clipTextByChars(resourcePath, 300)}`);
	}

	if (pathLines.length > 0) {
		lines.push("  - selectedPaths:");
		lines.push(...pathLines);
	}
	if (selectedPaths.length > 20 || data?.truncated === true) {
		lines.push(`  - selectedPathsTruncated: true (${selectedPaths.length} total reported)`);
	}
	lines.push("  - note: 大文件和文件夹不内联内容；只在需要时按 resourcePath 读取或搜索。");
}

export function createAdditionalContextPromptSection(items: readonly AdditionalContextItem[] | undefined): string {
	if (items === undefined || items.length === 0) {
		return "";
	}

	const lines: string[] = [
		"## 用户附加上下文",
		"以下是用户本轮显式附加的紧凑上下文。不要把这些条目当成长期记忆；它们只对本轮任务生效。大文件和文件夹只提供引用，不内联全文；如需内容，使用可用 MCP 读取工具按需读取。",
		"编辑器上下文规则：如果 Godot 编辑器在线，并且任务目标明显指向当前打开场景、选中节点、当前脚本/这几行或 FileSystem Dock 选中项，优先使用 godot_editor 读取/检查/patch；如果返回 editor_unavailable、上下文 stale，或目标不在当前编辑器上下文中，回退到离线 .tscn/text/headless 工具。"
	];

	for (const item of items.slice(0, 20)) {
		const title: string = clipTextByChars(item.title.trim(), 120);
		const subtitle: string = clipTextByChars((item.subtitle ?? "").trim(), 220);
		const headerParts: string[] = [
			`- [${item.kind}] ${title}`,
			subtitle.length > 0 ? `— ${subtitle}` : "",
			item.pinned === true ? "(pinned)" : "",
			`source=${item.source}`
		].filter((part: string): boolean => part.length > 0);
		lines.push(headerParts.join(" "));

		if (item.resourcePath !== undefined) {
			lines.push(`  - resourcePath: ${clipTextByChars(item.resourcePath, 300)}`);
		}
		if (item.nodePath !== undefined) {
			lines.push(`  - nodePath: ${clipTextByChars(item.nodePath, 300)}`);
		}
		if (item.nodeType !== undefined) {
			lines.push(`  - nodeType: ${clipTextByChars(item.nodeType, 120)}`);
		}
		if (item.scriptPath !== undefined) {
			lines.push(`  - scriptPath: ${clipTextByChars(item.scriptPath, 300)}`);
		}
		if (item.summary !== undefined && item.summary.trim().length > 0) {
			lines.push(`  - summary: ${clipTextByChars(item.summary.trim(), 500)}`);
		}
		if (item.kind === "image") {
			lines.push("  - note: 图片二进制已作为多模态 image_url content part 单独发送给模型；不要在文本上下文中期待 base64。");
		}
		if (item.kind === "script_selection") {
			appendScriptSelectionPromptLines(lines, item);
		} else if (item.kind === "filesystem_selection") {
			appendFilesystemSelectionPromptLines(lines, item);
		}
		if (item.data !== undefined && item.kind !== "script_selection" && item.kind !== "filesystem_selection" && item.kind !== "image") {
			lines.push(`  - data: ${clipTextByChars(JSON.stringify(createPreviewValue(item.data)), 1000)}`);
		}
	}

	if (items.length > 20) {
		lines.push(`- [truncated] 另有 ${items.length - 20} 条上下文未注入。`);
	}

	return lines.join("\n");
}

export function createPendingGuide(clientGuideId: string, text: string, anchorRequestId: string | undefined): PendingGuide {
	const timestamp: string = new Date().toISOString();
	const guide: PendingGuide = {
		id: createGuideId(),
		clientGuideId,
		text: clipTextByChars(text.trim(), MAX_GUIDE_TEXT_CHARS),
		createdAt: timestamp,
		updatedAt: timestamp
	};
	if (anchorRequestId !== undefined) {
		guide.anchorRequestId = anchorRequestId;
	}
	return guide;
}

export function serializePendingGuide(guide: PendingGuide): Record<string, unknown> {
	return {
		guideId: guide.id,
		clientGuideId: guide.clientGuideId,
		text: guide.text,
		anchorRequestId: guide.anchorRequestId ?? null,
		status: "pending",
		createdAt: guide.createdAt,
		updatedAt: guide.updatedAt
	};
}

export function findPendingGuideIndexById(session: ClientSession, guideId: string): number {
	return session.pendingGuides.findIndex((guide: PendingGuide): boolean => guide.id === guideId);
}

export function findPendingGuideByClientId(session: ClientSession, clientGuideId: string): PendingGuide | undefined {
	return session.pendingGuides.find((guide: PendingGuide): boolean => guide.clientGuideId === clientGuideId);
}

export function readEventDataObject(event: StoredSessionEvent): Record<string, unknown> | null {
	if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) {
		return null;
	}

	return event.data as Record<string, unknown>;
}

export function hydratePendingGuides(events: StoredSessionEvent[]): PendingGuide[] {
	const pendingById: Map<string, PendingGuide> = new Map();

	for (const event of events) {
		const data: Record<string, unknown> | null = readEventDataObject(event);
		if (data === null) {
			continue;
		}

		const guideId: string = String(data.guideId ?? "");
		if (guideId.length === 0) {
			continue;
		}

		if (event.event === "guide.added") {
			const text: string = String(data.text ?? "").trim();
			const clientGuideId: string = String(data.clientGuideId ?? guideId);
			if (text.length === 0) {
				continue;
			}

			const guide: PendingGuide = {
				id: guideId,
				clientGuideId,
				text: clipTextByChars(text, MAX_GUIDE_TEXT_CHARS),
				createdAt: String(data.createdAt ?? event.createdAt),
				updatedAt: String(data.updatedAt ?? event.createdAt)
			};
			const anchorRequestId: string = String(data.anchorRequestId ?? "");
			if (anchorRequestId.length > 0) {
				guide.anchorRequestId = anchorRequestId;
			}
			pendingById.set(guideId, guide);
		} else if (event.event === "guide.updated") {
			const guide: PendingGuide | undefined = pendingById.get(guideId);
			if (guide === undefined) {
				continue;
			}
			const text: string = String(data.text ?? "").trim();
			if (text.length > 0) {
				guide.text = clipTextByChars(text, MAX_GUIDE_TEXT_CHARS);
			}
			guide.updatedAt = String(data.updatedAt ?? event.createdAt);
		} else if (event.event === "guide.deleted" || event.event === "guide.applied") {
			pendingById.delete(guideId);
		}
	}

	return [...pendingById.values()];
}

export async function persistGuideEvent(
	session: ClientSession,
	requestId: string,
	eventName: "guide.added" | "guide.updated" | "guide.deleted",
	data: Record<string, unknown>
): Promise<void> {
	if (!session.sessionId) {
		return;
	}

	await waitForSessionEventPersistence(session);
	await appendSessionEvent(session.sessionId, requestId, eventName, data);
}

export function formatGuidePromptSection(guides: PendingGuide[]): string {
	if (guides.length === 0) {
		return "";
	}

	return [
		"## 用户实时引导（安全边界注入）",
		"以下内容是用户在模型响应过程中提交的引导，不属于聊天历史消息，但在本轮安全边界已经生效。请把它们视为当前用户意图的补充；若与系统提示、AGENTS.md、工具安全边界或更高优先级指令冲突，必须服从更高优先级并说明无法满足的部分。",
		...guides.map((guide: PendingGuide, index: number): string => [
			`### 引导 ${index + 1}`,
			guide.text
		].join("\n"))
	].join("\n\n");
}

export function consumePendingGuideSection(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	persistRequestId: string = requestId
): string {
	if (session.pendingGuides.length === 0) {
		return "";
	}

	const guides: PendingGuide[] = session.pendingGuides.splice(0, session.pendingGuides.length);
	const appliedAt: string = new Date().toISOString();
	for (const guide of guides) {
		console.info(
			`[guide.applied] session=${session.sessionId ?? "none"} request=${persistRequestId} guide=${guide.id} chars=${guide.text.length} sha256=${fingerprintText(guide.text)}`
		);
		sendSessionEvent(socket, requestId, session, "guide.applied", {
			type: "guide.applied",
			guideId: guide.id,
			clientGuideId: guide.clientGuideId,
			anchorRequestId: guide.anchorRequestId ?? null,
			appliedAt
		}, persistRequestId);
	}

	return formatGuidePromptSection(guides);
}

export function parseJsonObjectLoose(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		const startIndex: number = text.indexOf("{");
		const endIndex: number = text.lastIndexOf("}");
		if (startIndex >= 0 && endIndex > startIndex) {
			return JSON.parse(text.slice(startIndex, endIndex + 1)) as unknown;
		}
		throw new Error("LLM did not return valid JSON");
	}
}

export function normalizeNextStepHints(raw: unknown, maxHints: number): NextStepHint[] {
	const source: unknown = typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>).hints
		: raw;
	if (!Array.isArray(source)) {
		return [];
	}

	const hints: NextStepHint[] = [];
	for (const item of source) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			continue;
		}

		const record: Record<string, unknown> = item as Record<string, unknown>;
		const title: string = String(record.title ?? "").trim();
		const message: string = String(record.message ?? "").trim();
		const normalizedMessage: string = clipTextByChars(message.length > 0 ? message : title, MAX_NEXT_STEP_HINT_MESSAGE_CHARS);
		if (normalizedMessage.length === 0) {
			continue;
		}

		hints.push({
			title: clipTextByChars(title.length > 0 ? title : normalizedMessage, 48),
			message: normalizedMessage
		});
		if (hints.length >= maxHints) {
			break;
		}
	}

	return hints;
}

export function createNextStepHintPrompt(trigger: string, anchorRequestId: string | undefined): string {
	return [
		"你是 Godot Daedalus 的对话引导器。只生成下一步建议，不调用工具，不修改会话，不输出解释文本。",
		"输出必须是 JSON object，格式：{\"hints\":[{\"title\":\"短标题\",\"message\":\"可直接填入输入框的一句话\"}]}",
		"规则：",
		"- 生成 2 到 3 条。",
		"- message 必须短、具体、可直接作为用户下一轮消息。",
		"- 避免重复刚刚已经完成的动作。",
		"- 如果用户当前正在修改代码，优先建议验证、补测、总结或继续明确目标。",
		`- 触发点：${trigger || "done"}。`,
		anchorRequestId ? `- 锚点请求：${anchorRequestId}。` : ""
	].filter((line: string): boolean => line.length > 0).join("\n");
}

export async function createNextStepHints(
	session: ClientSession,
	options: ProviderChatOptions,
	maxHints: number,
	trigger: string,
	anchorRequestId: string | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<NextStepHint[]> {
	const clippedMaxHints: number = Math.max(1, Math.min(MAX_NEXT_STEP_HINT_COUNT, Math.floor(maxHints)));
	const history: ChatMessage[] = session.messages.slice(-8);
	const latestMessages: string = history
		.map((message: ChatMessage): string => `${message.role}: ${clipTextByChars(message.content, 1200)}`)
		.join("\n\n");
	const text: string = await chatWithDeepSeek(
		{
			message: [
				"请基于下面最近会话生成下一步提示。",
				"",
				"## 最近会话",
				latestMessages.length > 0 ? latestMessages : "暂无会话历史。"
			].join("\n"),
			options: {
				temperature: 0.35,
				maxTokens: 600,
				responseFormat: "json",
				workflow: "single"
			}
		},
		options,
		[],
		createNextStepHintPrompt(trigger, anchorRequestId),
		abortSignal
	);
	return normalizeNextStepHints(parseJsonObjectLoose(text), clippedMaxHints);
}

export {
	normalizeChatParamsForMode,
	resolveAllowedToolsForChatParams
} from "./chat-mode.js";

export {
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
