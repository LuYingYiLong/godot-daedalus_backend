import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { getClientConnection, updateClientConnection } from "../client-connections.js";

export async function handleEditorRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
		case "editor.context.update": {
			const connection = getClientConnection(socket);
			const editorInstanceId: string = typeof request.params.editorInstanceId === "string" && request.params.editorInstanceId.length > 0
				? request.params.editorInstanceId
				: session.editorInstanceId ?? connection?.editorInstanceId ?? `editor-${connection?.connectionId ?? "legacy"}`;
			const workspaceId: string | undefined = session.activeWorkspace?.id ?? connection?.workspaceId;
			session.editorInstanceId = editorInstanceId;
			const instance = mcpHost.getEditorBridge().updateInstanceContext(
				socket,
				workspaceId,
				editorInstanceId,
				request.params,
				connection?.clientName
			);
			updateClientConnection(socket, {
				clientType: connection?.clientType === "legacy" ? "godot_plugin" : connection?.clientType,
				editorInstanceId,
				workspaceId,
				capabilities: {
					...connection?.capabilities,
					editorTools: true
				}
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					updated: true,
					serverId: "godot_editor",
					editorInstance: instance
				}
			});
			break;
		}

		case "editor.instances.list":
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					instances: mcpHost.getEditorBridge().listInstances(request.params?.workspaceId ?? session.activeWorkspace?.id)
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
