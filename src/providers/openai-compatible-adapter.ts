import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { ProviderChatOptions, ProviderModelInfo } from "./provider-types.js";
import {
	chatWithOpenAICompatible,
	streamChatWithOpenAICompatible
} from "./provider-chat-completions-client.js";
import {
	continueOpenAICompatibleAgent,
	continueOpenAICompatibleAgentAfterToolBudget,
	continueOpenAICompatibleAgentAfterToolBudgetStreaming,
	continueOpenAICompatibleAgentStreaming,
	finalizeOpenAICompatibleAgentAfterToolBudget,
	finalizeOpenAICompatibleAgentAfterToolBudgetStreaming,
	runOpenAICompatibleAgent,
	runOpenAICompatibleAgentStreaming
} from "./openai-compatible-agent.js";
import type { AgentContinuation, ChatCompletionsAgentContinuation } from "./agent-types.js";
import { fetchOpenAICompatibleModels } from "./provider-models.js";
import { estimateOpenAICompatibleMessagesTokens } from "./provider-token-estimator.js";

export const openAICompatibleAdapter: ProviderAdapter = {
	adapterFamily: "openai-compatible",
	endpointType: "openai-chat-completions",
	chat: chatWithOpenAICompatible,
	streamChat: streamChatWithOpenAICompatible,
	runAgent: runOpenAICompatibleAgent,
	runAgentStreaming: runOpenAICompatibleAgentStreaming,
	continueAgent: (params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueOpenAICompatibleAgent(params, options, asChatCompletionsContinuation(continuation), approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	continueAgentStreaming: (params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueOpenAICompatibleAgentStreaming(params, options, asChatCompletionsContinuation(continuation), approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	continueAgentAfterToolBudget: (params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueOpenAICompatibleAgentAfterToolBudget(params, options, asChatCompletionsContinuation(continuation), mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	continueAgentAfterToolBudgetStreaming: (params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueOpenAICompatibleAgentAfterToolBudgetStreaming(params, options, asChatCompletionsContinuation(continuation), mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	finalizeAgentAfterToolBudget: (params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext) =>
		finalizeOpenAICompatibleAgentAfterToolBudget(params, options, asChatCompletionsContinuation(continuation), allowedToolNames, reason, onEvent, abortSignal, toolContext),
	finalizeAgentAfterToolBudgetStreaming: (params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext) =>
		finalizeOpenAICompatibleAgentAfterToolBudgetStreaming(params, options, asChatCompletionsContinuation(continuation), allowedToolNames, reason, onEvent, abortSignal, toolContext),
	listModels: async (options: ProviderChatOptions): Promise<ProviderModelInfo[]> => fetchOpenAICompatibleModels(options),
	estimateMessagesTokens: (options: ProviderChatOptions, messages: ChatCompletionMessageParam[], abortSignal?: AbortSignal | undefined): Promise<number | null> =>
		estimateOpenAICompatibleMessagesTokens(options, messages, abortSignal)
};

function asChatCompletionsContinuation(continuation: AgentContinuation): ChatCompletionsAgentContinuation {
	if (continuation.kind === "responses") {
		throw new Error("Responses continuation cannot be handled by the OpenAI-compatible adapter.");
	}
	if (continuation.kind === "anthropic_messages") {
		throw new Error("Anthropic Messages continuation cannot be handled by the OpenAI-compatible adapter.");
	}
	return continuation;
}
