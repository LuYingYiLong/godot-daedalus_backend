import { createServer } from "./server/websocket-server.js";
import { McpHost } from "./mcp/mcp-host.js";
import { getBackendPortFromEnv } from "./server/backend-runtime.js";

const port: number = getBackendPortFromEnv();

const mcpHost: McpHost = new McpHost();

try {
	await mcpHost.connectAll();
} catch (error: unknown) {
	console.warn("MCP host failed to connect:", error instanceof Error ? error.message : error);
	console.warn("Server will start without MCP support");
}

createServer(port, mcpHost);
