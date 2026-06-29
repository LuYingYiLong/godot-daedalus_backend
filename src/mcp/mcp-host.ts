import { mcpServerConfigs, buildMcpServerConfigs } from "./mcp-config.js";
import { McpSession } from "./mcp-session.js";
import type { WorkspaceConfig } from "../workspace/types.js";

export class McpHost {
	private sessions: Map<string, McpSession> = new Map();

	async connectAll(): Promise<void> {
		for (const config of mcpServerConfigs) {
			const session: McpSession = new McpSession(config);
			await session.connect();
			this.sessions.set(config.id, session);
			console.log(`MCP session connected: ${config.id}`);
		}
	}

	async switchWorkspace(workspace: WorkspaceConfig): Promise<void> {
		const configs = buildMcpServerConfigs(workspace);
		const oldIds: string[] = Array.from(this.sessions.keys());

		for (const config of configs) {
			const oldSession: McpSession | undefined = this.sessions.get(config.id);
			if (oldSession) {
				try {
					await oldSession.close();
				} catch (error: unknown) {
					console.warn(`Failed to close MCP session ${config.id}:`, error);
				}
				this.sessions.delete(config.id);
			}

			const newSession: McpSession = new McpSession(config);
			await newSession.connect();
			this.sessions.set(config.id, newSession);
			console.log(`MCP session reconnected: ${config.id} → ${workspace.rootPath}`);
		}

		// Close any remaining sessions not in the new config
		for (const id of oldIds) {
			const session: McpSession | undefined = this.sessions.get(id);
			if (session && !configs.some((c) => c.id === id)) {
				try {
					await session.close();
				} catch {
					// ignore
				}
				this.sessions.delete(id);
			}
		}
	}

	getSession(id: string): McpSession {
		const session: McpSession | undefined = this.sessions.get(id);

		if (!session) {
			throw new Error(`MCP session not found: ${id}`);
		}

		return session;
	}

	getConnectedServerIds(): string[] {
		return Array.from(this.sessions.keys()).sort();
	}

	async listTools(serverId: string) {
		return this.getSession(serverId).listTools();
	}

	async callTool(serverId: string, name: string, args: Record<string, unknown>) {
		return this.getSession(serverId).callTool(name, args);
	}

	async listResources(serverId: string) {
		return this.getSession(serverId).listResources();
	}

	async readResource(serverId: string, uri: string) {
		return this.getSession(serverId).readResource(uri);
	}

	async closeAll(): Promise<void> {
		for (const session of this.sessions.values()) {
			await session.close();
		}
	}
}
