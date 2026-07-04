import type WebSocket from "ws";
import type { ClientRequest } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import type { ClientSession } from "./client-session.js";

export type RequestHandler = (
	socket: WebSocket,
	request: ClientRequest,
	session: ClientSession,
	mcpHost: McpHost
) => Promise<void> | void;

export const REQUEST_HANDLER_METHODS: readonly ClientRequest["method"][] = [
	"ping",
	"backend.health",
	"command.list",
	"provider.configure",
	"provider.config.get",
	"provider.config.set",
	"provider.config.clear",
	"provider.models.list",
	"ai.chat",
	"ai.next_step_hints",
	"ai.cancel",
	"prompt.list",
	"skill.list",
	"skill.activate",
	"session.reset",
	"session.info",
	"session.create",
	"session.open",
	"session.timeline",
	"session.list",
	"session.archive",
	"session.archived.list",
	"session.archived.restore",
	"session.archived.delete",
	"session.save",
	"session.delete",
	"session.rename",
	"session.compress",
	"session.summary",
	"session.guide.add",
	"session.guide.update",
	"session.guide.delete",
	"mcp.listTools",
	"mcp.callTool",
	"mcp.listResources",
	"mcp.readResource",
	"mcp.config.list",
	"mcp.config.add",
	"mcp.config.remove",
	"mcp.config.setEnabled",
	"fileChange.create",
	"fileChange.overwrite",
	"fileChange.delete",
	"approval.list",
	"approval.mode.set",
	"approval.approve",
	"approval.reject",
	"environment.configure",
	"editor.context.update",
	"editor.tool.result",
	"workspace.list",
	"workspace.select",
	"workspace.info"
] as const;

export const REQUEST_HANDLERS: ReadonlyMap<ClientRequest["method"], RequestHandler | null> = new Map(
	REQUEST_HANDLER_METHODS.map((method: ClientRequest["method"]): [ClientRequest["method"], RequestHandler | null] => [method, null])
);

export function assertKnownRequestMethod(method: ClientRequest["method"]): void {
	if (!REQUEST_HANDLERS.has(method)) {
		throw new Error(`Request method is missing dispatcher registration: ${method}`);
	}
}
