import { mcpServerConfigs } from "./mcp-config.js";
import { McpSession } from "./mcp-session.js";

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
