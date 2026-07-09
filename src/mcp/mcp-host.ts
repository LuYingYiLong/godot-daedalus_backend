import { buildMcpServerConfigs } from "./mcp-config.js";
import { buildCustomMcpServerConfigs } from "./custom-mcp-config-store.js";
import { GODOT_DIAGNOSTICS_SERVER_ID, GodotDiagnosticsBridge } from "./godot/bridges/diagnostics-bridge.js";
import { GODOT_EDITOR_SERVER_ID, GodotEditorBridge } from "./godot/bridges/editor-bridge.js";
import { McpSession } from "./mcp-session.js";
import type { McpServerConfig } from "./types.js";
import { findWorkspace, getDefaultWorkspace } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { clearDynamicMcpToolsForWorkspace, replaceDynamicMcpTools, replaceDynamicMcpToolsForWorkspace, type DynamicMcpToolSource } from "../tools/dynamic-mcp-tools.js";
import { getCurrentMcpWorkspaceId } from "./request-context.js";
import { logger } from "../logger.js";

const CUSTOM_MCP_CONNECT_TIMEOUT_MS: number = 30_000;
const CUSTOM_MCP_LIST_TOOLS_TIMEOUT_MS: number = 10_000;
const CUSTOM_MCP_CLOSE_TIMEOUT_MS: number = 2_000;

type McpToolListResult = {
	tools: Array<{
		name: string;
		description?: string | undefined;
		inputSchema?: unknown;
	}>;
};

export type CustomMcpServerRuntimeStatus = {
	id: string;
	status: "connected" | "error";
	toolCount: number;
	error?: string | undefined;
};

function customStatusKey(workspaceId: string, serverId: string): string {
	return `${workspaceId}\u0000${serverId}`;
}

function customStatusServerId(key: string): string {
	const separatorIndex: number = key.indexOf("\u0000");
	return separatorIndex === -1 ? key : key.slice(separatorIndex + 1);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject): void => {
				timeout = setTimeout((): void => {
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			})
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
}

export class McpHost {
	private workspaceSessions: Map<string, Map<string, McpSession>> = new Map();
	private workspaceCustomTools: Map<string, Map<string, DynamicMcpToolSource[]>> = new Map();
	private customServerStatuses: Map<string, CustomMcpServerRuntimeStatus> = new Map();
	private activeWorkspaceId?: string | undefined;
	private readonly editorBridge: GodotEditorBridge = new GodotEditorBridge();
	private readonly diagnosticsBridge: GodotDiagnosticsBridge = new GodotDiagnosticsBridge();

	async connectAll(): Promise<void> {
		if (process.env.MCP_AUTO_CONNECT !== "1") {
			logger.info("mcp", "lazy_workspace_startup");
			return;
		}

		const workspace: WorkspaceConfig | undefined = getDefaultWorkspace();
		if (!workspace) {
			logger.warn("mcp", "default_workspace_missing");
			return;
		}

		await this.switchWorkspace(workspace);
	}

	async switchWorkspace(workspace: WorkspaceConfig): Promise<void> {
		await this.ensureWorkspace(workspace);
		this.activeWorkspaceId = workspace.id;
		this.diagnosticsBridge.setWorkspace(workspace);
		this.syncActiveDynamicTools();
		logger.info("mcp", "active_workspace_selected", {
			workspaceId: workspace.id,
			rootPath: workspace.rootPath
		});
	}

