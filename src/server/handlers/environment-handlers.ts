import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { createRuntimeWorkspace, upsertRuntimeWorkspace } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";

export async function handleEnvironmentRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "environment.configure":
		if (request.params.godotExecutablePath !== undefined) {
			session.godotExecutablePath = request.params.godotExecutablePath;
		}

		if (request.params.godotProjectPath !== undefined) {
			session.godotProjectPath = request.params.godotProjectPath;
		}

		if (session.godotProjectPath) {
			const workspace: WorkspaceConfig = upsertRuntimeWorkspace(createRuntimeWorkspace(
				session.godotProjectPath,
				session.godotExecutablePath
			));

			try {
				await mcpHost.switchWorkspace(workspace);
				session.activeWorkspace = workspace;
				session.godotProjectPath = workspace.rootPath;
				session.godotExecutablePath = workspace.godotExecutablePath ?? session.godotExecutablePath;
			} catch (error: unknown) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "workspace_switch_failed",
						message: error instanceof Error ? error.message : "Failed to configure runtime workspace"
					}
				});
				break;
			}
		}

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				configured: true,
				godotExecutablePath: session.godotExecutablePath ?? null,
				godotProjectPath: session.godotProjectPath ?? null,
				workspace: session.activeWorkspace ?? null
			}
		});
		break;

		default:
			throw new Error(`Unsupported environment method: ${request.method}`);
	}
}
