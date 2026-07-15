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

const handleClientRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/client-handlers.js")).handleClientRequest;
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

const handleWorkbenchRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/workbench-handlers.js")).handleWorkbenchRequest;
});

const handleMessageQueueRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/message-queue-handlers.js")).handleMessageQueueRequest;
});

const handleMcpRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/mcp-handlers.js")).handleMcpRequest;
});

const handleToolRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/tool-handlers.js")).handleToolRequest;
});

const handleFileChangeRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/file-change-handlers.js")).handleFileChangeRequest;
});

const handleFileEditRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/file-edit-handlers.js")).handleFileEditRequest;
});

const handleAttachmentRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/attachment-handlers.js")).handleAttachmentRequest;
});

const handlePlanRequest: RequestHandler = createLazyHandler(async (): Promise<RequestHandler> => {
	return (await import("./handlers/plan-handlers.js")).handlePlanRequest;
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
	"client.hello",
	"client.info",
	"provider.configure",
	"provider.config.get",
	"provider.current.get",
	"provider.modelSelection.get",
	"provider.config.set",
	"provider.config.clear",
	"provider.models.list",
	"ai.chat",
	"ai.next_step_hints",
	"ai.cancel",
	"prompt.list",
	"userPrompt.get",
	"userPrompt.set",
	"skill.list",
	"skill.get",
	"skill.set_enabled",
	"skill.update",
	"skill.remove",
	"skill.reload",
	"session.reset",
	"session.info",
	"session.create",
	"session.open",
	"session.subscribe",
	"session.unsubscribe",
	"session.editor.bind",
	"session.timeline",
	"session.list",
	"session.browser.snapshot",
	"session.archive",
	"session.archived.list",
	"session.archived.restore",
	"session.archived.delete",
	"session.save",
	"session.delete",
	"session.rename",
	"session.compress",
	"session.summary",
	"session.workbench.get",
	"session.workbench.patch",
	"session.guide.add",
	"session.guide.update",
	"session.guide.delete",
	"message.queue.list",
	"message.queue.add",
	"message.queue.update",
	"message.queue.remove",
	"message.queue.status",
	"mcp.listTools",
	"mcp.callTool",
	"mcp.listResources",
	"mcp.readResource",
	"mcp.config.list",
	"mcp.config.add",
	"mcp.config.update",
	"mcp.config.remove",
	"mcp.config.setEnabled",
	"tool.catalog.list",
	"tool.execute",
	"fileChange.create",
	"fileChange.overwrite",
	"fileChange.delete",
	"fileEdit.batch.get",
	"attachment.image.save",
	"attachment.image.generated.get",
	"plan.get",
	"plan.clarify",
	"plan.revise",
	"plan.approve",
	"approval.list",
	"approval.mode.set",
	"approval.approve",
	"approval.reject",
	"environment.configure",
	"editor.instances.list",
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
	["client.hello", handleClientRequest],
	["client.info", handleClientRequest],
	["prompt.list", handleCoreRequest],
	["userPrompt.get", handleCoreRequest],
	["userPrompt.set", handleCoreRequest],
	["skill.list", handleCoreRequest],
	["skill.get", handleCoreRequest],
	["skill.set_enabled", handleCoreRequest],
	["skill.update", handleCoreRequest],
	["skill.remove", handleCoreRequest],
	["skill.reload", handleCoreRequest],
	["provider.configure", handleProviderRequest],
	["provider.config.get", handleProviderRequest],
	["provider.current.get", handleProviderRequest],
	["provider.modelSelection.get", handleProviderRequest],
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
	["session.subscribe", handleSessionRequest],
	["session.unsubscribe", handleSessionRequest],
	["session.editor.bind", handleSessionRequest],
	["session.timeline", handleSessionRequest],
	["session.list", handleSessionRequest],
	["session.browser.snapshot", handleSessionRequest],
	["session.archive", handleSessionRequest],
	["session.archived.list", handleSessionRequest],
	["session.archived.restore", handleSessionRequest],
	["session.archived.delete", handleSessionRequest],
	["session.save", handleSessionRequest],
	["session.delete", handleSessionRequest],
	["session.rename", handleSessionRequest],
	["session.compress", handleSessionRequest],
	["session.summary", handleSessionRequest],
	["session.workbench.get", handleWorkbenchRequest],
	["session.workbench.patch", handleWorkbenchRequest],
	["session.guide.add", handleGuideRequest],
	["session.guide.update", handleGuideRequest],
	["session.guide.delete", handleGuideRequest],
	["message.queue.list", handleMessageQueueRequest],
	["message.queue.add", handleMessageQueueRequest],
	["message.queue.update", handleMessageQueueRequest],
	["message.queue.remove", handleMessageQueueRequest],
	["message.queue.status", handleMessageQueueRequest],
	["mcp.listTools", handleMcpRequest],
	["mcp.callTool", handleMcpRequest],
	["mcp.listResources", handleMcpRequest],
	["mcp.readResource", handleMcpRequest],
	["mcp.config.list", handleMcpRequest],
	["mcp.config.add", handleMcpRequest],
	["mcp.config.update", handleMcpRequest],
	["mcp.config.remove", handleMcpRequest],
	["mcp.config.setEnabled", handleMcpRequest],
	["tool.catalog.list", handleToolRequest],
	["tool.execute", handleToolRequest],
	["fileChange.create", handleFileChangeRequest],
	["fileChange.overwrite", handleFileChangeRequest],
	["fileChange.delete", handleFileChangeRequest],
	["fileEdit.batch.get", handleFileEditRequest],
	["attachment.image.save", handleAttachmentRequest],
	["attachment.image.generated.get", handleAttachmentRequest],
	["plan.get", handlePlanRequest],
	["plan.clarify", handlePlanRequest],
	["plan.revise", handlePlanRequest],
	["plan.approve", handlePlanRequest],
	["approval.list", handleApprovalRequest],
	["approval.mode.set", handleApprovalRequest],
	["approval.approve", handleApprovalRequest],
	["approval.reject", handleApprovalRequest],
	["environment.configure", handleEnvironmentRequest],
	["editor.instances.list", handleEditorRequest],
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