	async ensureWorkspace(workspace: WorkspaceConfig): Promise<void> {
		if (this.workspaceSessions.has(workspace.id)) {
			return;
		}

		const configs: McpServerConfig[] = [
			...buildMcpServerConfigs(workspace),
			...await buildCustomMcpServerConfigs(workspace)
		];
		if (configs.length === 0) {
			throw new Error(`MCP workspace has no project path: ${workspace.id}`);
		}

		const sessions: Map<string, McpSession> = new Map();

		try {
			for (const config of configs) {
				const session: McpSession = new McpSession(config);
				try {
					await this.connectSession(config, session);
					if (config.custom === true) {
						await this.cacheCustomServerTools(workspace.id, config, session);
					}
					sessions.set(config.id, session);
					logger.info("mcp", "session_connected", {
						workspaceId: workspace.id,
						serverId: config.id,
						serverName: config.name,
						custom: config.custom === true
					});
				} catch (error: unknown) {
					if (config.custom === true) {
						await this.closeCustomSessionQuietly(session);
						this.setCustomServerError(workspace.id, config.id, error);
						logger.warn("mcp", "custom_session_failed", {
							workspaceId: workspace.id,
							serverId: config.id,
							serverName: config.name,
							error: error instanceof Error ? error.message : error
						});
						continue;
					}

					await session.close().catch((): void => undefined);
					throw error;
				}
			}
		} catch (error: unknown) {
			for (const session of sessions.values()) {
				await session.close().catch((): void => undefined);
			}

			throw error;
		}

		this.workspaceSessions.set(workspace.id, sessions);
		this.syncDynamicToolsForWorkspace(workspace.id);
	}

	private async connectSession(config: McpServerConfig, session: McpSession): Promise<void> {
		if (config.custom === true) {
			await withTimeout(
				session.connect(),
				CUSTOM_MCP_CONNECT_TIMEOUT_MS,
				`Custom MCP "${config.name}" connect`
			);
			return;
		}

		await session.connect();
	}

	private async closeCustomSessionQuietly(session: McpSession): Promise<void> {
		await withTimeout(
			session.close(),
			CUSTOM_MCP_CLOSE_TIMEOUT_MS,
			`Custom MCP "${session.name}" close`
		).catch((): void => undefined);
	}

	private async cacheCustomServerTools(workspaceId: string, config: McpServerConfig, session: McpSession): Promise<void> {
		const toolsResult: McpToolListResult = await withTimeout(
			session.listTools(),
			CUSTOM_MCP_LIST_TOOLS_TIMEOUT_MS,
			`Custom MCP "${config.name}" listTools`
		) as McpToolListResult;
		const toolSources: DynamicMcpToolSource[] = toolsResult.tools.map((tool): DynamicMcpToolSource => ({
			serverId: config.id,
			serverName: config.name,
			toolName: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			planAccess: config.planAccess ?? "disabled"
		}));

		let workspaceTools: Map<string, DynamicMcpToolSource[]> | undefined = this.workspaceCustomTools.get(workspaceId);
		if (workspaceTools === undefined) {
			workspaceTools = new Map();
			this.workspaceCustomTools.set(workspaceId, workspaceTools);
		}
		workspaceTools.set(config.id, toolSources);
		this.customServerStatuses.set(customStatusKey(workspaceId, config.id), {
			id: config.id,
			status: "connected",
			toolCount: toolSources.length
		});
		logger.info("mcp", "custom_tools_cached", {
			workspaceId,
			serverId: config.id,
			serverName: config.name,
			toolCount: toolSources.length
		});
	}

	private setCustomServerError(workspaceId: string, serverId: string, error: unknown): void {
		this.customServerStatuses.set(customStatusKey(workspaceId, serverId), {
			id: serverId,
			status: "error",
			toolCount: 0,
			error: error instanceof Error ? error.message : "Custom MCP server failed"
		});
	}

	private syncDynamicToolsForWorkspace(workspaceId: string): void {
		const workspaceTools: Map<string, DynamicMcpToolSource[]> | undefined = this.workspaceCustomTools.get(workspaceId);
		replaceDynamicMcpToolsForWorkspace(workspaceId, workspaceTools === undefined ? [] : Array.from(workspaceTools.values()).flat());
	}

	private syncActiveDynamicTools(): void {
		const workspaceId: string | undefined = this.activeWorkspaceId;
		if (!workspaceId) {
			replaceDynamicMcpTools([]);
			return;
		}

		const workspaceTools: Map<string, DynamicMcpToolSource[]> | undefined = this.workspaceCustomTools.get(workspaceId);
		if (workspaceTools === undefined) {
			replaceDynamicMcpTools([]);
			return;
		}

		replaceDynamicMcpTools(Array.from(workspaceTools.values()).flat());
		this.syncDynamicToolsForWorkspace(workspaceId);
	}

