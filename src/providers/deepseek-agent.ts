import OpenAI from "openai";
import type {
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionTool,
	ChatCompletionToolMessageParam,
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
import { containsDsmlToolCalls, parseDsmlToolCalls, stripDsmlToolCalls } from "./deepseek-dsml-tools.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const FINALIZE_AFTER_TOOL_LIMIT_PROMPT: string =
	"工具调用阶段已经达到后端限制。请停止请求更多工具，基于目前已经获得的工具结果直接回答用户。"
	+ "如果信息不完整，请明确说明哪些部分是根据已有信息总结的，哪些部分还需要进一步检查。";

export type DeepSeekAgentResult =
	| { status: "completed"; text: string }
	| {
		status: "approval_required";
		approvalId: string;
		toolName: string;
		reason: string;
		continuation: DeepSeekAgentContinuation;
	};

export type DeepSeekAgentContinuation = {
	messages: ChatCompletionMessageParam[];
	nextStep: number;
	totalToolResultChars: number;
};

export type ApprovedToolResult = {
	toolCallId: string;
	content: string;
};

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

async function runAgentLoop(
	client: OpenAI,
	params: AiChatParams,
	options: DeepSeekChatOptions,
	messages: ChatCompletionMessageParam[],
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	tools: ChatCompletionTool[],
	startStep: number,
	initialToolResultChars: number,
	onEvent?: OnToolEvent
): Promise<DeepSeekAgentResult> {
	let totalToolResultChars: number = initialToolResultChars;

	for (let step: number = startStep; step < MAX_TOOL_STEPS; step += 1) {
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
		let toolCalls: ChatCompletionMessageToolCall[] | undefined = message.tool_calls;
		const contentText: string | null = message.content;

		if ((!toolCalls || toolCalls.length === 0) && containsDsmlToolCalls(contentText)) {
			const parsedToolCalls: ChatCompletionMessageToolCall[] = parseDsmlToolCalls(contentText ?? "", `dsml-step-${step}`);
			if (parsedToolCalls.length > 0) {
				toolCalls = parsedToolCalls;
			}
		}

		if (!toolCalls || toolCalls.length === 0) {
			const text: string | null = contentText;

			if (!text) {
				throw new Error("LLM returned empty response");
			}

			return { status: "completed", text };
		}

		const assistantMessage: ChatCompletionMessageParam = {
			role: "assistant",
			content: containsDsmlToolCalls(contentText) ? stripDsmlToolCalls(contentText ?? "") : contentText,
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
					reason: error.pendingApproval.reason,
					continuation: {
						messages: [...messages],
						nextStep: step + 1,
						totalToolResultChars
					}
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

	return runAgentLoop(client, params, options, messages, mcpHost, gateway, tools, 0, 0, onEvent);
}

export async function continueDeepSeekAgent(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	continuation: DeepSeekAgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent
): Promise<DeepSeekAgentResult> {
	const client: OpenAI = createDeepSeekClient(options);
	const tools = allowedToolNames !== undefined
		? getToolDefinitionsForNames(allowedToolNames)
		: getToolDefinitions();
	const messages: ChatCompletionMessageParam[] = [...continuation.messages];
	const toolMessage: ChatCompletionToolMessageParam = {
		role: "tool",
		tool_call_id: approvedToolResult.toolCallId,
		content: approvedToolResult.content
	};
	const totalToolResultChars: number = continuation.totalToolResultChars + estimateTextChars(approvedToolResult.content);

	messages.push(toolMessage);

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

	return runAgentLoop(
		client,
		params,
		options,
		messages,
		mcpHost,
		gateway,
		tools,
		continuation.nextStep,
		totalToolResultChars,
		onEvent
	);
}
