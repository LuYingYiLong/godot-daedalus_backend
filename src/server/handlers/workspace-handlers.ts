import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { findWorkspace, loadWorkspaces } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";

export async function handleWorkspaceRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "workspace.list":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				workspaces: loadWorkspaces(),
				active: session.activeWorkspace?.id ?? mcpHost.getActiveWorkspaceId() ?? null,
				connected: mcpHost.getConnectedWorkspaceIds()
			}
		});
		break;

	case "workspace.select": {
		const workspace: WorkspaceConfig | undefined = findWorkspace(request.params.workspaceId);

		if (!workspace) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_not_found",
					message: `Workspace not found: ${request.params.workspaceId}`
				}
			});
			break;
		}

		try {
			await mcpHost.switchWorkspace(workspace);
		} catch (error: unknown) {
			console.error("Failed to switch MCP workspace:", error);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "workspace_switch_failed",
					message: error instanceof Error ? error.message : "Failed to switch MCP workspace"
				}
			});
			break;
		}

		session.activeWorkspace = workspace;
		session.godotProjectPath = workspace.rootPath;

		if (workspace.godotExecutablePath) {
			session.godotExecutablePath = workspace.godotExecutablePath;
		}

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				selected: true,
				workspace: {
					id: workspace.id,
					name: workspace.name,
					kind: workspace.kind,
					rootPath: workspace.rootPath
				}
			}
		});
		break;
	}

	case "workspace.info":
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: session.activeWorkspace ?? null
		});
		break;
		default:
			throw new Error(`Unsupported workspace method: ${request.method}`);
	}
}
