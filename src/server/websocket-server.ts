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
	beginRequestExecution,
	finishRequestExecution,
	parseMessage
} from "./request-lifecycle.js";
import { waitForFullSessionLoad } from "./session-preview.js";
import {
	waitForSessionEventPersistence
} from "./session-events.js";
import { registerClientConnection, unregisterClientConnection } from "./client-connections.js";
import { withMcpRequestContext } from "../mcp/request-context.js";
import { logger } from "../logger.js";

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

function parseClientRequest(socket: WebSocket, data: WebSocket.RawData, isBinary: boolean): ClientRequest | null {
	let parsedMessage: unknown;

	try {
		parsedMessage = parseMessage(data, isBinary);
	} catch (error: unknown) {
		logger.warn("rpc", "parse_failed", {
			code: "parse_error",
			message: error instanceof Error ? error.message : "Invalid message",
			isBinary
		});
		sendProtocolError(socket, "parse_error", error instanceof Error ? error.message : "Invalid message");
		return null;
	}

	const validationResult = clientRequestSchema.safeParse(parsedMessage);
	if (!validationResult.success) {
		logger.warn("rpc", "invalid_request", {
			code: "invalid_request",
			issues: validationResult.error.issues
		});
		sendProtocolError(socket, "invalid_request", validationResult.error.message);
		return null;
	}

	return validationResult.data;
}

function sendUnhandledRequestError(socket: WebSocket, request: ClientRequest, error: unknown): void {
	logger.error("rpc", "unhandled_request_error", error, {
		requestId: request.id,
		method: request.method
	});
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
		logger.error("session", "disconnect_save_failed", error, {
			sessionId: session.sessionId
		});
	});
}

function handleSocketError(error: Error): void {
	logger.error("websocket", "socket_error", error);
}

function handleServerHeaders(headers: string[]): void {
	headers.push("X-Godot-Daedalus: websocket");
}

function handleServerListening(port: number): void {
	logger.info("websocket", "listening", {
		port
	}, `WebSocket server listening on ws://localhost:${port}`);
}

function handleServerError(error: Error): void {
	logger.error("websocket", "server_error", error);
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
		logger.debug("rpc", "duplicate_request_ignored", {
			requestId: requestData.id,
			method: requestData.method,
			sessionId: session.sessionId,
			workspaceId: session.activeWorkspace?.id
		});
		return;
	}

	const startedAtMs: number = Date.now();
	logger.debug("rpc", "request_started", {
		requestId: requestData.id,
		method: requestData.method,
		sessionId: session.sessionId,
		workspaceId: session.activeWorkspace?.id,
		editorInstanceId: session.editorInstanceId,
		clientType: session.clientType
	});
	let failed: boolean = false;
	withMcpRequestContext({
		workspaceId: session.activeWorkspace?.id,
		editorInstanceId: session.editorInstanceId
	}, async (): Promise<void> => {
		await dispatchRequest(socket, requestData, session, mcpHost);
	}).catch((error: unknown): void => {
		failed = true;
		sendUnhandledRequestError(socket, requestData, error);
	}).finally((): void => {
		logger.info("rpc", "request_finished", {
			requestId: requestData.id,
			method: requestData.method,
			sessionId: session.sessionId,
			workspaceId: session.activeWorkspace?.id,
			editorInstanceId: session.editorInstanceId,
			clientType: session.clientType,
			durationMs: Date.now() - startedAtMs,
			failed
		});
		finishRequestExecution(requestData, session);
	});
}

function handleSocketClose(socket: WebSocket, session: ClientSession, mcpHost: McpHost, remoteAddress: string): void {
	detachEditorBridgeSocket(socket, mcpHost);
	unregisterClientConnection(socket);
	abortActiveRequests(session);
	scheduleSessionSaveOnDisconnect(session);
	logger.info("websocket", "client_disconnected", {
		remoteAddress,
		sessionId: session.sessionId,
		workspaceId: session.activeWorkspace?.id,
		clientType: session.clientType
	});
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
	logger.info("websocket", "client_connected", {
		remoteAddress
	});

	registerClientConnection(socket, session);
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
