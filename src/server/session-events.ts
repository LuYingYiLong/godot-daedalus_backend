import WebSocket from "ws";
import type { AiChatParams, ServerEvent } from "../protocol/types.js";
import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import { appendAgentEvent, appendSessionEvent, appendWorkflowEvent, openSession, renameSession, type SessionMetadata } from "../session/session-store.js";
import { createFallbackSessionTitle, generateSessionTitle, shouldApplyGeneratedSessionTitle } from "./session-title.js";
import { resolveProviderTaskModelOptions } from "../providers/task-model-routing.js";
import type { ClientSession, ThinkingEventBuffer } from "./client-session.js";
import { sendJson } from "./send-json.js";
import { broadcastSessionEvent } from "./client-connections.js";
import { logger } from "../logger.js";
import { withProviderUsageContext } from "../usage/provider-recorder.js";

const THINKING_EVENT_FLUSH_CHARS = 800;
const MAX_TERMINAL_EVENT_FINGERPRINTS = 512;

function withSessionId(data: unknown, sessionId: string | undefined): unknown {
	if (sessionId === undefined || typeof data !== "object" || data === null || Array.isArray(data)) {
		return data;
	}

	return {
		...data,
		sessionId
	};
}

function getDataSessionId(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return undefined;
	}

	const sessionId: unknown = (data as Record<string, unknown>).sessionId;
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

function getRecordString(data: unknown, key: string): string {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return "";
	}

	const value: unknown = (data as Record<string, unknown>)[key];
	return typeof value === "string" ? value.trim() : "";
}

function createTerminalEventFingerprint(eventName: ServerEvent["event"], data: unknown, sessionId: string | undefined, persistRequestId: string): string | null {
	if (eventName !== "agent.run.error" && eventName !== "workflow.error" && eventName !== "agent.run.cancelled") {
		return null;
	}
	if (sessionId === undefined) {
		return null;
	}

	const message: string = eventName === "agent.run.cancelled"
		? getRecordString(data, "reason") || "cancelled"
		: getRecordString(data, "message");
	if (message.length === 0) {
		return null;
	}

	const terminalKind: string = eventName === "agent.run.cancelled" ? "cancelled" : "error";
	return `${sessionId}\n${persistRequestId}\n${terminalKind}\n${message}`;
}

function shouldSuppressDuplicateTerminalEvent(session: ClientSession, eventName: ServerEvent["event"], data: unknown, sessionId: string | undefined, persistRequestId: string): boolean {
	const fingerprint: string | null = createTerminalEventFingerprint(eventName, data, sessionId, persistRequestId);
	if (fingerprint === null) {
		return false;
	}
	if (session.terminalErrorEventFingerprints.has(fingerprint)) {
		logger.debug("session", "duplicate_terminal_event_suppressed", {
			sessionId,
			requestId: persistRequestId,
			eventName,
			message: getRecordString(data, eventName === "agent.run.cancelled" ? "reason" : "message")
		});
		return true;
	}

	if (session.terminalErrorEventFingerprints.size >= MAX_TERMINAL_EVENT_FINGERPRINTS) {
		session.terminalErrorEventFingerprints.clear();
	}
	session.terminalErrorEventFingerprints.add(fingerprint);
	return false;
}

export function shouldPersistSessionEvent(eventName: ServerEvent["event"]): boolean {
	return eventName.startsWith("agent.")
		|| eventName.startsWith("tool.")
		|| eventName.startsWith("terminal.")
		|| eventName === "ai.delta"
		|| eventName.startsWith("ai.thinking.")
		|| eventName === "ai.status"
		|| eventName.startsWith("workflow.")
		|| eventName.startsWith("guide.")
		|| eventName.startsWith("skill.")
		|| eventName.startsWith("plan.");
}

export function getThinkingEventBufferKey(sessionId: string, requestId: string): string {
	return `${sessionId}\n${requestId}`;
}

export function getThinkingDeltaText(data: unknown): string {
	if (typeof data !== "object" || data === null || !("text" in data)) {
		return "";
	}

	return String((data as { text?: unknown }).text ?? "");
}

export function getWorkflowIdFromEventData(data: unknown): string | null {
	if (typeof data !== "object" || data === null || !("workflowId" in data)) {
		return null;
	}

	const workflowId: unknown = (data as { workflowId?: unknown }).workflowId;
	return typeof workflowId === "string" && workflowId.length > 0 ? workflowId : null;
}

export function getAgentRunIdFromEventData(data: unknown): string | null {
	if (typeof data !== "object" || data === null || !("runId" in data)) {
		return null;
	}

	const runId: unknown = (data as { runId?: unknown }).runId;
	return typeof runId === "string" && runId.length > 0 ? runId : null;
}

