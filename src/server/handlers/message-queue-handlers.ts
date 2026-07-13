import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession, QueuedMessage, QueuedMessageStatus } from "../client-session.js";
import { sendJson } from "../send-json.js";
import {
	emitMessageQueueUpdated,
	enqueueMessage,
	removeQueuedMessage,
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
		emitMessageQueueUpdated(socket, request.id, session);
		emitWorkbenchUpdated(socket, request.id, session);
		sendQueueResult(socket, request, session, {
			queueAdded: true,
			item: serializeQueuedMessage(item)
		});
		break;
	}

	case "message.queue.update": {
		const item: QueuedMessage | undefined = updateQueuedMessage(
			session,
			parseQueueId(request.params.queueId),
			request.params.text,
			request.params.additionalContext
		);
		if (item === undefined) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "queue_item_not_found", message: "Queued message not found." }
			});
			break;
		}
		bumpWorkbenchRevision(session);
		emitMessageQueueUpdated(socket, request.id, session);
		emitWorkbenchUpdated(socket, request.id, session);
		sendQueueResult(socket, request, session, {
			queueUpdated: true,
			item: serializeQueuedMessage(item)
		});
		break;
	}

	case "message.queue.remove": {
		const removed: boolean = removeQueuedMessage(session, parseQueueId(request.params.queueId));
		bumpWorkbenchRevision(session);
		emitMessageQueueUpdated(socket, request.id, session);
		emitWorkbenchUpdated(socket, request.id, session);
		sendQueueResult(socket, request, session, {
			queueRemoved: true,
			removed
		});
		break;
	}

	case "message.queue.status": {
		const item: QueuedMessage | undefined = setQueuedMessageStatus(
			session,
			parseQueueId(request.params.queueId),
			request.params.status as QueuedMessageStatus
		);
		if (item === undefined) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "queue_item_not_found", message: "Queued message not found." }
			});
			break;
		}
		bumpWorkbenchRevision(session);
		emitMessageQueueUpdated(socket, request.id, session);
		emitWorkbenchUpdated(socket, request.id, session);
		sendQueueResult(socket, request, session, {
			queueStatusUpdated: true,
			item: serializeQueuedMessage(item)
		});
		break;
	}

		default:
			throw new Error(`Unsupported message queue method: ${request.method}`);
	}
}
