import type { ProviderAdapter } from "./provider-adapter.js";
import type { AgentContinuation, AnthropicMessagesAgentContinuation } from "./agent-types.js";
import type { ProviderChatOptions, ProviderModelInfo } from "./provider-types.js";
import { fetchOpenAICompatibleModels } from "./provider-models.js";
import {
	chatWithAnthropicCompatible,
	streamChatWithAnthropicCompatible
} from "./anthropic-compatible-client.js";
import {
	continueAnthropicCompatibleAgent,
	continueAnthropicCompatibleAgentAfterToolBudget,
	continueAnthropicCompatibleAgentAfterToolBudgetStreaming,
	continueAnthropicCompatibleAgentStreaming,
	finalizeAnthropicCompatibleAgentAfterToolBudget,
	finalizeAnthropicCompatibleAgentAfterToolBudgetStreaming,
	runAnthropicCompatibleAgent,
	runAnthropicCompatibleAgentStreaming
} from "./anthropic-compatible-agent.js";

export const anthropicCompatibleAdapter: ProviderAdapter = {
	adapterFamily: "anthropic-compatible",
	endpointType: "anthropic-messages",
	chat: chatWithAnthropicCompatible,
	streamChat: streamChatWithAnthropicCompatible,
	runAgent: runAnthropicCompatibleAgent,
	runAgentStreaming: runAnthropicCompatibleAgentStreaming,
	continueAgent: (params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueAnthropicCompatibleAgent(params, options, asAnthropicMessagesContinuation(continuation), approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	continueAgentStreaming: (params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueAnthropicCompatibleAgentStreaming(params, options, asAnthropicMessagesContinuation(continuation), approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	continueAgentAfterToolBudget: (params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueAnthropicCompatibleAgentAfterToolBudget(params, options, asAnthropicMessagesContinuation(continuation), mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	continueAgentAfterToolBudgetStreaming: (params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueAnthropicCompatibleAgentAfterToolBudgetStreaming(params, options, asAnthropicMessagesContinuation(continuation), mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	finalizeAgentAfterToolBudget: (params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext) =>
		finalizeAnthropicCompatibleAgentAfterToolBudget(params, options, asAnthropicMessagesContinuation(continuation), allowedToolNames, reason, onEvent, abortSignal, toolContext),
	finalizeAgentAfterToolBudgetStreaming: (params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext) =>
		finalizeAnthropicCompatibleAgentAfterToolBudgetStreaming(params, options, asAnthropicMessagesContinuation(continuation), allowedToolNames, reason, onEvent, abortSignal, toolContext),
	listModels: async (options: ProviderChatOptions): Promise<ProviderModelInfo[]> => fetchOpenAICompatibleModels(options)
};

function asAnthropicMessagesContinuation(continuation: AgentContinuation): AnthropicMessagesAgentContinuation {
	if (continuation.kind !== "anthropic_messages") {
		throw new Error("Only Anthropic Messages continuations can be handled by the Anthropic-compatible adapter.");
	}
	return continuation;
}