export function enqueueSessionEventWrite(session: ClientSession, operation: () => Promise<void>): void {
	const nextWrite: Promise<void> = session.eventPersistQueue.then(operation, operation);
	session.eventPersistQueue = nextWrite.catch((error: unknown): void => {
		logger.error("session", "event_persist_failed", error, {
			sessionId: session.sessionId
		});
	});
}

export function flushThinkingEventBuffer(session: ClientSession, key: string): void {
	const buffer: ThinkingEventBuffer | undefined = session.thinkingEventBuffers.get(key);
	if (buffer === undefined || buffer.text.length === 0) {
		return;
	}

	const text: string = buffer.text;
	buffer.text = "";
	enqueueSessionEventWrite(session, async (): Promise<void> => {
		await appendSessionEvent(buffer.sessionId, buffer.requestId, "ai.thinking.delta", {
			type: "ai.thinking.delta",
			text
		});
	});
}

export function flushAllThinkingEventBuffers(session: ClientSession): void {
	for (const key of session.thinkingEventBuffers.keys()) {
		flushThinkingEventBuffer(session, key);
	}
}

export function flushAiDeltaEventBuffer(session: ClientSession, key: string): void {
	const buffer: ThinkingEventBuffer | undefined = session.aiDeltaEventBuffers.get(key);
	if (buffer === undefined || buffer.text.length === 0) {
		return;
	}

	const text: string = buffer.text;
	buffer.text = "";
	enqueueSessionEventWrite(session, async (): Promise<void> => {
		await appendSessionEvent(buffer.sessionId, buffer.requestId, "ai.delta", {
			type: "ai.delta",
			text
		});
	});
}

export function flushAllAiDeltaEventBuffers(session: ClientSession): void {
	for (const key of session.aiDeltaEventBuffers.keys()) {
		flushAiDeltaEventBuffer(session, key);
	}
}

export async function waitForSessionEventPersistence(session: ClientSession): Promise<void> {
	flushAllAiDeltaEventBuffers(session);
	flushAllThinkingEventBuffers(session);
	await session.eventPersistQueue;
}

export function persistSessionEvent(
	session: ClientSession,
	eventName: ServerEvent["event"],
	data: unknown,
	persistRequestId: string,
	sessionIdOverride?: string | undefined
): void {
	const sessionId: string | undefined = sessionIdOverride ?? getDataSessionId(data) ?? session.sessionId;
	if (sessionId === undefined || !shouldPersistSessionEvent(eventName)) {
		return;
	}

	if (eventName === "ai.delta") {
		const text: string = getThinkingDeltaText(data);
		if (text.length === 0) {
			return;
		}

		const key: string = getThinkingEventBufferKey(sessionId, persistRequestId);
		const existingBuffer: ThinkingEventBuffer | undefined = session.aiDeltaEventBuffers.get(key);
		const buffer: ThinkingEventBuffer = existingBuffer ?? {
			sessionId,
			requestId: persistRequestId,
			text: ""
		};
		buffer.text += text;
		session.aiDeltaEventBuffers.set(key, buffer);

		if (buffer.text.length >= THINKING_EVENT_FLUSH_CHARS) {
			flushAiDeltaEventBuffer(session, key);
		}
		return;
	}

	const aiDeltaKey: string = getThinkingEventBufferKey(sessionId, persistRequestId);
	flushAiDeltaEventBuffer(session, aiDeltaKey);

	if (eventName === "ai.thinking.delta") {
		const text: string = getThinkingDeltaText(data);
		if (text.length === 0) {
			return;
		}

		const key: string = getThinkingEventBufferKey(sessionId, persistRequestId);
		const existingBuffer: ThinkingEventBuffer | undefined = session.thinkingEventBuffers.get(key);
		const buffer: ThinkingEventBuffer = existingBuffer ?? {
			sessionId,
			requestId: persistRequestId,
			text: ""
		};
		buffer.text += text;
		session.thinkingEventBuffers.set(key, buffer);

		if (buffer.text.length >= THINKING_EVENT_FLUSH_CHARS) {
			flushThinkingEventBuffer(session, key);
		}
		return;
	}

	if (eventName === "ai.thinking.done") {
		const key: string = getThinkingEventBufferKey(sessionId, persistRequestId);
		flushThinkingEventBuffer(session, key);
		session.thinkingEventBuffers.delete(key);
	}

	enqueueSessionEventWrite(session, async (): Promise<void> => {
		await appendSessionEvent(sessionId, persistRequestId, eventName, data);
		if (eventName.startsWith("workflow.")) {
			const workflowId: string | null = getWorkflowIdFromEventData(data);
			if (workflowId !== null) {
				await appendWorkflowEvent(sessionId, workflowId, persistRequestId, eventName, data);
			}
		}
		if (eventName.startsWith("agent.")) {
			const runId: string | null = getAgentRunIdFromEventData(data);
			if (runId !== null) {
				await appendAgentEvent(sessionId, runId, persistRequestId, eventName, data);
			}
		}
	});
}

