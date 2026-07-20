import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { clearActiveSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { deleteWorkspace, findWorkspace, hydrateWorkspacesFromSessionMetadata, loadWorkspaces } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
import { updateClientConnection } from "../client-connections.js";
import { logger } from "../../logger.js";
import { deleteSessionsByWorkspace, listArchivedSessions, listSessions } from "../../session/session-store.js";
import { readWorkspaceGitDiff } from "../workspace-git-diff.js";

export async function handleWorkspaceRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "workspace.list":
		hydrateWorkspacesFromSessionMetadata([
			...await listSessions(),
			...await listArchivedSessions()
		]);
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
			await mcpHost.ensureWorkspace(workspace);
		} catch (error: unknown) {
			logger.error("workspace", "switch_failed", error, {
				requestedWorkspaceId: request.params.workspaceId,
				sessionId: session.sessionId
			});
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
		logger.info("workspace", "selected", {
			workspaceId: workspace.id,
			rootPath: workspace.rootPath,
			sessionId: session.sessionId
		});
		updateClientConnection(socket, {
			workspaceId: workspace.id,
			workspaceRoot: workspace.rootPath
		});

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

	case "workspace.delete": {
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

		const deletion = await deleteSessionsByWorkspace(workspace.id);
		deleteWorkspace(workspace.id);
		await mcpHost.closeWorkspace(workspace.id);

		if (session.sessionId !== undefined && deletion.deletedSessionIds.includes(session.sessionId)) {
			clearActiveSession(session);
		}
		if (session.activeWorkspace?.id === workspace.id) {
			session.activeWorkspace = undefined;
			session.godotProjectPath = undefined;
			session.godotExecutablePath = undefined;
			updateClientConnection(socket, {
				workspaceId: null,
				workspaceRoot: null
			});
		}

		logger.info("workspace", "deleted", {
			workspaceId: workspace.id,
			rootPath: workspace.rootPath,
			deletedSessions: deletion.deletedSessionIds.length,
			deletedArchivedSessions: deletion.deletedArchivedSessionIds.length
		});

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				deleted: true,
				workspaceId: workspace.id,
				deletedSessionIds: deletion.deletedSessionIds,
				deletedArchivedSessionIds: deletion.deletedArchivedSessionIds
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

	case "workspace.git.diff.get": {
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

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: await readWorkspaceGitDiff(workspace.id, workspace.rootPath)
		});
		break;
	}
	default:
		throw new Error(`Unsupported workspace method: ${request.method}`);
	}
}
