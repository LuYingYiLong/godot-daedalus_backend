import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertProjectExists, projectRoot } from "./context.js";
import { registerGodotToolsAndResources } from "./registration.js";

async function main(): Promise<void> {
	await assertProjectExists();

	const server: McpServer = new McpServer({
		name: "godot-project-server",
		version: "1.0.0"
	});

	registerGodotToolsAndResources(server);

	const transport: StdioServerTransport = new StdioServerTransport();
	await server.connect(transport);

	console.error(`Godot MCP Server started, project: ${projectRoot}`);
}

main().catch((error: unknown): void => {
	console.error("MCP server fatal error:", error);
	process.exit(1);
});
