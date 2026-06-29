import { createServer } from "./server/websocket-server.js";
import { McpHost } from "./mcp/mcp-host.js";

const DEFAULT_PORT: number = 8080;
const portText: string = process.env.PORT ?? String(DEFAULT_PORT);
const port: number = Number.parseInt(portText, 10);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
	throw new Error(`Invalid PORT: ${portText}`);
}

const mcpHost: McpHost = new McpHost();

try {
	await mcpHost.connectAll();
} catch (error: unknown) {
	console.warn("MCP host failed to connect:", error instanceof Error ? error.message : error);
	console.warn("Server will start without MCP support");
}

createServer(port, mcpHost);
