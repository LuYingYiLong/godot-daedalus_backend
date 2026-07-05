import WebSocket, { WebSocketServer } from "ws";
import { clientRequestSchema } from "../protocol/schema.js";
import type { ClientRequest } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { getDefaultWorkspace } from "../workspace/registry.js";
import { saveSession } from "../session/session-store.js";
import { createClientSession, type ClientSession } from "./client-session.js";
import { dispatchRequest } from "./request-dispatcher.js";
import { sendJson } from "./send-json.js";
import {
	waitForFullSessionLoad,
	waitForSessionEventPersistence
} from "./websocket-support.js";

const REQUEST_DEDUP_TTL_MS: number = 5 * 60 * 1000;
const MAX_COMPLETED_REQUEST_IDS: number = 512;

function parseMessage(data: WebSocket.RawData, isBinary: boolean): unknown {
	if (isBinary) {
		throw new Error("Binary messages are not supported");
	}

	const text: string = typeof data === "string" ? data : data.toString("utf8");
	return JSON.parse(text) as unknown;
}

function sendProtocolError(socket: WebSocket, code: string, message: string, requestId: string = ""): void {
	sendJson(socket, {
		type: "response",
		id: requestId,
		ok: false,
		error: {
			code,
			message
		}
	});
}

function pruneCompletedRequestIds(session: ClientSession, now: number = Date.now()): void {
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

function sendDuplicateRequestResponse(
	socket: WebSocket,
	request: ClientRequest,
	state: "in_flight" | "completed"
): void {
	sendJson(socket, {
		type: "response",
		id: request.id,
		ok: true,
		result: {
			duplicate: true,
			ignored: true,
			state,
			method: request.method
		}
	});
}

function beginRequestExecution(socket: WebSocket, request: ClientRequest, session: ClientSession): boolean {
	if (request.id.length === 0) {
		return true;
	}

	pruneCompletedRequestIds(session);
	if (session.inFlightRequestIds.has(request.id)) {
		sendDuplicateRequestResponse(socket, request, "in_flight");
		return false;
	}

	if (session.completedRequestIds.has(request.id)) {
		sendDuplicateRequestResponse(socket, request, "completed");
		return false;
	}

	session.inFlightRequestIds.add(request.id);
	return true;
}

function finishRequestExecution(request: ClientRequest, session: ClientSession): void {
	if (request.id.length === 0) {
		return;
	}

	session.inFlightRequestIds.delete(request.id);
	session.completedRequestIds.set(request.id, Date.now());
	pruneCompletedRequestIds(session);
}

function parseClientRequest(socket: WebSocket, data: WebSocket.RawData, isBinary: boolean): ClientRequest | null {
	let parsedMessage: unknown;

	try {
		parsedMessage = parseMessage(data, isBinary);
	} catch (error: unknown) {
		sendProtocolError(socket, "parse_error", error instanceof Error ? error.message : "Invalid message");
		return null;
	}

	const validationResult = clientRequestSchema.safeParse(parsedMessage);
	if (!validationResult.success) {
		sendProtocolError(socket, "invalid_request", validationResult.error.message);
		return null;
	}

	return validationResult.data;
}

function sendUnhandledRequestError(socket: WebSocket, request: ClientRequest, error: unknown): void {
	console.error("Unhandled request error:", error);
	sendProtocolError(
		socket,
		"internal_error",
		error instanceof Error ? error.message : "Unhandled request error",
		request.id
	);
}

function getRemoteAddress(request: Parameters<WebSocketServer["emit"]>[1]): string {
	return request?.socket?.remoteAddress ?? "unknown";
}

function createSessionForConnection(): ClientSession {
	return createClientSession(getDefaultWorkspace());
}

function attachEditorBridgeSocket(socket: WebSocket, mcpHost: McpHost): void {
	mcpHost.getEditorBridge().attachSocket(socket);
}

function detachEditorBridgeSocket(socket: WebSocket, mcpHost: McpHost): void {
	mcpHost.getEditorBridge().detachSocket(socket);
}

function abortActiveRequests(session: ClientSession): void {
	for (const controller of session.activeAbortControllers.values()) {
		controller.abort();
	}
	session.activeAbortControllers.clear();
}

function shouldAutoSaveSession(session: ClientSession): boolean {
	return session.sessionId !== undefined && session.messages.length > 0;
}

async function saveSessionOnDisconnect(session: ClientSession): Promise<void> {
	await waitForFullSessionLoad(session);
	await waitForSessionEventPersistence(session);
	const sessionId: string | undefined = session.sessionId;
	if (sessionId === undefined || !shouldAutoSaveSession(session)) {
		return;
	}

	await saveSession(sessionId, session.messages, {
		workspaceId: session.activeWorkspace?.id,
		activeSkillId: session.activeSkillId
	});
}

function scheduleSessionSaveOnDisconnect(session: ClientSession): void {
	void saveSessionOnDisconnect(session).catch((error: unknown): void => {
		console.error("Failed to auto-save session on disconnect:", error);
	});
}

function handleSocketError(error: Error): void {
	console.error("WebSocket error:", error);
}

function handleServerHeaders(headers: string[]): void {
	headers.push("X-Godot-Daedalus: websocket");
}

function handleServerListening(port: number): void {
	console.log(`WebSocket server listening on ws://localhost:${port}`);
}

function handleServerError(error: Error): void {
	console.error("WebSocket server error:", error);
}

function handleSocketMessage(
	socket: WebSocket,
	data: WebSocket.RawData,
	isBinary: boolean,
	session: ClientSession,
	mcpHost: McpHost
): void {
	const requestData: ClientRequest | null = parseClientRequest(socket, data, isBinary);
	if (requestData === null) {
		return;
	}
	if (!beginRequestExecution(socket, requestData, session)) {
		return;
	}

	dispatchRequest(socket, requestData, session, mcpHost).catch((error: unknown): void => {
		sendUnhandledRequestError(socket, requestData, error);
	}).finally((): void => {
		finishRequestExecution(requestData, session);
	});
}

function handleSocketClose(socket: WebSocket, session: ClientSession, mcpHost: McpHost, remoteAddress: string): void {
	detachEditorBridgeSocket(socket, mcpHost);
	abortActiveRequests(session);
	scheduleSessionSaveOnDisconnect(session);
	console.log(`Client disconnected: ${remoteAddress}`);
}

function attachSocketHandlers(socket: WebSocket, session: ClientSession, mcpHost: McpHost, remoteAddress: string): void {
	socket.on("error", handleSocketError);
	socket.on("message", (data: WebSocket.RawData, isBinary: boolean): void => {
		handleSocketMessage(socket, data, isBinary, session, mcpHost);
	});
	socket.on("close", (): void => {
		handleSocketClose(socket, session, mcpHost, remoteAddress);
	});
}

function handleConnection(socket: WebSocket, request: Parameters<WebSocketServer["emit"]>[1], mcpHost: McpHost): void {
	const session: ClientSession = createSessionForConnection();
	const remoteAddress: string = getRemoteAddress(request);
	console.log(`Client connected: ${remoteAddress}`);

	attachEditorBridgeSocket(socket, mcpHost);
	attachSocketHandlers(socket, session, mcpHost, remoteAddress);
}

export function createServer(port: number, mcpHost: McpHost): WebSocketServer {
	const server: WebSocketServer = new WebSocketServer({ port });

	server.on("headers", handleServerHeaders);
	server.on("connection", (socket: WebSocket, request): void => {
		handleConnection(socket, request, mcpHost);
	});
	server.on("listening", (): void => {
		handleServerListening(port);
	});
	server.on("error", handleServerError);

	return server;
}
