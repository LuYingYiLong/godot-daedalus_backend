import type WebSocket from "ws";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import { createWorkspaceToolCatalog, type ToolCatalogEntry } from "../../tools/tool-catalog.js";
import { getEffectiveToolPolicy, type ApprovalDecision, type ToolPolicy } from "../../tools/tool-policy.js";
import { executeLlmToolWithIdempotency, type IdempotentToolExecutionResult } from "../../tools/tool-idempotency.js";
import { describeToolEvent } from "../../tools/tool-event-describer.js";
import { parseToolResultSummary } from "../../tools/tool-result-parser.js";
import { parseExternalMcpMode, isToolAllowedForExternalMcpMode, type ExternalMcpMode } from "../../tools/external-mcp-mode.js";
import { getApprovalMode } from "../../approval-settings-store.js";
import { logger } from "../../logger.js";

function getToolDefinitionName(definition: ChatCompletionTool): string {
	return definition.type === "function" ? definition.function.name : "";
}

function createCatalogToolResult(entry: ToolCatalogEntry, mode: ExternalMcpMode): Record<string, unknown> {
	const definitionName: string = getToolDefinitionName(entry.definition);
	return {
		name: entry.id,
		title: entry.definition.type === "function" ? entry.definition.function.name : entry.id,
		description: entry.definition.type === "function" ? entry.definition.function.description ?? "" : "",
		inputSchema: entry.definition.type === "function" ? entry.definition.function.parameters ?? {} : {},
		risk: entry.policy.risk,
		phaseEligibility: entry.phaseEligibility,
		mode,
		capabilityRequirement: entry.capabilityRequirement ?? null,
		dynamic: entry.dynamicMetadata !== undefined,
		definitionName
	};
}

function getAllowedCatalogEntries(session: ClientSession, mode: ExternalMcpMode): ToolCatalogEntry[] {
	const catalog = createWorkspaceToolCatalog({
		workspaceId: session.activeWorkspace?.id,
		editorInstanceId: session.editorInstanceId
	});
	return catalog.getEntries()
		.filter((entry: ToolCatalogEntry): boolean => isToolAllowedForExternalMcpMode(mode, entry.id, entry.policy));
}

function findCatalogEntry(session: ClientSession, toolName: string): ToolCatalogEntry | undefined {
	const catalog = createWorkspaceToolCatalog({
		workspaceId: session.activeWorkspace?.id,
		editorInstanceId: session.editorInstanceId
	});
	return catalog.getEntry(toolName);
}

function sendToolError(socket: WebSocket, request: ClientRequest, code: string, message: string): void {
	sendJson(socket, {
		type: "response",
		id: request.id,
		ok: false,
		error: { code, message }
	});
}

export async function handleToolRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "tool.catalog.list": {
		const mode: ExternalMcpMode = parseExternalMcpMode(request.params?.mode);
		const entries: ToolCatalogEntry[] = getAllowedCatalogEntries(session, mode);
		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				mode,
				workspaceId: session.activeWorkspace?.id ?? null,
				tools: entries.map((entry: ToolCatalogEntry): Record<string, unknown> => createCatalogToolResult(entry, mode))
			}
		});
		break;
	}

	case "tool.execute": {
		const mode: ExternalMcpMode = parseExternalMcpMode(request.params.mode);
		const toolName: string = request.params.toolName;
		const args: Record<string, unknown> = request.params.args ?? {};
		const entry: ToolCatalogEntry | undefined = findCatalogEntry(session, toolName);
		if (entry === undefined) {
			sendToolError(socket, request, "unknown_tool", `Unknown tool: ${toolName}`);
			break;
		}

		const effectivePolicy: ToolPolicy | undefined = getEffectiveToolPolicy(toolName, args, session.activeWorkspace?.id);
		if (!isToolAllowedForExternalMcpMode(mode, toolName, effectivePolicy)) {
			sendToolError(socket, request, "tool_not_allowed", `Tool is not allowed in external MCP ${mode} mode: ${toolName}`);
			break;
		}

		const approvalMode = await getApprovalMode();
		session.approvalGateway.setMode(approvalMode);
		const toolCallId: string = request.params.toolCallId ?? request.id;
		const decision: ApprovalDecision = await session.approvalGateway.evaluate(toolName, args, toolCallId, session.activeWorkspace?.id);
		if (decision.action === "deny") {
			sendToolError(socket, request, "tool_denied", decision.reason);
			break;
		}

		if (decision.action === "request_approval") {
			const pending = session.approvalGateway.requestApproval(
				toolName,
				args,
				toolCallId,
				decision.reason,
				session.activeWorkspace?.id,
				session.editorInstanceId,
				session.sessionId
			);
			logger.info("external_mcp", "tool_approval_required", {
				approvalId: pending.approvalId,
				toolName,
				workspaceId: session.activeWorkspace?.id,
				mode
			});
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					status: "approval_required",
					approvalId: pending.approvalId,
					reason: pending.reason,
					toolName,
					args,
					display: describeToolEvent(toolName, args, session.activeWorkspace?.id)
				}
			});
			break;
		}

		try {
			const result: IdempotentToolExecutionResult = await executeLlmToolWithIdempotency(
				mcpHost,
				toolName,
				args,
				session.activeWorkspace?.id,
				session.editorInstanceId,
				session.sessionId
			);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: {
					status: "executed",
					toolName,
					content: result.content,
					resultChars: result.rawContentLength,
					truncated: result.truncated,
					cached: result.reused,
					parsed: parseToolResultSummary(toolName, args, result.content)
				}
			});
		} catch (error: unknown) {
			logger.error("external_mcp", "tool_execute_failed", error, {
				toolName,
				workspaceId: session.activeWorkspace?.id,
				mode
			});
			sendToolError(socket, request, "tool_execution_failed", error instanceof Error ? error.message : "Tool execution failed");
		}
		break;
	}

	default:
		throw new Error(`Unsupported tool method: ${request.method}`);
	}
}
