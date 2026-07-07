import type { ChatCompletionMessageToolCall, ChatCompletionToolMessageParam } from "openai/resources/chat/completions";
import type { McpHost } from "../mcp/mcp-host.js";
import { type ApprovalGateway, type PendingApproval } from "./approval-gateway.js";
import { describeToolEvent, type ToolEventDisplay } from "./tool-event-describer.js";
import { executeLlmToolWithIdempotency } from "./tool-idempotency.js";
import { parseToolResultSummary, type ParsedToolResultSummary } from "./tool-result-parser.js";
import type { FileEditBatchDraft } from "./file-edit-snapshots.js";
import { logger } from "../logger.js";

export type ToolEvent =
	| { type: "ai.delta"; text: string }
	| { type: "ai.thinking.delta"; text: string }
	| { type: "ai.thinking.done" }
	| ({ type: "tool.call"; step: number; toolCallId: string; toolName: string; args: Record<string, unknown> } & ToolEventDisplay)
	| ({ type: "tool.result"; step: number; toolCallId: string; toolName: string; resultChars: number; truncated: boolean; cached?: boolean; fileEditDraft?: FileEditBatchDraft | undefined } & ParsedToolResultSummary)
	| { type: "tool.error"; step: number; toolCallId: string; toolName: string; message: string }
	| ({ type: "tool.approval_required"; step: number; toolCallId: string; toolName: string; approvalId: string; reason: string; args: Record<string, unknown> } & ToolEventDisplay);

export type OnToolEvent = (event: ToolEvent) => void;

export class ToolApprovalRequiredError extends Error {
	readonly pendingApproval: PendingApproval;

	constructor(pendingApproval: PendingApproval) {
		super(`Tool approval required: ${pendingApproval.approvalId}`);
		this.name = "ToolApprovalRequiredError";
		this.pendingApproval = pendingApproval;
	}
}

async function executeSingleToolCall(
	mcpHost: McpHost,
	toolCall: ChatCompletionMessageToolCall,
	step: number,
	gateway: ApprovalGateway,
	onEvent?: OnToolEvent
): Promise<ChatCompletionToolMessageParam> {
	if (toolCall.type !== "function") {
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: "Error: Unsupported tool call type"
		};
	}

	const functionName: string = toolCall.function.name;

	let argsParsed: Record<string, unknown>;

	try {
		argsParsed = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
	} catch {
		const message: string = `Invalid JSON arguments: ${toolCall.function.arguments}`;
		logger.warn("tool", "arguments_invalid", {
			toolCallId: toolCall.id,
			toolName: functionName,
			step
		});
		onEvent?.({ type: "tool.error", step, toolCallId: toolCall.id, toolName: functionName, message });
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: `Error: ${message}`
		};
	}

	const decision = await gateway.evaluate(functionName, argsParsed, toolCall.id);
	logger.debug("tool", "policy_evaluated", {
		toolCallId: toolCall.id,
		toolName: functionName,
		step,
		action: decision.action,
		reason: "reason" in decision ? decision.reason : undefined,
		args: argsParsed
	});

	if (decision.action === "deny") {
		logger.warn("tool", "denied", {
			toolCallId: toolCall.id,
			toolName: functionName,
			step,
			reason: decision.reason
		});
		onEvent?.({ type: "tool.error", step, toolCallId: toolCall.id, toolName: functionName, message: decision.reason });
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: `Error: ${decision.reason}`
		};
	}

	if (decision.action === "request_approval") {
		const pending = gateway.requestApproval(functionName, argsParsed, toolCall.id, decision.reason, mcpHost.getActiveWorkspaceId());
		logger.info("tool", "approval_required", {
			toolCallId: toolCall.id,
			toolName: functionName,
			step,
			approvalId: pending.approvalId,
			workspaceId: mcpHost.getActiveWorkspaceId(),
			reason: decision.reason,
			args: argsParsed
		});
		onEvent?.({
			type: "tool.approval_required",
			step,
			toolCallId: toolCall.id,
			toolName: functionName,
			approvalId: pending.approvalId,
			reason: decision.reason,
			args: argsParsed,
			...describeToolEvent(functionName, argsParsed)
		});

		throw new ToolApprovalRequiredError(pending);
	}

	if (onEvent) {
		onEvent({
			type: "tool.call",
			step,
			toolCallId: toolCall.id,
			toolName: functionName,
			args: argsParsed,
			...describeToolEvent(functionName, argsParsed)
		});
	}

	const startedAtMs: number = Date.now();
	logger.info("tool", "call_started", {
		toolCallId: toolCall.id,
		toolName: functionName,
		step,
		workspaceId: mcpHost.getActiveWorkspaceId(),
		args: argsParsed
	});
	try {
		const result = await executeLlmToolWithIdempotency(mcpHost, functionName, argsParsed);
		const parsedSummary: ParsedToolResultSummary = parseToolResultSummary(functionName, argsParsed, result.content);
		logger.info("tool", "call_finished", {
			toolCallId: toolCall.id,
			toolName: functionName,
			step,
			workspaceId: mcpHost.getActiveWorkspaceId(),
			durationMs: Date.now() - startedAtMs,
			resultChars: result.rawContentLength,
			truncated: result.truncated,
			cached: result.reused,
			validationStatus: parsedSummary.validationStatus,
			terminalJobId: parsedSummary.terminalJobId,
			terminalJobStatus: parsedSummary.terminalJobStatus,
			hasFileEditDraft: result.fileEditDraft !== undefined
		});

		if (onEvent) {
			onEvent({
				type: "tool.result",
				step,
				toolCallId: toolCall.id,
				toolName: functionName,
				resultChars: result.rawContentLength,
				truncated: result.truncated,
				cached: result.reused,
				fileEditDraft: result.fileEditDraft,
				...parsedSummary
			});
		}

		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: result.content
		};
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : "MCP tool call failed";
		logger.error("tool", "call_failed", error, {
			toolCallId: toolCall.id,
			toolName: functionName,
			step,
			workspaceId: mcpHost.getActiveWorkspaceId(),
			durationMs: Date.now() - startedAtMs
		});

		if (onEvent) {
			onEvent({ type: "tool.error", step, toolCallId: toolCall.id, toolName: functionName, message });
		}

		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: `Error: ${message}`
		};
	}
}

export async function dispatchToolCalls(
	mcpHost: McpHost,
	toolCalls: ChatCompletionMessageToolCall[],
	step: number,
	gateway: ApprovalGateway,
	onEvent?: OnToolEvent
): Promise<ChatCompletionToolMessageParam[]> {
	const results: ChatCompletionToolMessageParam[] = [];

	for (const toolCall of toolCalls) {
		const result = await executeSingleToolCall(mcpHost, toolCall, step, gateway, onEvent);
		results.push(result);
	}

	return results;
}
