import type { ChatCompletionMessageToolCall, ChatCompletionToolMessageParam } from "openai/resources/chat/completions";
import type { McpHost } from "../mcp/mcp-host.js";
import { MAX_TOOL_RESULT_CHARS, resolveToolMapping } from "./llm-tools.js";

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
	toolCall: ChatCompletionMessageToolCall
): Promise<ChatCompletionToolMessageParam> {
	if (toolCall.type !== "function") {
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: "Error: Unsupported tool call type"
		};
	}

	const functionName: string = toolCall.function.name;
	const mapping = resolveToolMapping(functionName);

	let argsParsed: Record<string, unknown>;

	try {
		argsParsed = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
	} catch {
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: `Error: Invalid JSON arguments: ${toolCall.function.arguments}`
		};
	}

	try {
		const result = await mcpHost.callTool(mapping.serverId, mapping.toolName, argsParsed) as ToolResultContent;
		const firstContent = result.content[0];

		let textResult: string;

		if (firstContent !== undefined && firstContent.text !== undefined) {
			textResult = firstContent.text;
		} else {
			textResult = JSON.stringify(result);
		}

		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: trimResult(textResult)
		};
	} catch (error: unknown) {
		return {
			role: "tool",
			tool_call_id: toolCall.id,
			content: `Error: ${error instanceof Error ? error.message : "MCP tool call failed"}`
		};
	}
}

export async function dispatchToolCalls(
	mcpHost: McpHost,
	toolCalls: ChatCompletionMessageToolCall[]
): Promise<ChatCompletionToolMessageParam[]> {
	const results: ChatCompletionToolMessageParam[] = [];

	for (const toolCall of toolCalls) {
		const result = await executeSingleToolCall(mcpHost, toolCall);
		results.push(result);
	}

	return results;
}
