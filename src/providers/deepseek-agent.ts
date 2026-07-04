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
	resolveChatModel,
	type DeepSeekChatOptions
} from "../providers/deepseek-client.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { getToolDefinitions, getToolDefinitionsForNames, resolveToolBudget, MAX_TOTAL_TOOL_RESULT_CHARS } from "../tools/llm-tools.js";
import { dispatchToolCalls, ToolApprovalRequiredError, type OnToolEvent } from "../tools/tool-dispatcher.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";
import { containsDsmlToolCalls } from "./deepseek-dsml-tools.js";
import { containsLooseToolCalls, isKnownLooseToolTagName, isPotentialLooseToolTagName, normalizeKnownToolName } from "./deepseek-loose-tools.js";

const FINALIZE_AFTER_TOOL_LIMIT_PROMPT: string =
	"工具调用阶段已经达到后端限制。请停止请求更多工具，基于目前已经获得的工具结果直接回答用户。"
	+ "如果信息不完整，请明确说明哪些部分是根据已有信息总结的，哪些部分还需要进一步检查。";
export type DeepSeekAgentResult =
	| { status: "completed"; text: string }
	| { status: "protocol_violation"; text: string; reason: string }
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
	reasoningContent: string;
	toolCalls: ChatCompletionMessageToolCall[];
	emittedContentText: string;
	suppressedToolSyntax: boolean;
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

function getAllowedToolNames(tools: ChatCompletionTool[]): ReadonlySet<string> {
	const allowedToolNames: Set<string> = new Set();

	for (const tool of tools) {
		if (tool.type === "function") {
			allowedToolNames.add(tool.function.name);
		}
	}

	return allowedToolNames;
}

function normalizeToolCallForAllowedTools(
	toolCall: ChatCompletionMessageToolCall,
	allowedToolNames: ReadonlySet<string>
): ChatCompletionMessageToolCall | null {
	if (!isFunctionToolCall(toolCall)) {
		return toolCall;
	}

	const normalizedName: string = normalizeKnownToolName(toolCall.function.name) ?? toolCall.function.name;
	if (!allowedToolNames.has(normalizedName)) {
		return null;
	}

	if (normalizedName === toolCall.function.name) {
		return toolCall;
	}

	return {
		...toolCall,
		function: {
			...toolCall.function,
			name: normalizedName
		}
	};
}

function filterToolCallsForAllowedTools(
	toolCalls: ChatCompletionMessageToolCall[],
	allowedToolNames: ReadonlySet<string>
): ChatCompletionMessageToolCall[] {
	const filteredToolCalls: ChatCompletionMessageToolCall[] = [];

	for (const toolCall of toolCalls) {
		const normalizedToolCall: ChatCompletionMessageToolCall | null = normalizeToolCallForAllowedTools(toolCall, allowedToolNames);
		if (normalizedToolCall !== null) {
			filteredToolCalls.push(normalizedToolCall);
		}
	}

	return filteredToolCalls;
}

function containsKnownToolSyntax(text: string | null | undefined): boolean {
	return containsDsmlToolCalls(text) || containsLooseToolCalls(text);
}

function createToolCallPreludeDelta(
	contentText: string | null,
	emittedContentText: string
): string {
	if (emittedContentText.trim().length > 0) {
		return "";
	}

	const naturalPrelude: string = (contentText ?? "").trim();
	if (naturalPrelude.length > 0) {
		return `\n\n${naturalPrelude}\n\n`;
	}

	return "";
}

