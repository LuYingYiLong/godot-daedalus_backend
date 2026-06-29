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
import { getToolDefinitions, getToolDefinitionsForNames, MAX_TOOL_STEPS, MAX_TOTAL_TOOL_RESULT_CHARS } from "../tools/llm-tools.js";
import { dispatchToolCalls, ToolApprovalRequiredError, type OnToolEvent } from "../tools/tool-dispatcher.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const FINALIZE_AFTER_TOOL_LIMIT_PROMPT: string =
	"工具调用阶段已经达到后端限制。请停止请求更多工具，基于目前已经获得的工具结果直接回答用户。"
	+ "如果信息不完整，请明确说明哪些部分是根据已有信息总结的，哪些部分还需要进一步检查。";

export type DeepSeekAgentResult =
	| { status: "completed"; text: string }
	| { status: "approval_required"; approvalId: string; toolName: string; reason: string };

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

async function createFinalAnswer(
	client: OpenAI,
	params: AiChatParams,
	options: DeepSeekChatOptions,
	messages: ChatCompletionMessageParam[],
	reason: string
): Promise<string> {
	const finalMessages: ChatCompletionMessageParam[] = [
		...messages,
		{
			role: "system",
			content: `${FINALIZE_AFTER_TOOL_LIMIT_PROMPT}\n\n收束原因：${reason}`
		}
	];
	const requestBody: ChatCompletionCreateParamsNonStreaming = {
		model: options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
		messages: finalMessages
	};

	applyChatOptions(requestBody, params);

	const completion = await client.chat.completions.create(requestBody);
	const text: string | null | undefined = completion.choices[0]?.message.content;

	if (!text) {
		throw new Error("LLM returned empty final response after tool limit");
	}

	return text;
}

export async function runDeepSeekAgent(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent
): Promise<DeepSeekAgentResult> {
	const client: OpenAI = createDeepSeekClient(options);
	const tools = allowedToolNames !== undefined
		? getToolDefinitionsForNames(allowedToolNames)
		: getToolDefinitions();

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

			return { status: "completed", text };
		}

		const assistantMessage: ChatCompletionMessageParam = {
			role: "assistant",
			content: message.content,
			tool_calls: toolCalls
		} as ChatCompletionMessageParam;

		messages.push(assistantMessage);

		let toolResults;
		try {
			toolResults = await dispatchToolCalls(mcpHost, toolCalls, step, gateway, onEvent);
		} catch (error: unknown) {
			if (error instanceof ToolApprovalRequiredError) {
				return {
					status: "approval_required",
					approvalId: error.pendingApproval.approvalId,
					toolName: error.pendingApproval.llmToolName,
					reason: error.pendingApproval.reason
				};
			}

			throw error;
		}

		for (const result of toolResults) {
			const contentText: string = extractTextContent(result.content);
			totalToolResultChars += estimateTextChars(contentText);
			messages.push(result);
		}

		if (totalToolResultChars >= MAX_TOTAL_TOOL_RESULT_CHARS) {
			return {
				status: "completed",
				text: await createFinalAnswer(
					client,
					params,
					options,
					messages,
					`工具结果总量达到 ${totalToolResultChars} 字符，上限为 ${MAX_TOTAL_TOOL_RESULT_CHARS} 字符`
				)
			};
		}
	}

	return {
		status: "completed",
		text: await createFinalAnswer(
			client,
			params,
			options,
			messages,
			`工具调用达到最大步数 ${MAX_TOOL_STEPS}，当前工具结果总量为 ${totalToolResultChars} 字符`
		)
	};
}
