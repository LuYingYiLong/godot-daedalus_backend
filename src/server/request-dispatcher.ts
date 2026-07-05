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

function createLazyHandler(loadHandler: () => Promise<RequestHandler>): RequestHandler {
	let handlerPromise: Promise<RequestHandler> | null = null;
	return async (socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> => {
		if (handlerPromise === null) {
			handlerPromise = loadHandler();
		}
		const handler: RequestHandler = await handlerPromise;
		await handler(socket, request, session, mcpHost);
	};
}

const handleCoreRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/core-handlers.js")).handleCoreRequest;
});

const handleProviderRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/provider-handlers.js")).handleProviderRequest;
});

const handleChatRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./chat-orchestrator.js")).handleChatRequest;
});

const handleSessionRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./session-rpc-handlers.js")).handleSessionRequest;
});

const handleGuideRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/guide-handlers.js")).handleGuideRequest;
});

const handleMcpRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/mcp-handlers.js")).handleMcpRequest;
});

const handleFileChangeRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/file-change-handlers.js")).handleFileChangeRequest;
});

const handleApprovalRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/approval-handlers.js")).handleApprovalRequest;
});

const handleEnvironmentRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/environment-handlers.js")).handleEnvironmentRequest;
});

const handleEditorRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/editor-handlers.js")).handleEditorRequest;
});

const handleWorkspaceRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/workspace-handlers.js")).handleWorkspaceRequest;
});

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

export const REQUEST_HANDLERS: ReadonlyMap<ClientRequest["method"], RequestHandler> = new Map([
	["ping", handleCoreRequest],
	["backend.health", handleCoreRequest],
	["command.list", handleCoreRequest],
	["prompt.list", handleCoreRequest],
	["skill.list", handleCoreRequest],
	["skill.activate", handleCoreRequest],
	["provider.configure", handleProviderRequest],
	["provider.config.get", handleProviderRequest],
	["provider.config.set", handleProviderRequest],
	["provider.config.clear", handleProviderRequest],
	["provider.models.list", handleProviderRequest],
	["ai.cancel", handleChatRequest],
	["ai.chat", handleChatRequest],
	["ai.next_step_hints", handleChatRequest],
	["session.reset", handleSessionRequest],
	["session.info", handleSessionRequest],
	["session.create", handleSessionRequest],
	["session.open", handleSessionRequest],
	["session.timeline", handleSessionRequest],
	["session.list", handleSessionRequest],
	["session.archive", handleSessionRequest],
	["session.archived.list", handleSessionRequest],
	["session.archived.restore", handleSessionRequest],
	["session.archived.delete", handleSessionRequest],
	["session.save", handleSessionRequest],
	["session.delete", handleSessionRequest],
	["session.rename", handleSessionRequest],
	["session.compress", handleSessionRequest],
	["session.summary", handleSessionRequest],
	["session.guide.add", handleGuideRequest],
	["session.guide.update", handleGuideRequest],
	["session.guide.delete", handleGuideRequest],
	["mcp.listTools", handleMcpRequest],
	["mcp.callTool", handleMcpRequest],
	["mcp.listResources", handleMcpRequest],
	["mcp.readResource", handleMcpRequest],
	["mcp.config.list", handleMcpRequest],
	["mcp.config.add", handleMcpRequest],
	["mcp.config.remove", handleMcpRequest],
	["mcp.config.setEnabled", handleMcpRequest],
	["fileChange.create", handleFileChangeRequest],
	["fileChange.overwrite", handleFileChangeRequest],
	["fileChange.delete", handleFileChangeRequest],
	["approval.list", handleApprovalRequest],
	["approval.mode.set", handleApprovalRequest],
	["approval.approve", handleApprovalRequest],
	["approval.reject", handleApprovalRequest],
	["environment.configure", handleEnvironmentRequest],
	["editor.context.update", handleEditorRequest],
	["editor.tool.result", handleEditorRequest],
	["workspace.list", handleWorkspaceRequest],
	["workspace.select", handleWorkspaceRequest],
	["workspace.info", handleWorkspaceRequest]
]);

export function assertKnownRequestMethod(method: ClientRequest["method"]): void {
	if (!REQUEST_HANDLERS.has(method)) {
		throw new Error(`Request method is missing dispatcher registration: ${method}`);
	}
}

export async function dispatchRequest(
	socket: WebSocket,
	request: ClientRequest,
	session: ClientSession,
	mcpHost: McpHost
): Promise<void> {
	const handler: RequestHandler | undefined = REQUEST_HANDLERS.get(request.method);
	if (handler === undefined) {
		throw new Error(`Request method is missing dispatcher registration: ${request.method}`);
	}

	await handler(socket, request, session, mcpHost);
}
