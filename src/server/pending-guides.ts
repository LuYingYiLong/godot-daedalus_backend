import type WebSocket from "ws";
import { appendSessionEvent, type StoredSessionEvent } from "../session/session-store.js";
import type { ClientSession, PendingGuide } from "./client-session.js";
import { clipTextByChars } from "./additional-context.js";
import { fingerprintText } from "./prompt-trace.js";
import {
	sendSessionEvent,
	waitForSessionEventPersistence
} from "./session-events.js";

const MAX_GUIDE_TEXT_CHARS: number = 4000;

export function createGuideId(): string {
	return `guide-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

export { MAX_GUIDE_TEXT_CHARS };
