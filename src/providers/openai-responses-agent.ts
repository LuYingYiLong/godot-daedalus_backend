import type { ChatCompletionMessageToolCall, ChatCompletionTool } from "openai/resources/chat/completions";
import type {
	FunctionTool,
	Response,
	ResponseCreateParamsNonStreaming,
	ResponseCreateParamsStreaming,
	ResponseFunctionToolCall,
	ResponseInputItem,
	ResponseOutputItem,
	ResponseStreamEvent,
	Tool
} from "openai/resources/responses/responses";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { ApprovalGateway } from "../tools/approval-gateway.js";
import { dispatchToolCalls, ToolApprovalRequiredError, type OnToolEvent, type ToolResultEnricher } from "../tools/tool-dispatcher.js";
import { createWorkspaceToolCatalog, type ToolExecutionContext } from "../tools/tool-catalog.js";
import { MAX_TOTAL_TOOL_RESULT_CHARS, resolveToolBudget } from "../tools/llm-tool-budget.js";
import type { ApprovedToolResult, ProviderAgentResult, ResponsesAgentContinuation } from "./agent-types.js";
import type { ProviderChatOptions } from "./deepseek-client.js";
import {
	applyOpenAIResponsesOptions,
	createOpenAIResponseInput,
	createOpenAIResponsesClient,
	resolveOpenAIResponsesModel
} from "./openai-responses-client.js";
import { createToolResultLimitFallback, createToolResultLimitReason, fitToolResultContent } from "./tool-result-budget.js";

const FINALIZE_AFTER_TOOL_LIMIT_PROMPT: string =
	"工具调用阶段已经达到后端限制。请停止请求更多工具，基于目前已经获得的工具结果直接回答用户。"
	+ "如果信息不完整，请明确说明哪些部分是根据已有信息总结的，哪些部分还需要进一步检查。";

type ResponsesAssistantMessage = {
	text: string;
	toolCalls: ResponseFunctionToolCall[];
	outputItems: ResponseOutputItem[];
};

type AppendToolResultItemsResult = {
	addedChars: number;
	limitReached: boolean;
	reason: string | null;
};

function shouldRequireToolCallOnStep(params: AiChatParams, step: number, startStep: number): boolean {
	const options: Record<string, unknown> | undefined = params.options as Record<string, unknown> | undefined;
	return step === startStep && options?.requireToolCallOnFirstStep === true;
}

function convertToolDefinition(tool: ChatCompletionTool): FunctionTool | null {
	if (tool.type !== "function") {
		return null;
	}

	return {
		type: "function",
		name: tool.function.name,
		description: tool.function.description ?? null,
		parameters: tool.function.parameters ?? null,
		strict: false
	};
}

