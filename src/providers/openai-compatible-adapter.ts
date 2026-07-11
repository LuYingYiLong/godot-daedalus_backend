import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { ProviderChatOptions, ProviderModelInfo } from "./provider-types.js";
import {
	chatWithOpenAICompatible,
	streamChatWithOpenAICompatible
} from "./provider-chat-completions-client.js";
import {
	continueDeepSeekAgent,
	continueDeepSeekAgentStreaming,
	runDeepSeekAgent,
	runDeepSeekAgentStreaming
} from "./deepseek-agent.js";
import type { AgentContinuation, ChatCompletionsAgentContinuation } from "./agent-types.js";
import { fetchOpenAICompatibleModels } from "./provider-models.js";
import { estimateOpenAICompatibleMessagesTokens } from "./provider-token-estimator.js";

export const openAICompatibleAdapter: ProviderAdapter = {
	adapterFamily: "openai-compatible",
	endpointType: "openai-chat-completions",
	chat: chatWithOpenAICompatible,
	streamChat: streamChatWithOpenAICompatible,
	runAgent: runDeepSeekAgent,
	runAgentStreaming: runDeepSeekAgentStreaming,
	continueAgent: (params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueDeepSeekAgent(params, options, asChatCompletionsContinuation(continuation), approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	continueAgentStreaming: (params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueDeepSeekAgentStreaming(params, options, asChatCompletionsContinuation(continuation), approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	listModels: async (options: ProviderChatOptions): Promise<ProviderModelInfo[]> => fetchOpenAICompatibleModels(options),
	estimateMessagesTokens: (options: ProviderChatOptions, messages: ChatCompletionMessageParam[], abortSignal?: AbortSignal | undefined): Promise<number | null> =>
		estimateOpenAICompatibleMessagesTokens(options, messages, abortSignal)
};

function asChatCompletionsContinuation(continuation: AgentContinuation): ChatCompletionsAgentContinuation {
	if (continuation.kind === "responses") {
		throw new Error("Responses continuation cannot be handled by the OpenAI-compatible adapter.");
	}
	return continuation;
}
