import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAutomationConfig } from "./config.js";
import { registerAutomationTools } from "./registration.js";

async function main(): Promise<void> {
	const config = createAutomationConfig();
	if (!config.enabled) {
		console.error("Daedalus Automation MCP is disabled. Set DAEDALUS_AUTOMATION_MCP=1 to start this development-only server.");
		process.exit(1);
	}

	const server = new McpServer({
		name: "godot-daedalus-automation-mcp",
		version: "0.1.0"
	});
	registerAutomationTools(server, config);
	await server.connect(new StdioServerTransport());
}

main().catch((error: unknown): void => {
	console.error("Daedalus Automation MCP failed to start:", error);
	process.exit(1);
});