export function convertToolDefinitions(tools: ChatCompletionTool[]): Tool[] {
	const responsesTools: Tool[] = [];
	for (const tool of tools) {
		const convertedTool: FunctionTool | null = convertToolDefinition(tool);
		if (convertedTool !== null) {
			responsesTools.push(convertedTool);
		}
	}
	return responsesTools;
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

function isAllowedFunctionCall(toolCall: ResponseFunctionToolCall, allowedToolNames: ReadonlySet<string>): boolean {
	return allowedToolNames.has(toolCall.name);
}

function convertResponsesToolCall(toolCall: ResponseFunctionToolCall): ChatCompletionMessageToolCall {
	return {
		id: toolCall.call_id,
		type: "function",
		function: {
			name: toolCall.name,
			arguments: toolCall.arguments
		}
	} as ChatCompletionMessageToolCall;
}

export function convertResponsesToolCalls(toolCalls: ResponseFunctionToolCall[], allowedToolNames: ReadonlySet<string>): ChatCompletionMessageToolCall[] {
	return toolCalls
		.filter((toolCall: ResponseFunctionToolCall): boolean => isAllowedFunctionCall(toolCall, allowedToolNames))
		.map(convertResponsesToolCall);
}

function extractFunctionCalls(outputItems: readonly ResponseOutputItem[]): ResponseFunctionToolCall[] {
	return outputItems.filter((item: ResponseOutputItem): item is ResponseFunctionToolCall => item.type === "function_call");
}

function appendResponseOutputItems(inputItems: ResponseInputItem[], outputItems: readonly ResponseOutputItem[]): void {
	for (const item of outputItems) {
		inputItems.push(item as ResponseInputItem);
	}
}

function appendToolResultItems(
	inputItems: ResponseInputItem[],
	toolResults: Awaited<ReturnType<typeof dispatchToolCalls>>,
	currentTotalChars: number
): AppendToolResultItemsResult {
	let addedChars: number = 0;
	let limitReached: boolean = false;
	let reason: string | null = null;
	for (const result of toolResults) {
		const content: string = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
		const budgetedResult = fitToolResultContent(content, currentTotalChars + addedChars);
		addedChars += budgetedResult.chars;
		inputItems.push({
			type: "function_call_output",
			call_id: result.tool_call_id,
			output: budgetedResult.content
		} as ResponseInputItem);
		if (budgetedResult.limitReached) {
			limitReached = true;
			reason = budgetedResult.reason ?? createToolResultLimitReason(currentTotalChars + addedChars);
		}
	}
	return {
		addedChars,
		limitReached,
		reason
	};
}

function createRequestBody(
	params: AiChatParams,
	options: ProviderChatOptions,
	instructions: string,
	inputItems: ResponseInputItem[],
	tools?: Tool[] | undefined,
	requireToolCall: boolean = false
): ResponseCreateParamsNonStreaming {
	const requestBody: ResponseCreateParamsNonStreaming = {
		model: resolveOpenAIResponsesModel(options),
		instructions,
		input: inputItems,
		store: false
	};
	if (tools !== undefined && tools.length > 0) {
		requestBody.tools = tools;
		requestBody.parallel_tool_calls = false;
		if (requireToolCall) {
			requestBody.tool_choice = "required";
		}
	}
	applyOpenAIResponsesOptions(requestBody, params);
	return requestBody;
}

async function readResponsesAssistantMessage(
	params: AiChatParams,
	options: ProviderChatOptions,
	instructions: string,
	inputItems: ResponseInputItem[],
	tools: Tool[],
	streamAssistant: boolean,
	requireToolCall: boolean,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined
): Promise<ResponsesAssistantMessage> {
	const client = createOpenAIResponsesClient(options);
	if (!streamAssistant) {
		const response: Response = await client.responses.create(
			createRequestBody(params, options, instructions, inputItems, tools, requireToolCall),
			{ signal: abortSignal }
		);
		return {
			text: response.output_text,
			toolCalls: extractFunctionCalls(response.output),
			outputItems: response.output
		};
	}

	const requestBody: ResponseCreateParamsStreaming = {
		...createRequestBody(params, options, instructions, inputItems, tools, requireToolCall),
		stream: true
	};
	const stream = await client.responses.create(requestBody, { signal: abortSignal });
	const outputItems: ResponseOutputItem[] = [];
	let text = "";
	let completedResponse: Response | null = null;

	for await (const event of stream) {
		const streamEvent: ResponseStreamEvent = event as ResponseStreamEvent;
		if (streamEvent.type === "response.output_text.delta" && streamEvent.delta.length > 0) {
			text += streamEvent.delta;
			onEvent?.({ type: "ai.delta", text: streamEvent.delta });
			continue;
		}
		if (streamEvent.type === "response.output_item.done") {
			outputItems.push(streamEvent.item);
			continue;
		}
		if (streamEvent.type === "response.completed") {
			completedResponse = streamEvent.response;
		}
	}

	return {
		text: completedResponse?.output_text ?? text,
		toolCalls: extractFunctionCalls(outputItems),
		outputItems: outputItems.length > 0 ? outputItems : completedResponse?.output ?? []
	};
}

async function createFinalAnswer(
	params: AiChatParams,
	options: ProviderChatOptions,
	instructions: string,
	inputItems: ResponseInputItem[],
	reason: string,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	const client = createOpenAIResponsesClient(options);
	const finalInstructions: string = `${instructions}\n\n${FINALIZE_AFTER_TOOL_LIMIT_PROMPT}\n\n收束原因：${reason}`;
	const response: Response = await client.responses.create(
		createRequestBody(params, options, finalInstructions, inputItems),
		{ signal: abortSignal }
	);
	if (response.output_text.length === 0) {
		return createToolResultLimitFallback(reason);
	}
	return response.output_text;
}

async function runResponsesAgentLoop(
	params: AiChatParams,
	options: ProviderChatOptions,
	instructions: string,
	inputItems: ResponseInputItem[],
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	chatTools: ChatCompletionTool[],
	startStep: number,
	maxSteps: number,
	initialToolResultChars: number,
	streamAssistant: boolean,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	let totalToolResultChars: number = initialToolResultChars;
	const tools: Tool[] = convertToolDefinitions(chatTools);
	const allowedToolNames: ReadonlySet<string> = getAllowedToolNames(chatTools);

	for (let step: number = startStep; step < maxSteps; step += 1) {
		if (abortSignal?.aborted) {
			throw new Error("Request cancelled");
		}

		const assistantMessage: ResponsesAssistantMessage = await readResponsesAssistantMessage(
			params,
			options,
			instructions,
			inputItems,
			tools,
			streamAssistant,
			shouldRequireToolCallOnStep(params, step, startStep),
			onEvent,
			abortSignal
		);
		const toolCalls: ChatCompletionMessageToolCall[] = convertResponsesToolCalls(assistantMessage.toolCalls, allowedToolNames);

		if (toolCalls.length === 0) {
			if (assistantMessage.text.length === 0) {
				throw new Error("LLM returned empty response");
			}
			return { status: "completed", text: assistantMessage.text };
		}

		if (!streamAssistant && assistantMessage.text.trim().length > 0) {
			onEvent?.({ type: "ai.delta", text: `\n\n${assistantMessage.text.trim()}\n\n` });
		}

		appendResponseOutputItems(inputItems, assistantMessage.outputItems);

		try {
			const toolResults = await dispatchToolCalls(mcpHost, toolCalls, step, gateway, onEvent, toolResultEnricher, toolContext);
			const appendResult: AppendToolResultItemsResult = appendToolResultItems(inputItems, toolResults, totalToolResultChars);
			totalToolResultChars += appendResult.addedChars;
			if (appendResult.limitReached || totalToolResultChars >= MAX_TOTAL_TOOL_RESULT_CHARS) {
				const reason: string = appendResult.reason ?? createToolResultLimitReason(totalToolResultChars);
				const finalText: string = await createFinalAnswer(
					params,
					options,
					instructions,
					inputItems,
					reason,
					abortSignal
				);
				if (streamAssistant) {
					onEvent?.({ type: "ai.delta", text: finalText });
				}
				return { status: "completed", text: finalText };
			}
		} catch (error: unknown) {
			if (error instanceof ToolApprovalRequiredError) {
				const continuationInputItems: ResponseInputItem[] = [...inputItems];
				return {
					status: "approval_required",
					approvalId: error.pendingApproval.approvalId,
					toolName: error.pendingApproval.llmToolName,
					reason: error.pendingApproval.reason,
					continuation: {
						kind: "responses",
						instructions,
						inputItems: continuationInputItems,
						nextStep: step + 1,
						totalToolResultChars
					}
				};
			}

			throw error;
		}

		if (totalToolResultChars >= MAX_TOTAL_TOOL_RESULT_CHARS) {
			const finalText: string = await createFinalAnswer(
				params,
				options,
				instructions,
				inputItems,
				createToolResultLimitReason(totalToolResultChars),
				abortSignal
			);
			if (streamAssistant) {
				onEvent?.({ type: "ai.delta", text: finalText });
			}
			return { status: "completed", text: finalText };
		}
	}

	const finalText: string = await createFinalAnswer(
		params,
		options,
		instructions,
		inputItems,
		`工具调用达到最大步数 ${maxSteps}，当前工具结果总量为 ${totalToolResultChars} 字符`,
		abortSignal
	);
	if (streamAssistant) {
		onEvent?.({ type: "ai.delta", text: finalText });
	}
	return { status: "completed", text: finalText };
}

export async function runOpenAIResponsesAgent(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	instructions: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const maxSteps: number = resolveToolBudget(
		(params.options as Record<string, unknown> | undefined)?.["toolBudget"] as string | undefined,
		params.skillRefs?.[0]
	);

	return runResponsesAgentLoop(
		params,
		options,
		instructions,
		createOpenAIResponseInput(params, history),
		mcpHost,
		gateway,
		tools,
		0,
		maxSteps,
		0,
		false,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext
	);
}

export async function runOpenAIResponsesAgentStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	instructions: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const maxSteps: number = resolveToolBudget(
		(params.options as Record<string, unknown> | undefined)?.["toolBudget"] as string | undefined,
		params.skillRefs?.[0]
	);

	return runResponsesAgentLoop(
		params,
		options,
		instructions,
		createOpenAIResponseInput(params, history),
		mcpHost,
		gateway,
		tools,
		0,
		maxSteps,
		0,
		true,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext
	);
}

