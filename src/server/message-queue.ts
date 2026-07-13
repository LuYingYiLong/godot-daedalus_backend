import type WebSocket from "ws";
import type { AdditionalContextItem } from "../protocol/types.js";
import type { ClientSession, QueuedMessage, QueuedMessageStatus } from "./client-session.js";
import { sendSessionEvent } from "./session-events.js";

const MAX_QUEUE_TEXT_CHARS: number = 20000;

export function serializeQueuedMessage(message: QueuedMessage): Record<string, unknown> {
	return {
		id: message.id,
		text: message.text,
		additionalContext: message.additionalContext ?? [],
		status: message.status,
		createdAt: message.createdAt,
		updatedAt: message.updatedAt
	};
}

export function serializeMessageQueue(session: ClientSession): Record<string, unknown>[] {
	return session.queuedMessages.map(serializeQueuedMessage);
}

export function emitMessageQueueUpdated(socket: WebSocket, requestId: string, session: ClientSession): void {
	sendSessionEvent(socket, requestId, session, "message.queue.updated", {
		type: "message.queue.updated",
		messageQueue: serializeMessageQueue(session),
		updatedAt: new Date().toISOString()
	});
}

export function enqueueMessage(
	session: ClientSession,
	text: string,
	additionalContext: AdditionalContextItem[] | undefined
): QueuedMessage {
	const now: string = new Date().toISOString();
	session.messageQueueNextId += 1;
	const message: QueuedMessage = {
		id: session.messageQueueNextId,
		text: text.trim().slice(0, MAX_QUEUE_TEXT_CHARS),
		additionalContext: additionalContext ?? [],
		status: "pending",
		createdAt: now,
		updatedAt: now
	};
	session.queuedMessages.push(message);
	return message;
}

export function findQueuedMessageIndex(session: ClientSession, queueId: number): number {
	return session.queuedMessages.findIndex((message: QueuedMessage): boolean => message.id === queueId);
}

export function updateQueuedMessage(
	session: ClientSession,
	queueId: number,
	text: string,
	additionalContext: AdditionalContextItem[] | undefined
): QueuedMessage | undefined {
	const index: number = findQueuedMessageIndex(session, queueId);
	if (index < 0) {
		return undefined;
	}

	const next: QueuedMessage = {
		...(session.queuedMessages[index] as QueuedMessage),
		text: text.trim().slice(0, MAX_QUEUE_TEXT_CHARS),
		additionalContext: additionalContext ?? [],
		status: "pending",
		updatedAt: new Date().toISOString()
	};
	session.queuedMessages[index] = next;
	return next;
}

export function setQueuedMessageStatus(
	session: ClientSession,
	queueId: number,
	status: QueuedMessageStatus
): QueuedMessage | undefined {
	const index: number = findQueuedMessageIndex(session, queueId);
	if (index < 0) {
		return undefined;
	}

	const next: QueuedMessage = {
		...(session.queuedMessages[index] as QueuedMessage),
		status,
		updatedAt: new Date().toISOString()
	};
	session.queuedMessages[index] = next;
	return next;
}

export function removeQueuedMessage(session: ClientSession, queueId: number): boolean {
	const index: number = findQueuedMessageIndex(session, queueId);
	if (index < 0) {
		return false;
	}
	session.queuedMessages.splice(index, 1);
	return true;
}
