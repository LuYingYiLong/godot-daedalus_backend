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
	continueAnthropicCompatibleAgentStreaming,
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
	listModels: async (options: ProviderChatOptions): Promise<ProviderModelInfo[]> => fetchOpenAICompatibleModels(options)
};

function asAnthropicMessagesContinuation(continuation: AgentContinuation): AnthropicMessagesAgentContinuation {
	if (continuation.kind !== "anthropic_messages") {
		throw new Error("Only Anthropic Messages continuations can be handled by the Anthropic-compatible adapter.");
	}
	return continuation;
}
