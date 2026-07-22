import { createServer } from "./server/websocket-server.js";
import { McpHost } from "./mcp/mcp-host.js";
import { getBackendPortFromEnv } from "./server/backend-runtime.js";
import { getCurrentBackendLogPath, installProcessLogHandlers, logger } from "./logger.js";
import { initializeUsageMetricsStore } from "./usage/metrics-store.js";

const port: number = getBackendPortFromEnv();

installProcessLogHandlers();
logger.info("backend", "starting", {
	port,
	pid: process.pid,
	mode: process.env.DAEDALUS_BACKEND_MODE ?? "development",
	logPath: getCurrentBackendLogPath()
});
void initializeUsageMetricsStore();

const mcpHost: McpHost = new McpHost();

try {
	await mcpHost.connectAll();
} catch (error: unknown) {
	logger.warn("mcp", "connect_all_failed", {
		error: error instanceof Error ? error.message : error
	}, "Server will start without MCP support");
}

createServer(port, mcpHost);
