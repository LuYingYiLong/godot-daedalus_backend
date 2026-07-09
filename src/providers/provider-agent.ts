import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import type { ApprovalGateway } from "../tools/approval-gateway.js";
import type { OnToolEvent, ToolResultEnricher } from "../tools/tool-dispatcher.js";
import {
	continueDeepSeekAgent,
	continueDeepSeekAgentStreaming,
	runDeepSeekAgent,
	runDeepSeekAgentStreaming
} from "./deepseek-agent.js";
import {
	continueOpenAIResponsesAgent,
	continueOpenAIResponsesAgentStreaming,
	runOpenAIResponsesAgent,
	runOpenAIResponsesAgentStreaming
} from "./openai-responses-agent.js";
import type { AgentContinuation, ApprovedToolResult, ProviderAgentResult, ResponsesAgentContinuation } from "./agent-types.js";
import type { ProviderChatOptions } from "./deepseek-client.js";

export async function runProviderAgent(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined
): Promise<ProviderAgentResult> {
	if (options.provider === "openai") {
		return runOpenAIResponsesAgent(params, options, history, systemPrompt, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher);
	}

	return runDeepSeekAgent(params, options, history, systemPrompt, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher);
}

export async function runProviderAgentStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	history: ChatMessage[],
	systemPrompt: string,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolResultEnricher?: ToolResultEnricher | undefined
): Promise<ProviderAgentResult> {
	if (options.provider === "openai") {
		return runOpenAIResponsesAgentStreaming(params, options, history, systemPrompt, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher);
	}

	return runDeepSeekAgentStreaming(params, options, history, systemPrompt, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher);
}

export async function continueProviderAgent(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined
): Promise<ProviderAgentResult> {
	if (continuation.kind === "responses") {
		return continueOpenAIResponsesAgent(params, options, continuation as ResponsesAgentContinuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal);
	}

	return continueDeepSeekAgent(params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal);
}

export async function continueProviderAgentStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	approvedToolResult: ApprovedToolResult,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined
): Promise<ProviderAgentResult> {
	if (continuation.kind === "responses") {
		return continueOpenAIResponsesAgentStreaming(params, options, continuation as ResponsesAgentContinuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal);
	}

	return continueDeepSeekAgentStreaming(params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal);
}
