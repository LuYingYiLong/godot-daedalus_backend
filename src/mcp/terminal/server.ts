import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTerminalTools } from "./registration.js";

export async function main(): Promise<void> {
	const server: McpServer = new McpServer({
		name: "terminal-mcp-server",
		version: "1.0.0"
	});

	registerTerminalTools(server);

	const transport: StdioServerTransport = new StdioServerTransport();
	await server.connect(transport);

	console.error("Terminal MCP Server started");
}

main().catch((error: unknown): void => {
	console.error("Terminal MCP server fatal error:", error);
	process.exit(1);
});
