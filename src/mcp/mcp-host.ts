import { buildMcpServerConfigs } from "./mcp-config.js";
import { buildCustomMcpServerConfigs } from "./custom-mcp-config-store.js";
import { GODOT_DIAGNOSTICS_SERVER_ID, GodotDiagnosticsBridge } from "./godot-diagnostics-bridge.js";
import { GODOT_EDITOR_SERVER_ID, GodotEditorBridge } from "./godot-editor-bridge.js";
import { McpSession } from "./mcp-session.js";
import type { McpServerConfig } from "./types.js";
import { findWorkspace, getDefaultWorkspace } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";
import { replaceDynamicMcpTools, type DynamicMcpToolSource } from "../tools/llm-tools.js";

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
			console.log("MCP host is using lazy workspace startup");
			return;
		}

		const workspace: WorkspaceConfig | undefined = getDefaultWorkspace();
		if (!workspace) {
			console.log("MCP host has no default workspace to connect");
			return;
		}

		await this.switchWorkspace(workspace);
	}

	async switchWorkspace(workspace: WorkspaceConfig): Promise<void> {
		await this.ensureWorkspace(workspace);
		this.activeWorkspaceId = workspace.id;
		this.diagnosticsBridge.setWorkspace(workspace);
		this.syncActiveDynamicTools();
		console.log(`MCP active workspace: ${workspace.id} -> ${workspace.rootPath}`);
	}

	private async ensureWorkspace(workspace: WorkspaceConfig): Promise<void> {
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
					console.log(`MCP session connected: ${workspace.id}/${config.id}`);
				} catch (error: unknown) {
					if (config.custom === true) {
						await this.closeCustomSessionQuietly(session);
						this.setCustomServerError(config.id, error);
						console.warn(`Custom MCP session failed: ${workspace.id}/${config.id}:`, error instanceof Error ? error.message : error);
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
			inputSchema: tool.inputSchema
		}));

		let workspaceTools: Map<string, DynamicMcpToolSource[]> | undefined = this.workspaceCustomTools.get(workspaceId);
		if (workspaceTools === undefined) {
			workspaceTools = new Map();
			this.workspaceCustomTools.set(workspaceId, workspaceTools);
		}
		workspaceTools.set(config.id, toolSources);
		this.customServerStatuses.set(config.id, {
			id: config.id,
			status: "connected",
			toolCount: toolSources.length
		});
	}

	private setCustomServerError(serverId: string, error: unknown): void {
		this.customServerStatuses.set(serverId, {
			id: serverId,
			status: "error",
			toolCount: 0,
			error: error instanceof Error ? error.message : "Custom MCP server failed"
		});
	}

	private syncActiveDynamicTools(): void {
		if (!this.activeWorkspaceId) {
			replaceDynamicMcpTools([]);
			return;
		}

		const workspaceTools: Map<string, DynamicMcpToolSource[]> | undefined = this.workspaceCustomTools.get(this.activeWorkspaceId);
		if (workspaceTools === undefined) {
			replaceDynamicMcpTools([]);
			return;
		}

		replaceDynamicMcpTools(Array.from(workspaceTools.values()).flat());
	}

	async refreshCustomServersForActiveWorkspace(): Promise<void> {
		if (!this.activeWorkspaceId) {
			return;
		}

		const workspace: WorkspaceConfig | undefined = findWorkspace(this.activeWorkspaceId);
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
		for (const serverId of this.customServerStatuses.keys()) {
			if (!enabledCustomIds.has(serverId)) {
				this.customServerStatuses.delete(serverId);
			}
		}

		for (const config of customConfigs) {
			const session: McpSession = new McpSession(config);
			try {
				await this.connectSession(config, session);
				await this.cacheCustomServerTools(workspace.id, config, session);
				sessions.set(config.id, session);
				console.log(`Custom MCP session connected: ${workspace.id}/${config.id}`);
			} catch (error: unknown) {
				await this.closeCustomSessionQuietly(session);
				this.setCustomServerError(config.id, error);
				console.warn(`Custom MCP session failed: ${workspace.id}/${config.id}:`, error instanceof Error ? error.message : error);
			}
		}

		this.syncActiveDynamicTools();
	}

	private getActiveSessions(): Map<string, McpSession> {
		if (!this.activeWorkspaceId) {
			throw new Error("MCP workspace is not selected");
		}

		const sessions: Map<string, McpSession> | undefined = this.workspaceSessions.get(this.activeWorkspaceId);
		if (!sessions) {
			throw new Error(`MCP workspace is not connected: ${this.activeWorkspaceId}`);
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

		if (this.activeWorkspaceId === workspaceId) {
			this.activeWorkspaceId = undefined;
			this.diagnosticsBridge.clearWorkspace(workspaceId);
			this.syncActiveDynamicTools();
		}
	}

	getActiveWorkspaceId(): string | undefined {
		return this.activeWorkspaceId;
	}

	getEditorBridge(): GodotEditorBridge {
		return this.editorBridge;
	}

	getDiagnosticsBridge(): GodotDiagnosticsBridge {
		return this.diagnosticsBridge;
	}

	getSession(id: string): McpSession {
		const session: McpSession | undefined = this.getActiveSessions().get(id);

		if (!session) {
			throw new Error(`MCP session not found in active workspace: ${id}`);
		}

		return session;
	}

	getConnectedServerIds(): string[] {
		if (!this.activeWorkspaceId) {
			return this.editorBridge.isOnline() ? [GODOT_EDITOR_SERVER_ID] : [];
		}

		const sessions: Map<string, McpSession> | undefined = this.workspaceSessions.get(this.activeWorkspaceId);
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
		return Array.from(this.customServerStatuses.values());
	}

	async listTools(serverId: string) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.listTools();
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			return this.diagnosticsBridge.listTools();
		}

		return this.getSession(serverId).listTools();
	}

	async callTool(serverId: string, name: string, args: Record<string, unknown>) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.callTool(name, args);
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			return this.diagnosticsBridge.callTool(name, args);
		}

		return this.getSession(serverId).callTool(name, args);
	}

	async listResources(serverId: string) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.listResources();
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			return this.diagnosticsBridge.listResources();
		}

		return this.getSession(serverId).listResources();
	}

	async readResource(serverId: string, uri: string) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.readResource(uri);
		}

		if (serverId === GODOT_DIAGNOSTICS_SERVER_ID) {
			return this.diagnosticsBridge.readResource(uri);
		}

		return this.getSession(serverId).readResource(uri);
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
