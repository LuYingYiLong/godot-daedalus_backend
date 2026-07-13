import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createExternalMcpConfig } from "./config.js";
import { registerExternalMcpTools } from "./registration.js";

async function main(): Promise<void> {
	const config = createExternalMcpConfig();
	const server: McpServer = new McpServer({
		name: "godot-daedalus-mcp",
		version: "1.0.0"
	});

	registerExternalMcpTools(server, config);
	await server.connect(new StdioServerTransport());
	console.error(`Daedalus external MCP started, mode: ${config.mode}, backend: ${config.backendUrl}`);
}

main().catch((error: unknown): void => {
	console.error("Daedalus external MCP failed to start:", error);
	process.exit(1);
});
