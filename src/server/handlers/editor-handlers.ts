import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";

export async function handleEditorRequest(socket: WebSocket, request: ClientRequest, _session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "editor.context.update":
			mcpHost.getEditorBridge().attachSocket(socket);
			mcpHost.getEditorBridge().updateContext(request.params);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					updated: true,
					serverId: "godot_editor"
				}
			});
			break;

		case "editor.tool.result": {
			const accepted: boolean = mcpHost.getEditorBridge().handleToolResult(
				request.params.callId,
				request.params.ok,
				request.params.result,
				request.params.error
			);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					accepted,
					callId: request.params.callId
				}
			});
			break;
		}

		default:
			throw new Error(`Unsupported editor method: ${request.method}`);
	}
}