	async refreshCustomServersForActiveWorkspace(): Promise<void> {
		const workspaceId: string | undefined = getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		if (workspaceId === undefined) {
			return;
		}

		await this.refreshCustomServersForWorkspace(workspaceId);
	}

	async refreshCustomServersForWorkspace(workspaceId: string): Promise<void> {
		const workspace: WorkspaceConfig | undefined = findWorkspace(workspaceId);
		if (workspace === undefined) {
			return;
		}

		await this.ensureWorkspace(workspace);
		const sessions: Map<string, McpSession> | undefined = this.workspaceSessions.get(workspace.id);
		if (sessions === undefined) {
			return;
		}

		for (const [serverId, session] of sessions.entries()) {
			if (!session.isCustom) {
				continue;
			}

			await this.closeCustomSessionQuietly(session);
			sessions.delete(serverId);
		}

		this.workspaceCustomTools.set(workspace.id, new Map());
		const customConfigs: McpServerConfig[] = await buildCustomMcpServerConfigs(workspace);
		const enabledCustomIds: Set<string> = new Set(customConfigs.map((config: McpServerConfig): string => config.id));
		const workspaceStatusPrefix: string = `${workspace.id}\u0000`;
		for (const statusKey of this.customServerStatuses.keys()) {
			if (!statusKey.startsWith(workspaceStatusPrefix)) {
				continue;
			}
			const serverId: string = customStatusServerId(statusKey);
			if (!enabledCustomIds.has(serverId)) {
				this.customServerStatuses.delete(statusKey);
			}
		}

		for (const config of customConfigs) {
			const session: McpSession = new McpSession(config);
			try {
				await this.connectSession(config, session);
				await this.cacheCustomServerTools(workspace.id, config, session);
				sessions.set(config.id, session);
				logger.info("mcp", "custom_session_connected", {
					workspaceId: workspace.id,
					serverId: config.id,
					serverName: config.name
				});
			} catch (error: unknown) {
				await this.closeCustomSessionQuietly(session);
				this.setCustomServerError(workspace.id, config.id, error);
				logger.warn("mcp", "custom_session_failed", {
					workspaceId: workspace.id,
					serverId: config.id,
					serverName: config.name,
					error: error instanceof Error ? error.message : error
				});
			}
		}

		this.syncDynamicToolsForWorkspace(workspace.id);
		if (this.activeWorkspaceId === workspace.id) {
			this.syncActiveDynamicTools();
		}
	}

	private getWorkspaceId(workspaceId?: string | undefined): string {
		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		if (resolvedWorkspaceId === undefined) {
			throw new Error("MCP workspace is not selected");
		}

		return resolvedWorkspaceId;
	}

	private selectDiagnosticsWorkspace(workspaceId?: string | undefined): WorkspaceConfig {
		const resolvedWorkspaceId: string = this.getWorkspaceId(workspaceId);
		const workspace: WorkspaceConfig | undefined = findWorkspace(resolvedWorkspaceId);
		if (workspace === undefined) {
			throw new Error(`MCP workspace is not registered: ${resolvedWorkspaceId}`);
		}

		this.diagnosticsBridge.setWorkspace(workspace);
		return workspace;
	}

	private getActiveSessions(workspaceId?: string | undefined): Map<string, McpSession> {
		const resolvedWorkspaceId: string = this.getWorkspaceId(workspaceId);
		const sessions: Map<string, McpSession> | undefined = this.workspaceSessions.get(resolvedWorkspaceId);
		if (!sessions) {
			throw new Error(`MCP workspace is not connected: ${resolvedWorkspaceId}`);
		}

		return sessions;
	}

	async closeWorkspace(workspaceId: string): Promise<void> {
		const sessions: Map<string, McpSession> | undefined = this.workspaceSessions.get(workspaceId);
		if (!sessions) {
			return;
		}

		for (const session of sessions.values()) {
			await session.close();
		}

		this.workspaceSessions.delete(workspaceId);
		this.workspaceCustomTools.delete(workspaceId);
		clearDynamicMcpToolsForWorkspace(workspaceId);

		if (this.activeWorkspaceId === workspaceId) {
			this.activeWorkspaceId = undefined;
			this.diagnosticsBridge.clearWorkspace(workspaceId);
			this.syncActiveDynamicTools();
		}
	}

