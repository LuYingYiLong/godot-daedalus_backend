import OpenAI from "openai";
import type {
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionMessageFunctionToolCall,
	ChatCompletionTool,
	ChatCompletionToolMessageParam,
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionChunk
} from "openai/resources/chat/completions";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import {
	createDeepSeekClient,
	createMessages,
	applyChatOptions,
	type DeepSeekChatOptions
} from "../providers/deepseek-client.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { getToolDefinitions, getToolDefinitionsForNames, DEFAULT_TOOL_STEPS, resolveToolBudget, MAX_TOTAL_TOOL_RESULT_CHARS } from "../tools/llm-tools.js";
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

type StreamedAssistantMessage = {
	contentText: string;
	toolCalls: ChatCompletionMessageToolCall[];
};

type ToolCallAccumulator = {
	index: number;
	id: string;
	name: string;
	argumentsText: string;
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

function isFunctionToolCall(toolCall: ChatCompletionMessageToolCall): toolCall is ChatCompletionMessageFunctionToolCall {
	return toolCall.type === "function";
}

function getReasoningContent(message: unknown): string {
	if (message === null || typeof message !== "object") {
		return "";
	}

	const reasoningValue: unknown = (message as { reasoning_content?: unknown }).reasoning_content;
	return typeof reasoningValue === "string" ? reasoningValue : "";
}

function emitReasoningContent(message: unknown, onEvent?: OnToolEvent): void {
	const reasoningContent: string = getReasoningContent(message);
	if (reasoningContent.length === 0) {
		return;
	}

	onEvent?.({ type: "ai.thinking.delta", text: reasoningContent });
	onEvent?.({ type: "ai.thinking.done" });
}

function getContentDelta(delta: unknown): string {
	if (delta === null || typeof delta !== "object") {
		return "";
	}

	const contentValue: unknown = (delta as { content?: unknown }).content;
	return typeof contentValue === "string" ? contentValue : "";
}

function getToolCallDeltaList(delta: unknown): unknown[] {
	if (delta === null || typeof delta !== "object") {
		return [];
	}

	const toolCallsValue: unknown = (delta as { tool_calls?: unknown }).tool_calls;
	return Array.isArray(toolCallsValue) ? toolCallsValue : [];
}

function applyToolCallDelta(accumulators: Map<number, ToolCallAccumulator>, value: unknown, step: number): void {
	if (value === null || typeof value !== "object") {
		return;
	}

	const delta = value as {
		index?: unknown;
		id?: unknown;
		function?: {
			name?: unknown;
			arguments?: unknown;
		};
	};
	const index: number = typeof delta.index === "number" ? delta.index : accumulators.size;
	const existing: ToolCallAccumulator | undefined = accumulators.get(index);
	const accumulator: ToolCallAccumulator = existing ?? {
		index,
		id: `stream-tool-${step}-${index}`,
		name: "",
		argumentsText: ""
	};

	if (typeof delta.id === "string" && delta.id.length > 0) {
		accumulator.id = delta.id;
	}

	if (typeof delta.function?.name === "string" && delta.function.name.length > 0) {
		accumulator.name = delta.function.name;
	}

	if (typeof delta.function?.arguments === "string" && delta.function.arguments.length > 0) {
		accumulator.argumentsText += delta.function.arguments;
	}

	accumulators.set(index, accumulator);
}

function createToolCallsFromAccumulators(accumulators: Map<number, ToolCallAccumulator>): ChatCompletionMessageToolCall[] {
	return Array.from(accumulators.values())
		.sort((a: ToolCallAccumulator, b: ToolCallAccumulator): number => a.index - b.index)
		.filter((accumulator: ToolCallAccumulator): boolean => accumulator.name.length > 0)
		.map((accumulator: ToolCallAccumulator): ChatCompletionMessageToolCall => ({
			id: accumulator.id,
			type: "function",
			function: {
				name: accumulator.name,
				arguments: accumulator.argumentsText
			}
		}) as ChatCompletionMessageToolCall);
}

async function readStreamingAssistantMessage(
	client: OpenAI,
	params: AiChatParams,
	options: DeepSeekChatOptions,
	messages: ChatCompletionMessageParam[],
	tools: ChatCompletionTool[],
	step: number,
	onEvent?: OnToolEvent
): Promise<StreamedAssistantMessage> {
	const requestBody: ChatCompletionCreateParamsStreaming = {
		model: options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
		messages,
		tools,
		stream: true
	};

	applyChatOptions(requestBody, params);

	const stream = await client.chat.completions.create(requestBody);
	const toolCallAccumulators: Map<number, ToolCallAccumulator> = new Map();
	let contentText = "";
	let emittedReasoning = false;

	for await (const chunk of stream) {
		const delta: unknown = (chunk as ChatCompletionChunk).choices[0]?.delta;
		if (delta === undefined || delta === null) {
			continue;
		}

		const reasoningDelta: string = getReasoningContent(delta);
		if (reasoningDelta.length > 0) {
			emittedReasoning = true;
			onEvent?.({ type: "ai.thinking.delta", text: reasoningDelta });
		}

		const contentDelta: string = getContentDelta(delta);
		if (contentDelta.length > 0) {
			contentText += contentDelta;
			onEvent?.({ type: "ai.delta", text: contentDelta });
		}

		for (const toolCallDelta of getToolCallDeltaList(delta)) {
			applyToolCallDelta(toolCallAccumulators, toolCallDelta, step);
		}
	}

	if (emittedReasoning) {
		onEvent?.({ type: "ai.thinking.done" });
	}

	return {
		contentText,
		toolCalls: createToolCallsFromAccumulators(toolCallAccumulators)
	};
}

function createDsmlLeakFallback(text: string, reason: string): string {
	const strippedText: string = stripDsmlToolCalls(text);
	const parsedToolCalls: ChatCompletionMessageToolCall[] = parseDsmlToolCalls(text, "blocked-dsml");
	const toolNames: string[] = parsedToolCalls
		.filter(isFunctionToolCall)
		.map((toolCall: ChatCompletionMessageFunctionToolCall): string => toolCall.function.name);
	const toolText: string = toolNames.length > 0 ? `\n\n模型还尝试调用工具：${toolNames.map((name: string): string => `\`${name}\``).join(", ")}。` : "";
	const prefix: string = strippedText.length > 0 ? `${strippedText}\n\n` : "";

	return [
		prefix.trimEnd(),
		"工具调用没有继续执行，因为当前回复已经进入收束阶段。",
		`原因：${reason}`,
		"我已隐藏模型输出中的 DSML 工具调用文本，避免把内部工具协议直接显示给你。",
		toolText.trim()
	].filter((part: string): boolean => part.length > 0).join("\n");
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

	if (containsDsmlToolCalls(text)) {
		return createDsmlLeakFallback(text, reason);
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
	maxSteps: number,
	initialToolResultChars: number,
	streamAssistant: boolean,
	onEvent?: OnToolEvent
): Promise<DeepSeekAgentResult> {
	let totalToolResultChars: number = initialToolResultChars;

	for (let step: number = startStep; step < maxSteps; step += 1) {
		let toolCalls: ChatCompletionMessageToolCall[] | undefined;
		let contentText: string | null;

		if (streamAssistant) {
			const streamedMessage: StreamedAssistantMessage = await readStreamingAssistantMessage(
				client,
				params,
				options,
				messages,
				tools,
				step,
				onEvent
			);
			toolCalls = streamedMessage.toolCalls;
			contentText = streamedMessage.contentText.length > 0 ? streamedMessage.contentText : null;
		} else {
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
			emitReasoningContent(message, onEvent);
			toolCalls = message.tool_calls;
			contentText = message.content;
		}

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
				const pendingToolCall: ChatCompletionMessageToolCall | undefined = toolCalls.find(
					(toolCall: ChatCompletionMessageToolCall): boolean => toolCall.id === error.pendingApproval.toolCallId
				);
				const continuationMessages: ChatCompletionMessageParam[] = [...messages];

				if (pendingToolCall !== undefined) {
					continuationMessages[continuationMessages.length - 1] = {
						role: "assistant",
						content: containsDsmlToolCalls(contentText) ? stripDsmlToolCalls(contentText ?? "") : contentText,
						tool_calls: [pendingToolCall]
					} as ChatCompletionMessageParam;
				}

				return {
					status: "approval_required",
					approvalId: error.pendingApproval.approvalId,
					toolName: error.pendingApproval.llmToolName,
					reason: error.pendingApproval.reason,
					continuation: {
						messages: continuationMessages,
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
			const finalText: string = await createFinalAnswer(
				client,
				params,
				options,
				messages,
				`工具结果总量达到 ${totalToolResultChars} 字符，上限为 ${MAX_TOTAL_TOOL_RESULT_CHARS} 字符`
			);
			if (streamAssistant) {
				onEvent?.({ type: "ai.delta", text: finalText });
			}

			return {
				status: "completed",
				text: finalText
			};
		}
	}

	const finalText: string = await createFinalAnswer(
		client,
		params,
		options,
		messages,
		`工具调用达到最大步数 ${maxSteps}，当前工具结果总量为 ${totalToolResultChars} 字符`
	);
	if (streamAssistant) {
		onEvent?.({ type: "ai.delta", text: finalText });
	}

	return {
		status: "completed",
		text: finalText
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

	const maxSteps: number = resolveToolBudget(
		(params.options as Record<string, unknown> | undefined)?.["toolBudget"] as string | undefined,
		params.skillId
	);

	const messages: ChatCompletionMessageParam[] = createMessages(params, history, systemPrompt);

	return runAgentLoop(client, params, options, messages, mcpHost, gateway, tools, 0, maxSteps, 0, false, onEvent);
}

export async function runDeepSeekAgentStreaming(
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

	const maxSteps: number = resolveToolBudget(
		(params.options as Record<string, unknown> | undefined)?.["toolBudget"] as string | undefined,
		params.skillId
	);

	const messages: ChatCompletionMessageParam[] = createMessages(params, history, systemPrompt);

	return runAgentLoop(client, params, options, messages, mcpHost, gateway, tools, 0, maxSteps, 0, true, onEvent);
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

	const maxSteps: number = resolveToolBudget(
		(params.options as Record<string, unknown> | undefined)?.["toolBudget"] as string | undefined,
		params.skillId
	);

	return runAgentLoop(
		client,
		params,
		options,
		messages,
		mcpHost,
		gateway,
		tools,
		continuation.nextStep,
		maxSteps,
		totalToolResultChars,
		false,
		onEvent
	);
}

export async function continueDeepSeekAgentStreaming(
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
		const finalText: string = await createFinalAnswer(
			client,
			params,
			options,
			messages,
			`工具结果总量达到 ${totalToolResultChars} 字符，上限为 ${MAX_TOTAL_TOOL_RESULT_CHARS} 字符`
		);
		onEvent?.({ type: "ai.delta", text: finalText });

		return {
			status: "completed",
			text: finalText
		};
	}

	const maxSteps: number = resolveToolBudget(
		(params.options as Record<string, unknown> | undefined)?.["toolBudget"] as string | undefined,
		params.skillId
	);

	return runAgentLoop(
		client,
		params,
		options,
		messages,
		mcpHost,
		gateway,
		tools,
		continuation.nextStep,
		maxSteps,
		totalToolResultChars,
		true,
		onEvent
	);
}
