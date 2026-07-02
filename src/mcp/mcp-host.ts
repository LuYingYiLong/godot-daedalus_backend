import { buildMcpServerConfigs } from "./mcp-config.js";
import { GODOT_EDITOR_SERVER_ID, GodotEditorBridge } from "./godot-editor-bridge.js";
import { McpSession } from "./mcp-session.js";
import { getDefaultWorkspace } from "../workspace/registry.js";
import type { WorkspaceConfig } from "../workspace/types.js";

export class McpHost {
	private workspaceSessions: Map<string, Map<string, McpSession>> = new Map();
	private activeWorkspaceId?: string | undefined;
	private readonly editorBridge: GodotEditorBridge = new GodotEditorBridge();

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
		console.log(`MCP active workspace: ${workspace.id} -> ${workspace.rootPath}`);
	}

	private async ensureWorkspace(workspace: WorkspaceConfig): Promise<void> {
		if (this.workspaceSessions.has(workspace.id)) {
			return;
		}

		const configs = buildMcpServerConfigs(workspace);
		if (configs.length === 0) {
			throw new Error(`MCP workspace has no project path: ${workspace.id}`);
		}

		const sessions: Map<string, McpSession> = new Map();

		try {
			for (const config of configs) {
				const session: McpSession = new McpSession(config);
				await session.connect();
				sessions.set(config.id, session);
				console.log(`MCP session connected: ${workspace.id}/${config.id}`);
			}
		} catch (error: unknown) {
			for (const session of sessions.values()) {
				await session.close().catch((): void => undefined);
			}

			throw error;
		}

		this.workspaceSessions.set(workspace.id, sessions);
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

		if (this.activeWorkspaceId === workspaceId) {
			this.activeWorkspaceId = undefined;
		}
	}

	getActiveWorkspaceId(): string | undefined {
		return this.activeWorkspaceId;
	}

	getEditorBridge(): GodotEditorBridge {
		return this.editorBridge;
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
		if (this.editorBridge.isOnline()) {
			serverIds.push(GODOT_EDITOR_SERVER_ID);
		}
		return serverIds.sort();
	}

	getConnectedWorkspaceIds(): string[] {
		return Array.from(this.workspaceSessions.keys()).sort();
	}

	async listTools(serverId: string) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.listTools();
		}

		return this.getSession(serverId).listTools();
	}

	async callTool(serverId: string, name: string, args: Record<string, unknown>) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.callTool(name, args);
		}

		return this.getSession(serverId).callTool(name, args);
	}

	async listResources(serverId: string) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.listResources();
		}

		return this.getSession(serverId).listResources();
	}

	async readResource(serverId: string, uri: string) {
		if (serverId === GODOT_EDITOR_SERVER_ID) {
			return this.editorBridge.readResource(uri);
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
		this.activeWorkspaceId = undefined;
	}
}
