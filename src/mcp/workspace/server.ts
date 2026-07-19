import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWorkspaceTools } from "./registration.js";

async function main(): Promise<void> {
	const server: McpServer = new McpServer({
		name: "workspace-mcp-server",
		version: "1.0.0"
	});

	registerWorkspaceTools(server);

	const transport: StdioServerTransport = new StdioServerTransport();
	await server.connect(transport);

	console.error(`Workspace MCP Server started, root: ${process.env.WORKSPACE_ROOT ?? ""}`);
}

main().catch((error: unknown): void => {
	console.error("Workspace MCP server fatal error:", error);
	process.exit(1);
});
