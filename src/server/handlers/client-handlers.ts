import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import {
	getClientConnection,
	updateClientConnection,
	type ClientCapabilities,
	type ClientType
} from "../client-connections.js";
import { logger } from "../../logger.js";

function readClientType(value: unknown): ClientType {
	return value === "godot_plugin" || value === "studio" || value === "cli" || value === "smoke"
		? value
		: "legacy";
}

function readCapabilities(value: unknown): ClientCapabilities {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}

	const result: ClientCapabilities = {};
	const record: Record<string, unknown> = value as Record<string, unknown>;
	for (const [key, item] of Object.entries(record)) {
		if (typeof item === "boolean") {
			result[key as keyof ClientCapabilities] = item;
		}
	}
	return result;
}

export async function handleClientRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, _mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "client.hello": {
			const params = request.params!;
			const info = updateClientConnection(socket, {
				clientType: readClientType(params.clientType),
				clientName: params.clientName ?? (params.clientType === "studio" ? "Daedalus Studio" : "Godot Daedalus"),
				workspaceId: params.workspaceId,
				workspaceRoot: params.workspaceRoot,
				editorInstanceId: params.editorInstanceId,
				capabilities: readCapabilities(params.capabilities)
			});
			logger.info("client", "hello", {
				connectionId: info.connectionId,
				clientType: info.clientType,
				clientName: info.clientName,
				workspaceId: info.workspaceId,
				workspaceRoot: info.workspaceRoot,
				editorInstanceId: info.editorInstanceId,
				capabilities: info.capabilities,
				sessionId: session.sessionId
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					connection: info,
				multiClient: {
					enabled: true,
					protocolVersion: 2
					}
				}
			});
			break;
		}

		case "client.info":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					connection: getClientConnection(socket),
					session: {
						sessionId: session.sessionId ?? null,
						workspaceId: session.activeWorkspace?.id ?? null,
						editorInstanceId: session.editorInstanceId ?? null
					}
				}
			});
			break;

		default:
			throw new Error(`Unsupported client method: ${request.method}`);
	}
}
