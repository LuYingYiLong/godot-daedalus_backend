import WebSocket from "ws";
import type { AiChatParams, ServerEvent } from "../protocol/types.js";
import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import { appendAgentEvent, appendSessionEvent, appendWorkflowEvent, openSession, renameSession, type SessionMetadata } from "../session/session-store.js";
import { generateSessionTitle, shouldApplyGeneratedSessionTitle } from "./session-title.js";
import type { ClientSession, ThinkingEventBuffer } from "./client-session.js";
import { sendJson } from "./send-json.js";

const THINKING_EVENT_FLUSH_CHARS = 800;

export function shouldPersistSessionEvent(eventName: ServerEvent["event"]): boolean {
	return eventName.startsWith("agent.")
		|| eventName.startsWith("tool.")
		|| eventName === "ai.delta"
		|| eventName.startsWith("ai.thinking.")
		|| eventName === "ai.status"
		|| eventName.startsWith("workflow.")
		|| eventName.startsWith("guide.");
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
		console.error("Failed to persist session event:", error);
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
	persistRequestId: string
): void {
	if (!session.sessionId || !shouldPersistSessionEvent(eventName)) {
		return;
	}

	if (eventName === "ai.delta") {
		const text: string = getThinkingDeltaText(data);
		if (text.length === 0) {
			return;
		}

		const key: string = getThinkingEventBufferKey(session.sessionId, persistRequestId);
		const existingBuffer: ThinkingEventBuffer | undefined = session.aiDeltaEventBuffers.get(key);
		const buffer: ThinkingEventBuffer = existingBuffer ?? {
			sessionId: session.sessionId,
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

	const aiDeltaKey: string = getThinkingEventBufferKey(session.sessionId, persistRequestId);
	flushAiDeltaEventBuffer(session, aiDeltaKey);

	if (eventName === "ai.thinking.delta") {
		const text: string = getThinkingDeltaText(data);
		if (text.length === 0) {
			return;
		}

		const key: string = getThinkingEventBufferKey(session.sessionId, persistRequestId);
		const existingBuffer: ThinkingEventBuffer | undefined = session.thinkingEventBuffers.get(key);
		const buffer: ThinkingEventBuffer = existingBuffer ?? {
			sessionId: session.sessionId,
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
		const key: string = getThinkingEventBufferKey(session.sessionId, persistRequestId);
		flushThinkingEventBuffer(session, key);
		session.thinkingEventBuffers.delete(key);
	}

	const sessionId: string = session.sessionId;
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
	persistRequestId: string = requestId
): void {
	sendJson(socket, {
		type: "event",
		id: requestId,
		event: eventName,
		data
	});

	persistSessionEvent(session, eventName, data, persistRequestId);
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
		console.log("[session-title] skipped:", {
			requestId,
			sessionId: sessionId ?? null,
			wasFirstTurn,
			retry: params.retryFromRequestId !== undefined
		});
		return;
	}

	const originalTitle: string | undefined = session.sessionTitle;
	console.log("[session-title] scheduled:", {
		requestId,
		sessionId,
		originalTitle: originalTitle ?? ""
	});

	void (async (): Promise<void> => {
		const storedBefore = await openSession(sessionId);
		if (!shouldApplyGeneratedSessionTitle(originalTitle, storedBefore.metadata.title)) {
			console.log("[session-title] skipped because title changed before generation:", {
				sessionId,
				originalTitle: originalTitle ?? "",
				currentTitle: storedBefore.metadata.title
			});
			return;
		}

		const generatedTitle: string = await generateSessionTitle(params.message, options);
		if (generatedTitle.length === 0) {
			console.log("[session-title] skipped because generated title is empty:", {
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
			console.log("[session-title] title already current, metadata synchronized:", {
				sessionId,
				title: storedBefore.metadata.title
			});
			return;
		}

		const storedAfter = await openSession(sessionId);
		if (!shouldApplyGeneratedSessionTitle(originalTitle, storedAfter.metadata.title)) {
			console.log("[session-title] skipped because title changed after generation:", {
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
		console.log("[session-title] renamed:", {
			sessionId,
			from: storedAfter.metadata.title,
			to: metadata.title
		});
	})().catch((error: unknown): void => {
		console.warn("[session-title] Failed to generate session title:", error);
	});
}
