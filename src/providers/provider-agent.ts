import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import type { ApprovalGateway } from "../tools/approval-gateway.js";
import type { OnToolEvent, ToolResultEnricher } from "../tools/tool-dispatcher.js";
import type { AgentContinuation, ApprovedToolResult, ProviderAgentResult } from "./agent-types.js";
import type { ProviderChatOptions } from "./provider-types.js";
import type { ToolExecutionContext } from "../tools/tool-catalog.js";
import { resolveProviderAdapter } from "./provider-adapter.js";
import "./provider-adapters.js";

function assertContinuationMatchesAdapter(options: ProviderChatOptions, continuation: AgentContinuation): void {
	const adapter = resolveProviderAdapter(options);
	const continuationKind: string = continuation.kind ?? "chat_completions";
	if (continuationKind === "responses" && adapter.adapterFamily !== "openai-responses") {
		throw new Error("Responses continuation cannot resume on a non-Responses provider adapter.");
	}
	if (continuationKind === "chat_completions" && adapter.adapterFamily !== "openai-compatible") {
		throw new Error("Chat Completions continuation cannot resume on a non-Chat-Completions provider adapter.");
	}
	if (continuationKind === "anthropic_messages" && adapter.adapterFamily !== "anthropic-compatible") {
		throw new Error("Anthropic Messages continuation cannot resume on a non-Anthropic provider adapter.");
	}
}

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
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	return resolveProviderAdapter(options).runAgent(params, options, history, systemPrompt, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext);
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
	toolResultEnricher?: ToolResultEnricher | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	return resolveProviderAdapter(options).runAgentStreaming(params, options, history, systemPrompt, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext);
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
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	return resolveProviderAdapter(options).continueAgent(params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext);
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
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	return resolveProviderAdapter(options).continueAgentStreaming(params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext);
}

export async function continueProviderAgentAfterToolBudget(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	return resolveProviderAdapter(options).continueAgentAfterToolBudget(params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext);
}

export async function continueProviderAgentAfterToolBudgetStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	mcpHost: McpHost,
	gateway: ApprovalGateway,
	allowedToolNames?: readonly string[] | undefined,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	return resolveProviderAdapter(options).continueAgentAfterToolBudgetStreaming(params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext);
}

export async function finalizeProviderAgentAfterToolBudget(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	allowedToolNames: readonly string[] | undefined,
	reason: string,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	return resolveProviderAdapter(options).finalizeAgentAfterToolBudget(params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext);
}

export async function finalizeProviderAgentAfterToolBudgetStreaming(
	params: AiChatParams,
	options: ProviderChatOptions,
	continuation: AgentContinuation,
	allowedToolNames: readonly string[] | undefined,
	reason: string,
	onEvent?: OnToolEvent,
	abortSignal?: AbortSignal | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<ProviderAgentResult> {
	assertContinuationMatchesAdapter(options, continuation);
	return resolveProviderAdapter(options).finalizeAgentAfterToolBudgetStreaming(params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext);
}
