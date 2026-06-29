import type { ChatCompletionMessageToolCall, ChatCompletionToolMessageParam } from "openai/resources/chat/completions";
import type { McpHost } from "../mcp/mcp-host.js";
import { MAX_TOOL_RESULT_CHARS, resolveToolMapping } from "./llm-tools.js";
import { type ApprovalGateway, type PendingApproval } from "./approval-gateway.js";

export type ToolEvent =
	| { type: "tool.call"; step: number; toolName: string; args: Record<string, unknown> }
	| { type: "tool.result"; step: number; toolName: string; resultChars: number; truncated: boolean }
	| { type: "tool.error"; step: number; toolName: string; message: string }
	| { type: "tool.approval_required"; step: number; toolName: string; approvalId: string; reason: string };

export type OnToolEvent = (event: ToolEvent) => void;

export class ToolApprovalRequiredError extends Error {
	readonly pendingApproval: PendingApproval;

	constructor(pendingApproval: PendingApproval) {
		super(`Tool approval required: ${pendingApproval.approvalId}`);
		this.name = "ToolApprovalRequiredError";
		this.pendingApproval = pendingApproval;
	}
}

type ToolResultContent = {
	content: Array<{ type: string; text?: string }>;
};

function trimResult(text: string): string {
	if (text.length <= MAX_TOOL_RESULT_CHARS) {
		return text;
	}

	return text.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[结果已截断，原始长度 ${text.length} 字符]`;
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
		onEvent?.({ type: "tool.error", step, toolName: functionName, message });
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: `Error: ${message}`
		};
	}

	const decision = await gateway.evaluate(functionName, argsParsed, toolCall.id);

	if (decision.action === "deny") {
		onEvent?.({ type: "tool.error", step, toolName: functionName, message: decision.reason });
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: `Error: ${decision.reason}`
		};
	}

	if (decision.action === "request_approval") {
		const pending = gateway.requestApproval(functionName, argsParsed, toolCall.id, decision.reason);
		onEvent?.({
			type: "tool.approval_required",
			step,
			toolName: functionName,
			approvalId: pending.approvalId,
			reason: decision.reason
		});

		throw new ToolApprovalRequiredError(pending);
	}

	if (onEvent) {
		onEvent({ type: "tool.call", step, toolName: functionName, args: argsParsed });
	}

	try {
		const result = await mcpHost.callTool(
			resolveToolMapping(functionName).serverId,
			resolveToolMapping(functionName).toolName,
			argsParsed
		) as ToolResultContent;
		const firstContent = result.content[0];

		let textResult: string;

		if (firstContent !== undefined && firstContent.text !== undefined) {
			textResult = firstContent.text;
		} else {
			textResult = JSON.stringify(result);
		}

		const truncated: boolean = textResult.length > MAX_TOOL_RESULT_CHARS;

		if (onEvent) {
			onEvent({
				type: "tool.result",
				step,
				toolName: functionName,
				resultChars: textResult.length,
				truncated
			});
		}

		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: trimResult(textResult)
		};
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : "MCP tool call failed";

		if (onEvent) {
			onEvent({ type: "tool.error", step, toolName: functionName, message });
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