export function sendSessionEvent(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	eventName: ServerEvent["event"],
	data: unknown,
	persistRequestId: string = requestId,
	sessionIdOverride?: string | undefined
): void {
	const sessionId: string | undefined = sessionIdOverride ?? getDataSessionId(data) ?? session.sessionId;
	const eventData: unknown = withSessionId(data, sessionId);
	if (shouldSuppressDuplicateTerminalEvent(session, eventName, eventData, sessionId, persistRequestId)) {
		return;
	}

	sendJson(socket, {
		type: "event",
		id: requestId,
		event: eventName,
		data: eventData
	});

	if (sessionId !== undefined) {
		broadcastSessionEvent(socket, sessionId, requestId, eventName, eventData);
	}

	persistSessionEvent(session, eventName, eventData, persistRequestId, sessionId);
}

export function sendGlobalEvent(socket: WebSocket, requestId: string, eventName: ServerEvent["event"], data: unknown): void {
	if (socket.readyState !== WebSocket.OPEN) {
		return;
	}

	sendJson(socket, {
		type: "event",
		id: requestId,
		event: eventName,
		data
	});
}

export function maybeScheduleSessionTitleGeneration(
	socket: WebSocket,
	requestId: string,
	session: ClientSession,
	params: AiChatParams,
	options: ProviderChatOptions,
	wasFirstTurn: boolean
): void {
	const sessionId: string | undefined = session.sessionId;
	if (!wasFirstTurn || sessionId === undefined || params.retryFromRequestId !== undefined) {
		logger.debug("session_title", "skipped", {
			requestId,
			sessionId: sessionId ?? null,
			wasFirstTurn,
			retry: params.retryFromRequestId !== undefined
		});
		return;
	}

	const originalTitle: string | undefined = session.sessionTitle;
	logger.info("session_title", "scheduled", {
		requestId,
		sessionId,
		originalTitle: originalTitle ?? ""
	});

	void (async (): Promise<void> => {
		const storedBefore = await openSession(sessionId);
		if (!shouldApplyGeneratedSessionTitle(originalTitle, storedBefore.metadata.title)) {
			logger.info("session_title", "skipped_title_changed_before", {
				sessionId,
				originalTitle: originalTitle ?? "",
				currentTitle: storedBefore.metadata.title
			});
			return;
		}

		let generatedTitle: string;
		try {
			const titleOptions = withProviderUsageContext(
				(await resolveProviderTaskModelOptions("sessionTitle", options)).options,
				{ operation: "session_title" }
			);
			generatedTitle = await generateSessionTitle(params.message, titleOptions);
		} catch (error: unknown) {
			generatedTitle = createFallbackSessionTitle(params.message);
			logger.warn("session_title", "generation_failed_fallback", {
				sessionId,
				requestId,
				message: error instanceof Error ? error.message : String(error)
			});
		}
		if (generatedTitle.length === 0) {
			logger.info("session_title", "skipped_empty_title", {
				sessionId,
				currentTitle: storedBefore.metadata.title
			});
			return;
		}
		if (generatedTitle === storedBefore.metadata.title) {
			sendGlobalEvent(socket, requestId, "session.renamed", {
				sessionId,
				title: storedBefore.metadata.title,
				metadata: storedBefore.metadata
			});
			logger.info("session_title", "already_current", {
				sessionId,
				title: storedBefore.metadata.title
			});
			return;
		}

		const storedAfter = await openSession(sessionId);
		if (!shouldApplyGeneratedSessionTitle(originalTitle, storedAfter.metadata.title)) {
			logger.info("session_title", "skipped_title_changed_after", {
				sessionId,
				originalTitle: originalTitle ?? "",
				currentTitle: storedAfter.metadata.title,
				generatedTitle
			});
			return;
		}

		const metadata: SessionMetadata = await renameSession(sessionId, generatedTitle);
		if (session.sessionId === sessionId) {
			session.sessionTitle = metadata.title;
		}
		sendGlobalEvent(socket, requestId, "session.renamed", {
			sessionId,
			title: metadata.title,
			metadata
		});
		logger.info("session_title", "renamed", {
			sessionId,
			from: storedAfter.metadata.title,
			to: metadata.title
		});
	})().catch((error: unknown): void => {
		logger.error("session_title", "failed", error, {
			sessionId,
			requestId
		});
	});
}
