import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession, PendingGuide } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { clipTextByChars } from "../additional-context.js";
import {
	MAX_GUIDE_TEXT_CHARS,
	createPendingGuide,
	findPendingGuideByClientId,
	findPendingGuideIndexById,
	persistGuideEvent,
	serializePendingGuide
} from "../pending-guides.js";
import { bumpWorkbenchRevision, emitWorkbenchUpdated, serializeWorkbench } from "../workbench.js";

export async function handleGuideRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, _mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "session.guide.add": {
		if (!session.sessionId) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "no_session", message: "No active session for guide." }
			});
			break;
		}

		const existingGuide: PendingGuide | undefined = findPendingGuideByClientId(session, request.params.clientGuideId);
		if (existingGuide !== undefined) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					guideAdded: true,
					duplicate: true,
					guide: serializePendingGuide(existingGuide),
					pendingGuides: session.pendingGuides.map(serializePendingGuide),
					workbench: serializeWorkbench(session)
				}
			});
			break;
		}

		const guide: PendingGuide = createPendingGuide(
			request.params.clientGuideId,
			request.params.text,
			request.params.anchorRequestId
		);
		session.pendingGuides.push(guide);
		const data: Record<string, unknown> = {
			type: "guide.added",
			...serializePendingGuide(guide)
		};
		await persistGuideEvent(session, request.id, "guide.added", data);
		bumpWorkbenchRevision(session);
		emitWorkbenchUpdated(socket, request.id, session);
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				guideAdded: true,
				guide: serializePendingGuide(guide),
				pendingGuides: session.pendingGuides.map(serializePendingGuide),
				workbench: serializeWorkbench(session)
			}
		});
		break;
	}

	case "session.guide.update": {
		if (!session.sessionId) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "no_session", message: "No active session for guide." }
			});
			break;
		}

		const guideIndex: number = findPendingGuideIndexById(session, request.params.guideId);
		if (guideIndex < 0) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "guide_not_found", message: `Pending guide not found: ${request.params.guideId}` }
			});
			break;
		}

		const guide: PendingGuide = session.pendingGuides[guideIndex] as PendingGuide;
		guide.text = clipTextByChars(request.params.text.trim(), MAX_GUIDE_TEXT_CHARS);
		guide.updatedAt = new Date().toISOString();
		session.pendingGuides[guideIndex] = guide;
		const data: Record<string, unknown> = {
			type: "guide.updated",
			...serializePendingGuide(guide)
		};
		await persistGuideEvent(session, request.id, "guide.updated", data);
		bumpWorkbenchRevision(session);
		emitWorkbenchUpdated(socket, request.id, session);
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				guideUpdated: true,
				guide: serializePendingGuide(guide),
				pendingGuides: session.pendingGuides.map(serializePendingGuide),
				workbench: serializeWorkbench(session)
			}
		});
		break;
	}

	case "session.guide.delete": {
		if (!session.sessionId) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: { code: "no_session", message: "No active session for guide." }
			});
			break;
		}

		const guideIndex: number = findPendingGuideIndexById(session, request.params.guideId);
		const deletedGuide: PendingGuide | undefined = guideIndex >= 0
			? session.pendingGuides.splice(guideIndex, 1)[0]
			: undefined;
		const data: Record<string, unknown> = {
			type: "guide.deleted",
			guideId: request.params.guideId,
			clientGuideId: deletedGuide?.clientGuideId ?? null,
			deletedAt: new Date().toISOString()
		};
		await persistGuideEvent(session, request.id, "guide.deleted", data);
		bumpWorkbenchRevision(session);
		emitWorkbenchUpdated(socket, request.id, session);
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				guideDeleted: true,
				found: deletedGuide !== undefined,
				guideId: request.params.guideId,
				pendingGuides: session.pendingGuides.map(serializePendingGuide),
				workbench: serializeWorkbench(session)
			}
		});
		break;
	}

		default:
			throw new Error(`Unsupported guide method: ${request.method}`);
	}
}
