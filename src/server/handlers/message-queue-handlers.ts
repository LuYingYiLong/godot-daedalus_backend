import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession, QueuedMessage, QueuedMessageStatus } from "../client-session.js";
import { sendJson } from "../send-json.js";
import {
	emitMessageQueueUpdated,
	enqueueMessage,
	removeQueuedMessage,
	type QueueMutationResult,
	serializeMessageQueue,
	serializeQueuedMessage,
	setQueuedMessageStatus,
	updateQueuedMessage
} from "../message-queue.js";
import { bumpWorkbenchRevision, emitWorkbenchUpdated, serializeWorkbench } from "../workbench.js";

function sendQueueResult(socket: WebSocket, request: ClientRequest, session: ClientSession, extra: Record<string, unknown> = {}): void {
	sendJson(socket, {
		type: "response",
		id: request.id,
		ok: true,
		result: {
			...extra,
			messageQueue: serializeMessageQueue(session),
			workbench: serializeWorkbench(session)
		}
	});
}

function parseQueueId(value: unknown): number {
	const queueId: number = typeof value === "number" ? value : Number(value);
	return Number.isInteger(queueId) && queueId > 0 ? queueId : 0;
}

export function handleMessageQueueRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, _mcpHost: McpHost): void {
	switch (request.method) {
	case "message.queue.list":
		sendQueueResult(socket, request, session);
		break;

	case "message.queue.add": {
		const item: QueuedMessage = enqueueMessage(session, request.params.text, request.params.additionalContext);
		bumpWorkbenchRevision(session);
		sendQueueResult(socket, request, session, {
			queueAdded: true,
			item: serializeQueuedMessage(item)
		});
		emitMessageQueueUpdated(socket, request.id, session);
		emitWorkbenchUpdated(socket, request.id, session);
		break;
	}

	case "message.queue.update": {
		const result: QueueMutationResult = updateQueuedMessage(
			session,
			parseQueueId(request.params.queueId),
			request.params.text,
			request.params.additionalContext
		);
		if (result.item === undefined) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "queue_item_not_found", message: "Queued message not found." }
			});
			break;
		}
		if (result.changed) {
			bumpWorkbenchRevision(session);
		}
		sendQueueResult(socket, request, session, {
			queueUpdated: result.changed,
			item: serializeQueuedMessage(result.item)
		});
		if (result.changed) {
			emitMessageQueueUpdated(socket, request.id, session);
			emitWorkbenchUpdated(socket, request.id, session);
		}
		break;
	}

	case "message.queue.remove": {
		const removed: boolean = removeQueuedMessage(session, parseQueueId(request.params.queueId));
		if (removed) {
			bumpWorkbenchRevision(session);
		}
		sendQueueResult(socket, request, session, {
			queueRemoved: removed,
			removed
		});
		if (removed) {
			emitMessageQueueUpdated(socket, request.id, session);
			emitWorkbenchUpdated(socket, request.id, session);
		}
		break;
	}

	case "message.queue.status": {
		const result: QueueMutationResult = setQueuedMessageStatus(
			session,
			parseQueueId(request.params.queueId),
			request.params.status as QueuedMessageStatus
		);
		if (result.item === undefined) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "queue_item_not_found", message: "Queued message not found." }
			});
			break;
		}
		if (result.changed) {
			bumpWorkbenchRevision(session);
		}
		sendQueueResult(socket, request, session, {
			queueStatusUpdated: result.changed,
			item: serializeQueuedMessage(result.item)
		});
		if (result.changed) {
			emitMessageQueueUpdated(socket, request.id, session);
			emitWorkbenchUpdated(socket, request.id, session);
		}
		break;
	}

		default:
			throw new Error(`Unsupported message queue method: ${request.method}`);
	}
}
