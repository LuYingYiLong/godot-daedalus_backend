import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost, CustomMcpServerRuntimeStatus } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import {
	addCustomMcpServerConfig,
	listCustomMcpServerSummaries,
	removeCustomMcpServerConfig,
	setCustomMcpServerEnabled,
	type CustomMcpServerSummary
} from "../../mcp/custom-mcp-config-store.js";
import { createProviderStatusEvent } from "../../providers/provider-error.js";

function canCallMcpToolDirectly(toolName: string): boolean {
	const allowedTools: Set<string> = new Set([
		"get_project_summary",
		"list_project_files",
		"list_scenes",
		"list_scripts",
		"read_text_file",
		"search_text",
		"propose_create_text_file",
		"get_context",
		"get_selected_nodes",
		"inspect_node"
	]);

	return allowedTools.has(toolName);
}

async function createMcpConfigListResult(mcpHost: McpHost): Promise<Record<string, unknown>> {
	const summaries: CustomMcpServerSummary[] = await listCustomMcpServerSummaries();
	const statusesById: Map<string, CustomMcpServerRuntimeStatus> = new Map(
		mcpHost.getCustomServerStatuses().map((status: CustomMcpServerRuntimeStatus): [string, CustomMcpServerRuntimeStatus] => [status.id, status])
	);
	const servers: Record<string, unknown>[] = summaries.map((summary: CustomMcpServerSummary): Record<string, unknown> => {
		const runtimeStatus: CustomMcpServerRuntimeStatus | undefined = statusesById.get(summary.id);
		const status: string = summary.enabled ? runtimeStatus?.status ?? "connecting" : "disabled";
		return {
			...summary,
			status,
			toolCount: summary.enabled ? runtimeStatus?.toolCount ?? 0 : 0,
			error: summary.enabled ? runtimeStatus?.error ?? null : null
		};
	});

	return {
		customMcpServers: servers,
		mcpServers: servers,
		connectedServerIds: mcpHost.getConnectedServerIds()
	};
}

function refreshCustomMcpServersAndNotify(socket: WebSocket, mcpHost: McpHost): void {
	void (async (): Promise<void> => {
		try {
			await mcpHost.refreshCustomServersForActiveWorkspace();
			sendJson(socket, {
				type: "event",
				id: "mcp-config",
				event: "mcp.config.updated",
				data: await createMcpConfigListResult(mcpHost)
			});
		} catch (error: unknown) {
			console.warn("Failed to refresh custom MCP servers:", error instanceof Error ? error.message : error);
			sendJson(socket, {
				type: "event",
				id: "mcp-config",
				event: "mcp.config.updated",
				data: {
					...await createMcpConfigListResult(mcpHost),
					error: error instanceof Error ? error.message : "Failed to refresh custom MCP servers"
				}
			});
		}
	})();
}


export async function handleMcpRequest(socket: WebSocket, request: ClientRequest, _session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "mcp.listTools": {
		const serverId: string = request.params?.serverId ?? "godot";

		try {
			const result = await mcpHost.listTools(serverId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_error",
					message: error instanceof Error ? error.message : "MCP call failed"
				}
			});
		}
		break;
	}

	case "mcp.callTool": {
		const serverId: string = request.params.serverId ?? "godot";

		try {
			if (!canCallMcpToolDirectly(request.params.name)) {
				sendJson(socket, {
					type: "response",
					id: request.id,
					ok: false,
					error: {
						code: "approval_required",
						message: `Direct MCP call is not allowed for tool: ${request.params.name}`
					}
				});
				break;
			}

			const result = await mcpHost.callTool(serverId, request.params.name, request.params.args ?? {});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_error",
					message: error instanceof Error ? error.message : "MCP call failed"
				}
			});
		}
		break;
	}

	case "mcp.listResources": {
		const serverId: string = request.params?.serverId ?? "godot";

		try {
			const result = await mcpHost.listResources(serverId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_error",
					message: error instanceof Error ? error.message : "MCP call failed"
				}
			});
		}
		break;
	}

	case "mcp.readResource": {
		const serverId: string = request.params.serverId ?? "godot";

		try {
			const result = await mcpHost.readResource(serverId, request.params.uri);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_error",
					message: error instanceof Error ? error.message : "MCP call failed"
				}
			});
		}
		break;
	}

	case "mcp.config.list": {
		try {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await createMcpConfigListResult(mcpHost)
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_config_error",
					message: error instanceof Error ? error.message : "Failed to list custom MCP servers"
				}
			});
		}
		break;
	}

	case "mcp.config.add": {
		try {
			await addCustomMcpServerConfig(request.params);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					added: true,
					...await createMcpConfigListResult(mcpHost)
				}
			});
			refreshCustomMcpServersAndNotify(socket, mcpHost);
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_config_error",
					message: error instanceof Error ? error.message : "Failed to add custom MCP server"
				}
			});
		}
		break;
	}

	case "mcp.config.remove": {
		try {
			const removed: boolean = await removeCustomMcpServerConfig(request.params.serverId);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					removed,
					serverId: request.params.serverId,
					...await createMcpConfigListResult(mcpHost)
				}
			});
			refreshCustomMcpServersAndNotify(socket, mcpHost);
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_config_error",
					message: error instanceof Error ? error.message : "Failed to remove custom MCP server"
				}
			});
		}
		break;
	}

	case "mcp.config.setEnabled": {
		try {
			const updated: boolean = await setCustomMcpServerEnabled(request.params.serverId, request.params.enabled);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					updated,
					serverId: request.params.serverId,
					enabled: request.params.enabled,
					...await createMcpConfigListResult(mcpHost)
				}
			});
			refreshCustomMcpServersAndNotify(socket, mcpHost);
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "mcp_config_error",
					message: error instanceof Error ? error.message : "Failed to update custom MCP server"
				}
			});
		}
		break;
	}

		default:
			throw new Error(`Unsupported mcp method: ${request.method}`);
	}
}
