import OpenAI from "openai";
import type {
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionCreateParamsNonStreaming
} from "openai/resources/chat/completions";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import {
	createDeepSeekClient,
	createMessages,
	applyChatOptions,
	type DeepSeekChatOptions
} from "../providers/deepseek-client.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { getToolDefinitions, MAX_TOOL_STEPS } from "../tools/llm-tools.js";
import { dispatchToolCalls } from "../tools/tool-dispatcher.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

function estimateTextChars(text: string): number {
	return text.length;
}

function extractTextContent(content: ChatCompletionMessageParam["content"]): string {
	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part): string => part.text)
			.join("");
	}

	return "";
}

export async function runDeepSeekAgent(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	mcpHost: McpHost
): Promise<string> {
	const client: OpenAI = createDeepSeekClient(options);
	const tools = getToolDefinitions();

	const messages: ChatCompletionMessageParam[] = createMessages(params, history, systemPrompt);

	let totalToolResultChars: number = 0;

	for (let step: number = 0; step < MAX_TOOL_STEPS; step += 1) {
		const requestBody: ChatCompletionCreateParamsNonStreaming = {
			model: options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
			messages,
			tools
		};

		applyChatOptions(requestBody, params);

		const completion = await client.chat.completions.create(requestBody);
		const choice = completion.choices[0];

		if (!choice) {
			throw new Error("LLM returned empty choices");
		}

		const message = choice.message;
		const toolCalls: ChatCompletionMessageToolCall[] | undefined = message.tool_calls;

		if (!toolCalls || toolCalls.length === 0) {
			const text: string | null = message.content;

			if (!text) {
				throw new Error("LLM returned empty response");
			}

			return text;
		}

		const assistantMessage: ChatCompletionMessageParam = {
			role: "assistant",
			content: message.content,
			tool_calls: toolCalls
		} as ChatCompletionMessageParam;

		messages.push(assistantMessage);

		const toolResults = await dispatchToolCalls(mcpHost, toolCalls);

		for (const result of toolResults) {
			const contentText: string = extractTextContent(result.content);
			totalToolResultChars += estimateTextChars(contentText);
			messages.push(result);
		}
	}

	throw new Error(
		`Tool calling exceeded maximum steps (${MAX_TOOL_STEPS}). ` +
		`Total tool result chars: ${totalToolResultChars}`
	);
}