function emitModelToolCallPrelude(
	contentText: string | null,
	emittedContentText: string,
	onEvent?: OnToolEvent
): void {
	const preludeDelta: string = createToolCallPreludeDelta(contentText, emittedContentText);
	if (preludeDelta.length > 0) {
		onEvent?.({ type: "ai.delta", text: preludeDelta });
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type LooseOpeningTag = {
	tagName: string;
	selfClosing: boolean;
};

function parseLooseOpeningTag(openingTag: string): LooseOpeningTag | null {
	const match: RegExpMatchArray | null = /^<\s*([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s+[^<>]*?)?(\/?)\s*>$/u.exec(openingTag);
	const tagName: string | undefined = match?.[1];
	if (tagName === undefined) {
		return null;
	}

	return {
		tagName,
		selfClosing: (match?.[2] ?? "") === "/"
	};
}

function isDsmlToolCallsOpeningTag(openingTag: string): boolean {
	return /^<\s*[｜|]+\s*DSML\s*[｜|]+\s*tool_calls\s*>$/iu.test(openingTag);
}

function isPotentialToolOpeningFragment(text: string): boolean {
	if (/^<\s*[｜|]/u.test(text)) {
		return true;
	}

	const match: RegExpMatchArray | null = /^<\s*([A-Za-z_][A-Za-z0-9_.:-]*)/u.exec(text);
	return match?.[1] !== undefined && isPotentialLooseToolTagName(match[1]);
}

function findLooseClosingTagEnd(text: string, tagName: string): number {
	const closingPattern: RegExp = new RegExp(`<\\/\\s*${escapeRegExp(tagName)}\\s*>`, "iu");
	const match: RegExpExecArray | null = closingPattern.exec(text);
	return match === null ? -1 : match.index + match[0].length;
}

function findDsmlClosingTagEnd(text: string): number {
	const closingPattern: RegExp = /<\/\s*[｜|]+\s*DSML\s*[｜|]+\s*tool_calls\s*>/iu;
	const match: RegExpExecArray | null = closingPattern.exec(text);
	return match === null ? -1 : match.index + match[0].length;
}

class ToolSyntaxStreamFilter {
	private pendingText: string = "";
	private strippingTagName: string | null = null;
	private strippingDsmlToolCalls: boolean = false;
	private emittedText: string = "";
	private suppressedSyntax: boolean = false;

	push(text: string): string {
		this.pendingText += text;
		const visibleText: string = this.drain(false);
		this.emittedText += visibleText;
		return visibleText;
	}

	flush(): string {
		const visibleText: string = this.drain(true);
		this.emittedText += visibleText;
		return visibleText;
	}

	getEmittedText(): string {
		return this.emittedText;
	}

	hasSuppressedSyntax(): boolean {
		return this.suppressedSyntax;
	}

	private drain(flush: boolean): string {
		let visibleText: string = "";

		while (this.pendingText.length > 0) {
			if (this.strippingTagName !== null) {
				const closingEnd: number = findLooseClosingTagEnd(this.pendingText, this.strippingTagName);
				if (closingEnd < 0) {
					if (flush) {
						this.pendingText = "";
						this.strippingTagName = null;
					}
					break;
				}

				this.pendingText = this.pendingText.slice(closingEnd);
				this.strippingTagName = null;
				continue;
			}

			if (this.strippingDsmlToolCalls) {
				const closingEnd: number = findDsmlClosingTagEnd(this.pendingText);
				if (closingEnd < 0) {
					if (flush) {
						this.pendingText = "";
						this.strippingDsmlToolCalls = false;
					}
					break;
				}

				this.pendingText = this.pendingText.slice(closingEnd);
				this.strippingDsmlToolCalls = false;
				continue;
			}

			const tagStart: number = this.pendingText.indexOf("<");
			if (tagStart < 0) {
				visibleText += this.pendingText;
				this.pendingText = "";
				break;
			}

			if (tagStart > 0) {
				visibleText += this.pendingText.slice(0, tagStart);
				this.pendingText = this.pendingText.slice(tagStart);
				continue;
			}

			const tagEnd: number = this.pendingText.indexOf(">");
			if (tagEnd < 0) {
				if (flush) {
					if (isPotentialToolOpeningFragment(this.pendingText)) {
						this.suppressedSyntax = true;
					} else {
						visibleText += this.pendingText;
					}
					this.pendingText = "";
				}
				break;
			}

			const openingTag: string = this.pendingText.slice(0, tagEnd + 1);
			const looseOpeningTag: LooseOpeningTag | null = parseLooseOpeningTag(openingTag);
			if (looseOpeningTag !== null && isKnownLooseToolTagName(looseOpeningTag.tagName)) {
				this.suppressedSyntax = true;
				this.pendingText = this.pendingText.slice(tagEnd + 1);
				this.strippingTagName = looseOpeningTag.selfClosing ? null : looseOpeningTag.tagName;
				continue;
			}

			if (isDsmlToolCallsOpeningTag(openingTag)) {
				this.suppressedSyntax = true;
				this.pendingText = this.pendingText.slice(tagEnd + 1);
				this.strippingDsmlToolCalls = true;
				continue;
			}

			visibleText += openingTag;
			this.pendingText = this.pendingText.slice(tagEnd + 1);
		}

		return visibleText;
	}
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
	onEvent?: OnToolEvent,
	emitContentDeltas: boolean = true,
	abortSignal?: AbortSignal | undefined
): Promise<StreamedAssistantMessage> {
	const requestBody: ChatCompletionCreateParamsStreaming = {
		model: resolveChatModel(options),
		messages,
		tools,
		stream: true
	};

	applyChatOptions(requestBody, params, options);

	const stream = await client.chat.completions.create(requestBody, { signal: abortSignal });
	const toolCallAccumulators: Map<number, ToolCallAccumulator> = new Map();
	const contentFilter: ToolSyntaxStreamFilter = new ToolSyntaxStreamFilter();
	let contentText = "";
	let reasoningContent = "";
	let emittedReasoning = false;

	for await (const chunk of stream) {
		const delta: unknown = (chunk as ChatCompletionChunk).choices[0]?.delta;
		if (delta === undefined || delta === null) {
			continue;
		}

		const reasoningDelta: string = getReasoningContent(delta);
		if (reasoningDelta.length > 0) {
			reasoningContent += reasoningDelta;
			emittedReasoning = true;
			onEvent?.({ type: "ai.thinking.delta", text: reasoningDelta });
		}

		const contentDelta: string = getContentDelta(delta);
		if (contentDelta.length > 0) {
			contentText += contentDelta;
			if (emitContentDeltas) {
				const visibleDelta: string = contentFilter.push(contentDelta);
				if (visibleDelta.length > 0) {
					onEvent?.({ type: "ai.delta", text: visibleDelta });
				}
			}
		}

		for (const toolCallDelta of getToolCallDeltaList(delta)) {
			applyToolCallDelta(toolCallAccumulators, toolCallDelta, step);
		}
	}

	if (emittedReasoning) {
		onEvent?.({ type: "ai.thinking.done" });
	}

	if (emitContentDeltas) {
		const visibleTail: string = contentFilter.flush();
		if (visibleTail.length > 0) {
			onEvent?.({ type: "ai.delta", text: visibleTail });
		}
	}

	return {
		contentText,
		reasoningContent,
		toolCalls: createToolCallsFromAccumulators(toolCallAccumulators),
		emittedContentText: emitContentDeltas ? contentFilter.getEmittedText() : "",
		suppressedToolSyntax: emitContentDeltas && contentFilter.hasSuppressedSyntax()
	};
}

function createAssistantToolMessage(
	contentText: string | null,
	toolCalls: ChatCompletionMessageToolCall[],
	reasoningContent: string
): ChatCompletionMessageParam {
	const message: Record<string, unknown> = {
		role: "assistant",
		content: contentText,
		tool_calls: toolCalls
	};

	if (reasoningContent.length > 0) {
		message.reasoning_content = reasoningContent;
	}

	return message as unknown as ChatCompletionMessageParam;
}

async function createFinalAnswer(
	client: OpenAI,
	params: AiChatParams,
	options: DeepSeekChatOptions,
	messages: ChatCompletionMessageParam[],
	reason: string,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	const finalMessages: ChatCompletionMessageParam[] = [
		...messages,
		{
			role: "system",
			content: `${FINALIZE_AFTER_TOOL_LIMIT_PROMPT}\n\n收束原因：${reason}`
		}
	];
	const requestBody: ChatCompletionCreateParamsNonStreaming = {
		model: resolveChatModel(options),
		messages: finalMessages
	};

	applyChatOptions(requestBody, params, options);

	const completion = await client.chat.completions.create(requestBody, { signal: abortSignal });
	const text: string | null | undefined = completion.choices[0]?.message.content;

	if (!text) {
		throw new Error("LLM returned empty final response after tool limit");
	}

	if (containsKnownToolSyntax(text)) {
		throw new Error(`protocol_violation: ${reason}`);
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
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined
): Promise<DeepSeekAgentResult> {
	let totalToolResultChars: number = initialToolResultChars;
	const allowedToolNames: ReadonlySet<string> = getAllowedToolNames(tools);

	for (let step: number = startStep; step < maxSteps; step += 1) {
		if (abortSignal?.aborted) {
			throw new Error("Request cancelled");
		}

		let toolCalls: ChatCompletionMessageToolCall[] | undefined;
		let contentText: string | null;
		let reasoningContent: string = "";
		let emittedContentText: string = "";
		let suppressedStreamToolSyntax: boolean = false;
		if (streamAssistant) {
			const streamedMessage: StreamedAssistantMessage = await readStreamingAssistantMessage(
				client,
				params,
				options,
				messages,
				tools,
				step,
				onEvent,
				true,
				abortSignal
			);
			toolCalls = streamedMessage.toolCalls;
			contentText = streamedMessage.contentText.length > 0 ? streamedMessage.contentText : null;
			reasoningContent = streamedMessage.reasoningContent;
			emittedContentText = streamedMessage.emittedContentText;
			suppressedStreamToolSyntax = streamedMessage.suppressedToolSyntax;
		} else {
			const requestBody: ChatCompletionCreateParamsNonStreaming = {
				model: resolveChatModel(options),
				messages,
				tools
			};

			applyChatOptions(requestBody, params, options);

			const completion = await client.chat.completions.create(requestBody, { signal: abortSignal });
			const choice = completion.choices[0];

			if (!choice) {
				throw new Error("LLM returned empty choices");
			}

			const message = choice.message;
			reasoningContent = getReasoningContent(message);
			emitReasoningContent(message, onEvent);
			toolCalls = message.tool_calls;
			contentText = message.content;
		}

		if (toolCalls !== undefined && toolCalls.length > 0) {
			toolCalls = filterToolCallsForAllowedTools(toolCalls, allowedToolNames);
		}

		if (!toolCalls || toolCalls.length === 0) {
			const text: string | null = contentText;

			if (!text) {
				throw new Error("LLM returned empty response");
			}

			const hasKnownToolSyntax: boolean = containsKnownToolSyntax(text) || suppressedStreamToolSyntax;
			if (hasKnownToolSyntax) {
				return {
					status: "protocol_violation",
					text: "",
					reason: "模型在文本内容中输出了 XML/DSML/裸工具标签；AgentRun v2 只接受 API tool_calls。"
				};
			}

			return { status: "completed", text };
		}

		emitModelToolCallPrelude(contentText, streamAssistant ? emittedContentText : "", onEvent);

		const assistantMessage: ChatCompletionMessageParam = createAssistantToolMessage(contentText, toolCalls, reasoningContent);

		messages.push(assistantMessage);

		let toolResults;
		try {
			if (abortSignal?.aborted) {
				throw new Error("Request cancelled");
			}
			toolResults = await dispatchToolCalls(mcpHost, toolCalls, step, gateway, onEvent);
		} catch (error: unknown) {
			if (error instanceof ToolApprovalRequiredError) {
				const pendingToolCall: ChatCompletionMessageToolCall | undefined = toolCalls.find(
					(toolCall: ChatCompletionMessageToolCall): boolean => toolCall.id === error.pendingApproval.toolCallId
				);
				const continuationMessages: ChatCompletionMessageParam[] = [...messages];

				if (pendingToolCall !== undefined) {
					continuationMessages[continuationMessages.length - 1] = createAssistantToolMessage(contentText, [pendingToolCall], reasoningContent);
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
				`工具结果总量达到 ${totalToolResultChars} 字符，上限为 ${MAX_TOTAL_TOOL_RESULT_CHARS} 字符`,
				abortSignal
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
		`工具调用达到最大步数 ${maxSteps}，当前工具结果总量为 ${totalToolResultChars} 字符`,
		abortSignal
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
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined
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

	return runAgentLoop(client, params, options, messages, mcpHost, gateway, tools, 0, maxSteps, 0, false, onEvent, abortSignal);
}

export async function runDeepSeekAgentStreaming(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined
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

	return runAgentLoop(client, params, options, messages, mcpHost, gateway, tools, 0, maxSteps, 0, true, onEvent, abortSignal);
}

export async function continueDeepSeekAgent(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	continuation: DeepSeekAgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined
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
			`工具结果总量达到 ${totalToolResultChars} 字符，上限为 ${MAX_TOTAL_TOOL_RESULT_CHARS} 字符`,
			abortSignal
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
		onEvent,
		abortSignal
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
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined
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
			`工具结果总量达到 ${totalToolResultChars} 字符，上限为 ${MAX_TOTAL_TOOL_RESULT_CHARS} 字符`,
			abortSignal
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
		onEvent,
		abortSignal
	);
}