export async function continueOpenAIResponsesAgent(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: ResponsesAgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const inputItems: ResponseInputItem[] = [...continuation.inputItems];
	const budgetedResult = fitToolResultContent(approvedToolResult.content, continuation.totalToolResultChars);
	const totalToolResultChars: number = continuation.totalToolResultChars + budgetedResult.chars;
	inputItems.push({
		type: "function_call_output",
		call_id: approvedToolResult.toolCallId,
		output: budgetedResult.content
	} as ResponseInputItem);

	if (budgetedResult.limitReached || totalToolResultChars >= MAX_TOTAL_TOOL_RESULT_CHARS) {
		return {
			status: "completed",
			text: await createFinalAnswer(
				params,
				options,
				continuation.instructions,
				inputItems,
				budgetedResult.reason ?? createToolResultLimitReason(totalToolResultChars),
				abortSignal
			)
		};
	}

	const maxSteps: number = resolveToolBudget(
		(params.options as Record<string, unknown> | undefined)?.["toolBudget"] as string | undefined,
		params.skillRefs?.[0]
	);
	return runResponsesAgentLoop(
		params,
		options,
		continuation.instructions,
		inputItems,
		mcpHost,
		gateway,
		tools,
		continuation.nextStep,
		maxSteps,
		totalToolResultChars,
		false,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext
	);
}

export async function continueOpenAIResponsesAgentStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: ResponsesAgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	const toolCatalog = createWorkspaceToolCatalog(toolContext);
	const tools = allowedToolNames !== undefined
		? toolCatalog.getDefinitionsForNames(allowedToolNames)
		: toolCatalog.getDefinitions();
	const inputItems: ResponseInputItem[] = [...continuation.inputItems];
	const budgetedResult = fitToolResultContent(approvedToolResult.content, continuation.totalToolResultChars);
	const totalToolResultChars: number = continuation.totalToolResultChars + budgetedResult.chars;
	inputItems.push({
		type: "function_call_output",
		call_id: approvedToolResult.toolCallId,
		output: budgetedResult.content
	} as ResponseInputItem);

	if (budgetedResult.limitReached || totalToolResultChars >= MAX_TOTAL_TOOL_RESULT_CHARS) {
		const finalText: string = await createFinalAnswer(
			params,
			options,
			continuation.instructions,
			inputItems,
			budgetedResult.reason ?? createToolResultLimitReason(totalToolResultChars),
			abortSignal
		);
		onEvent?.({ type: "ai.delta", text: finalText });
		return { status: "completed", text: finalText };
	}

	const maxSteps: number = resolveToolBudget(
		(params.options as Record<string, unknown> | undefined)?.["toolBudget"] as string | undefined,
		params.skillRefs?.[0]
	);
	return runResponsesAgentLoop(
		params,
		options,
		continuation.instructions,
		inputItems,
		mcpHost,
		gateway,
		tools,
		continuation.nextStep,
		maxSteps,
		totalToolResultChars,
		true,
		onEvent,
		abortSignal,
		toolResultEnricher,
		toolContext
	);
}
