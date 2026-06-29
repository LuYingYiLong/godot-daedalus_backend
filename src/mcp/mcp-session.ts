import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./types.js";

export class McpSession {
	private client: Client;
	private transport: StdioClientTransport | undefined;

	constructor(private readonly config: McpServerConfig) {
		this.client = new Client({
			name: `daedalus-${config.id}-client`,
			version: "1.0.0"
		});
	}

	async connect(): Promise<void> {
		this.transport = new StdioClientTransport({
			command: this.config.command,
			args: this.config.args,
			env: {
				...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
				...this.config.env
			} as Record<string, string>
		});

		await this.client.connect(this.transport);
	}

	async listTools() {
		return this.client.listTools();
	}

	async callTool(name: string, args: Record<string, unknown>) {
		return this.client.callTool({
			name,
			arguments: args
		});
	}

	async listResources() {
		return this.client.listResources();
	}

	async readResource(uri: string) {
		return this.client.readResource({ uri });
	}

	async close(): Promise<void> {
		await this.client.close();
	}

	get id(): string {
		return this.config.id;
	}
}
