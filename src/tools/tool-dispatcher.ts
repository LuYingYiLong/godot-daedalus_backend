import type { ChatCompletionMessageToolCall, ChatCompletionToolMessageParam } from "openai/resources/chat/completions";
import type { McpHost } from "../mcp/mcp-host.js";
import { type ApprovalGateway, type PendingApproval } from "./approval-gateway.js";
import type { ToolRequiredConsent } from "./tool-policy.js";
import { describeToolEvent, type ToolEventDisplay } from "./tool-event-describer.js";
import { executeLlmToolWithIdempotency } from "./tool-idempotency.js";
import type { IdempotentToolExecutionResult } from "./tool-idempotency.js";
import { parseToolResultSummary, type ParsedToolResultSummary } from "./tool-result-parser.js";
import type { FileEditBatchDraft } from "./file-edit-snapshots.js";
import type { ImageGenerationResult } from "../providers/image-generation.js";
import type { ToolExecutionContext } from "./tool-catalog.js";
import { logger } from "../logger.js";
import { getApprovalReasonFromArgs, stripApprovalReasonArg } from "./approval-reason.js";

export type ToolEvent =
	| { type: "ai.delta"; text: string }
	| { type: "ai.thinking.delta"; text: string }
	| { type: "ai.thinking.done" }
	| ({ type: "tool.call"; step: number; toolCallId: string; toolName: string; args: Record<string, unknown> } & ToolEventDisplay)
	| ({ type: "tool.progress"; step: number; toolCallId: string; toolName: string } & ToolProgressUpdate)
	| ({ type: "tool.result"; step: number; toolCallId: string; toolName: string; resultChars: number; truncated: boolean; cached?: boolean; fileEditDraft?: FileEditBatchDraft | undefined; imageGeneration?: ImageGenerationResult | undefined } & ParsedToolResultSummary)
	| { type: "tool.error"; step: number; toolCallId: string; toolName: string; message: string }
	| ({ type: "tool.approval_required"; step: number; toolCallId: string; toolName: string; approvalId: string; reason: string; args: Record<string, unknown>; requiredConsent?: ToolRequiredConsent | undefined } & ToolEventDisplay);

export type OnToolEvent = (event: ToolEvent) => void;

export type ToolProgressUpdate = {
	status: "message" | "success" | "error";
	title: string;
	details: string;
	code: string;
};

export type ToolResultEnricher = (input: {
	toolName: string;
	args: Record<string, unknown>;
	result: IdempotentToolExecutionResult;
	onProgress?: ((progress: ToolProgressUpdate) => void) | undefined;
}) => Promise<IdempotentToolExecutionResult>;

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
	onEvent?: OnToolEvent,
	enricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<ChatCompletionToolMessageParam> {
	if (abortSignal?.aborted) {
		throw new Error("Request cancelled");
	}

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

	const workspaceId: string | undefined = toolContext?.workspaceId ?? mcpHost.getActiveWorkspaceId();
	const executionArgs: Record<string, unknown> = stripApprovalReasonArg(argsParsed);
	const approvalReason: string = getApprovalReasonFromArgs(argsParsed, "");
	const decision = await gateway.evaluate(functionName, executionArgs, toolCall.id, workspaceId);
	logger.debug("tool", "policy_evaluated", {
		toolCallId: toolCall.id,
		toolName: functionName,
		step,
		action: decision.action,
		reason: "reason" in decision ? decision.reason : undefined,
		args: executionArgs
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
		const reason: string = approvalReason.length > 0 ? approvalReason : decision.reason;
		const pending = gateway.requestApproval(functionName, executionArgs, toolCall.id, reason, workspaceId, toolContext?.editorInstanceId, toolContext?.sessionId, decision.requiredConsent);
		logger.info("tool", "approval_required", {
			toolCallId: toolCall.id,
			toolName: functionName,
			step,
			approvalId: pending.approvalId,
			workspaceId,
			reason,
			args: executionArgs
		});
		onEvent?.({
			type: "tool.approval_required",
			step,
			toolCallId: toolCall.id,
			toolName: functionName,
			approvalId: pending.approvalId,
			reason,
			args: executionArgs,
			requiredConsent: pending.requiredConsent,
			...describeToolEvent(functionName, executionArgs, workspaceId)
		});

		throw new ToolApprovalRequiredError(pending);
	}

	if (onEvent) {
		onEvent({
			type: "tool.call",
			step,
			toolCallId: toolCall.id,
			toolName: functionName,
			args: executionArgs,
			...describeToolEvent(functionName, executionArgs, workspaceId)
		});
	}

	const startedAtMs: number = Date.now();
	logger.info("tool", "call_started", {
		toolCallId: toolCall.id,
		toolName: functionName,
		step,
		workspaceId,
		args: executionArgs
	});
	try {
		if (abortSignal?.aborted) {
			throw new Error("Request cancelled");
		}
		const rawResult = await executeLlmToolWithIdempotency(mcpHost, functionName, executionArgs, workspaceId, toolContext?.editorInstanceId, toolContext?.sessionId, abortSignal);
		const result: IdempotentToolExecutionResult = enricher === undefined
			? rawResult
			: await enricher({
				toolName: functionName,
				args: executionArgs,
				result: rawResult,
				onProgress: onEvent === undefined
					? undefined
					: (progress: ToolProgressUpdate): void => {
						onEvent({
							type: "tool.progress",
							step,
							toolCallId: toolCall.id,
							toolName: functionName,
							...progress
						});
					}
			});
		const parsedSummary: ParsedToolResultSummary = parseToolResultSummary(functionName, executionArgs, result.content);
		logger.info("tool", "call_finished", {
			toolCallId: toolCall.id,
			toolName: functionName,
			step,
			workspaceId,
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
				imageGeneration: result.imageGeneration,
				...parsedSummary
			});
		}

		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: result.content
		};
	} catch (error: unknown) {
		if (abortSignal?.aborted) {
			throw error;
		}

		const message: string = error instanceof Error ? error.message : "MCP tool call failed";
		logger.error("tool", "call_failed", error, {
			toolCallId: toolCall.id,
			toolName: functionName,
			step,
			workspaceId,
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
	onEvent?: OnToolEvent,
	enricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined,
	abortSignal?: AbortSignal | undefined
): Promise<ChatCompletionToolMessageParam[]> {
	const results: ChatCompletionToolMessageParam[] = [];

	for (const toolCall of toolCalls) {
		const result = await executeSingleToolCall(mcpHost, toolCall, step, gateway, onEvent, enricher, toolContext, abortSignal);
		results.push(result);
	}

	return results;
}