	getActiveWorkspaceId(): string | undefined {
		return getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
	}

	getEditorBridge(): GodotEditorBridge {
		return this.editorBridge;
	}

	getDiagnosticsBridge(): GodotDiagnosticsBridge {
		return this.diagnosticsBridge;
	}

	getSession(id: string, workspaceId?: string | undefined): McpSession {
		const resolvedWorkspaceId: string = this.getWorkspaceId(workspaceId);
		const session: McpSession | undefined = this.getActiveSessions(resolvedWorkspaceId).get(id);

		if (!session) {
			throw new Error(`MCP session not found in workspace ${resolvedWorkspaceId}: ${id}`);
		}

		return session;
	}

	getConnectedServerIds(workspaceId?: string | undefined): string[] {
		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		if (!resolvedWorkspaceId) {
			return this.editorBridge.isOnline() ? [GODOT_EDITOR_SERVER_ID] : [];
		}

		const sessions: Map<string, McpSession> | undefined = this.workspaceSessions.get(resolvedWorkspaceId);
		if (!sessions) {
			return this.editorBridge.isOnline() ? [GODOT_EDITOR_SERVER_ID] : [];
		}

		const serverIds: string[] = Array.from(sessions.keys());
		serverIds.push(GODOT_DIAGNOSTICS_SERVER_ID);
		if (this.editorBridge.isOnline()) {
			serverIds.push(GODOT_EDITOR_SERVER_ID);
		}
		return serverIds.sort();
	}

	getConnectedWorkspaceIds(): string[] {
		return Array.from(this.workspaceSessions.keys()).sort();
	}

	getCustomServerStatuses(): CustomMcpServerRuntimeStatus[] {
		return this.getCustomServerStatusesForWorkspace(undefined);
	}

	getCustomServerStatusesForWorkspace(workspaceId?: string | undefined): CustomMcpServerRuntimeStatus[] {
		const resolvedWorkspaceId: string | undefined = workspaceId ?? getCurrentMcpWorkspaceId() ?? this.activeWorkspaceId;
		if (resolvedWorkspaceId === undefined) {
			return Array.from(this.customServerStatuses.values());
		}

		const workspaceStatusPrefix: string = `${resolvedWorkspaceId}\u0000`;
		return Array.from(this.customServerStatuses.entries())
			.filter(([key]: [string, CustomMcpServerRuntimeStatus]): boolean => key.startsWith(workspaceStatusPrefix))
			.map(([_key, status]: [string, CustomMcpServerRuntimeStatus]): CustomMcpServerRuntimeStatus => status);
	}

	async listTools(serverId: string, workspaceId?: string | undefined) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.listTools();
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			return this.diagnosticsBridge.listTools();
		}

		return this.getSession(serverId, workspaceId).listTools();
	}

	async callTool(serverId: string, name: string, args: Record<string, unknown>, workspaceId?: string | undefined) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.callTool(name, args);
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			this.selectDiagnosticsWorkspace(workspaceId);
			return this.diagnosticsBridge.callTool(name, args);
		}

		return this.getSession(serverId, workspaceId).callTool(name, args);
	}

	async listResources(serverId: string, workspaceId?: string | undefined) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.listResources();
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			this.selectDiagnosticsWorkspace(workspaceId);
			return this.diagnosticsBridge.listResources();
		}

		return this.getSession(serverId, workspaceId).listResources();
	}

	async readResource(serverId: string, uri: string, workspaceId?: string | undefined) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.readResource(uri);
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			this.selectDiagnosticsWorkspace(workspaceId);
			return this.diagnosticsBridge.readResource(uri);
		}

		return this.getSession(serverId, workspaceId).readResource(uri);
	}

	async closeAll(): Promise<void> {
		for (const sessions of this.workspaceSessions.values()) {
			for (const session of sessions.values()) {
				await session.close();
			}
		}

		this.workspaceSessions.clear();
		this.workspaceCustomTools.clear();
		this.customServerStatuses.clear();
		this.activeWorkspaceId = undefined;
		this.diagnosticsBridge.clearWorkspace();
		this.syncActiveDynamicTools();
	}
}
