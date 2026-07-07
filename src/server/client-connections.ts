import WebSocket from "ws";
import type { ServerEvent } from "../protocol/types.js";
import type { ClientSession } from "./client-session.js";
import { sendJson } from "./send-json.js";

export type ClientType = "godot_plugin" | "studio" | "cli" | "smoke" | "legacy";

export type ClientCapabilities = Partial<Record<
	"editorTools" | "editorUndoRedo" | "inlineDiffUndo" | "inlineDiffView" | "sessionSubscribe" | "approval",
	boolean
>>;

export type ClientConnectionInfo = {
	connectionId: string;
	clientType: ClientType;
	clientName: string;
	connectedAt: string;
	workspaceId?: string | undefined;
	workspaceRoot?: string | undefined;
	editorInstanceId?: string | undefined;
	capabilities: ClientCapabilities;
};

type ConnectionRecord = ClientConnectionInfo & {
	socket: WebSocket;
	session: ClientSession;
	subscribedSessionIds: Set<string>;
};

const socketConnections: Map<WebSocket, ConnectionRecord> = new Map();
const sessionSubscribers: Map<string, Set<WebSocket>> = new Map();
const activeSessionRuns: Map<string, string> = new Map();

function createConnectionId(): string {
	return `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toPublicInfo(record: ConnectionRecord): ClientConnectionInfo {
	return {
		connectionId: record.connectionId,
		clientType: record.clientType,
		clientName: record.clientName,
		connectedAt: record.connectedAt,
		workspaceId: record.workspaceId,
		workspaceRoot: record.workspaceRoot,
		editorInstanceId: record.editorInstanceId,
		capabilities: { ...record.capabilities }
	};
}

export function registerClientConnection(socket: WebSocket, session: ClientSession): ClientConnectionInfo {
	const existing: ConnectionRecord | undefined = socketConnections.get(socket);
	if (existing !== undefined) {
		return toPublicInfo(existing);
	}

	const record: ConnectionRecord = {
		socket,
		session,
		connectionId: createConnectionId(),
		clientType: "legacy",
		clientName: "Legacy Client",
		connectedAt: new Date().toISOString(),
		capabilities: {},
		subscribedSessionIds: new Set()
	};
	socketConnections.set(socket, record);
	session.connectionId = record.connectionId;
	session.clientType = record.clientType;
	session.clientCapabilities = record.capabilities;
	return toPublicInfo(record);
}

export function unregisterClientConnection(socket: WebSocket): ClientConnectionInfo | null {
	const record: ConnectionRecord | undefined = socketConnections.get(socket);
	if (record === undefined) {
		return null;
	}

	for (const sessionId of record.subscribedSessionIds) {
		const subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
		subscribers?.delete(socket);
		if (subscribers !== undefined && subscribers.size === 0) {
			sessionSubscribers.delete(sessionId);
		}
	}
	socketConnections.delete(socket);
	return toPublicInfo(record);
}

export function updateClientConnection(socket: WebSocket, update: {
	clientType?: ClientType | undefined;
	clientName?: string | undefined;
	workspaceId?: string | undefined;
	workspaceRoot?: string | undefined;
	editorInstanceId?: string | undefined;
	capabilities?: ClientCapabilities | undefined;
}): ClientConnectionInfo {
	const record: ConnectionRecord | undefined = socketConnections.get(socket);
	if (record === undefined) {
		throw new Error("Client connection is not registered");
	}

	record.clientType = update.clientType ?? record.clientType;
	record.clientName = update.clientName ?? record.clientName;
	record.workspaceId = update.workspaceId ?? record.workspaceId;
	record.workspaceRoot = update.workspaceRoot ?? record.workspaceRoot;
	record.editorInstanceId = update.editorInstanceId ?? record.editorInstanceId;
	record.capabilities = update.capabilities ?? record.capabilities;
	record.session.connectionId = record.connectionId;
	record.session.clientType = record.clientType;
	record.session.clientCapabilities = record.capabilities;
	record.session.editorInstanceId = record.editorInstanceId ?? record.session.editorInstanceId;
	return toPublicInfo(record);
}

export function getClientConnection(socket: WebSocket): ClientConnectionInfo | null {
	const record: ConnectionRecord | undefined = socketConnections.get(socket);
	return record === undefined ? null : toPublicInfo(record);
}

export function subscribeSocketToSession(socket: WebSocket, sessionId: string): void {
	const record: ConnectionRecord | undefined = socketConnections.get(socket);
	if (record === undefined) {
		return;
	}

	let subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
	if (subscribers === undefined) {
		subscribers = new Set();
		sessionSubscribers.set(sessionId, subscribers);
	}
	subscribers.add(socket);
	record.subscribedSessionIds.add(sessionId);
}

export function unsubscribeSocketFromSession(socket: WebSocket, sessionId: string): void {
	const record: ConnectionRecord | undefined = socketConnections.get(socket);
	record?.subscribedSessionIds.delete(sessionId);
	const subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
	subscribers?.delete(socket);
	if (subscribers !== undefined && subscribers.size === 0) {
		sessionSubscribers.delete(sessionId);
	}
}

export function getSessionSubscriberInfos(sessionId: string): ClientConnectionInfo[] {
	const subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
	if (subscribers === undefined) {
		return [];
	}

	return Array.from(subscribers)
		.map((socket: WebSocket): ConnectionRecord | undefined => socketConnections.get(socket))
		.filter((record: ConnectionRecord | undefined): record is ConnectionRecord => record !== undefined)
		.map(toPublicInfo);
}

export function broadcastSessionEvent(
	originSocket: WebSocket,
	sessionId: string,
	requestId: string,
	eventName: ServerEvent["event"],
	data: unknown
): void {
	const subscribers: Set<WebSocket> | undefined = sessionSubscribers.get(sessionId);
	if (subscribers === undefined) {
		return;
	}

	for (const socket of subscribers) {
		if (socket === originSocket || socket.readyState !== WebSocket.OPEN) {
			continue;
		}
		sendJson(socket, {
			type: "event",
			id: requestId,
			event: eventName,
			data
		});
	}
}

export function findSessionWithPendingApproval(approvalId: string): ClientSession | undefined {
	for (const record of socketConnections.values()) {
		if (record.session.approvalGateway.getPending(approvalId) !== undefined) {
			return record.session;
		}
	}

	return undefined;
}

export function beginSessionRun(sessionId: string | undefined, requestId: string): { ok: true } | { ok: false; activeRequestId: string } {
	if (sessionId === undefined) {
		return { ok: true };
	}

	const activeRequestId: string | undefined = activeSessionRuns.get(sessionId);
	if (activeRequestId !== undefined) {
		return { ok: false, activeRequestId };
	}

	activeSessionRuns.set(sessionId, requestId);
	return { ok: true };
}

export function finishSessionRun(sessionId: string | undefined, requestId: string): void {
	if (sessionId === undefined) {
		return;
	}

	if (activeSessionRuns.get(sessionId) === requestId) {
		activeSessionRuns.delete(sessionId);
	}
}
