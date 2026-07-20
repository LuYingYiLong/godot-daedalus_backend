import type { ProviderAdapter } from "./provider-adapter.js";
import type { ProviderChatOptions, ProviderModelInfo } from "./provider-types.js";
import {
	chatWithOpenAIResponses,
	streamChatWithOpenAIResponses
} from "./openai-responses-client.js";
import {
	continueOpenAIResponsesAgent,
	continueOpenAIResponsesAgentAfterToolBudget,
	continueOpenAIResponsesAgentAfterToolBudgetStreaming,
	continueOpenAIResponsesAgentStreaming,
	finalizeOpenAIResponsesAgentAfterToolBudget,
	finalizeOpenAIResponsesAgentAfterToolBudgetStreaming,
	runOpenAIResponsesAgent,
	runOpenAIResponsesAgentStreaming
} from "./openai-responses-agent.js";
import type { AgentContinuation, ResponsesAgentContinuation } from "./agent-types.js";
import { fetchOpenAICompatibleModels } from "./provider-models.js";

export const openAIResponsesAdapter: ProviderAdapter = {
	adapterFamily: "openai-responses",
	endpointType: "openai-responses",
	chat: chatWithOpenAIResponses,
	streamChat: streamChatWithOpenAIResponses,
	runAgent: runOpenAIResponsesAgent,
	runAgentStreaming: runOpenAIResponsesAgentStreaming,
	continueAgent: (params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueOpenAIResponsesAgent(params, options, asResponsesContinuation(continuation), approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	continueAgentStreaming: (params, options, continuation, approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueOpenAIResponsesAgentStreaming(params, options, asResponsesContinuation(continuation), approvedToolResult, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	continueAgentAfterToolBudget: (params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueOpenAIResponsesAgentAfterToolBudget(params, options, asResponsesContinuation(continuation), mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	continueAgentAfterToolBudgetStreaming: (params, options, continuation, mcpHost, gateway, allowedToolNames, onEvent, abortSignal, toolContext) =>
		continueOpenAIResponsesAgentAfterToolBudgetStreaming(params, options, asResponsesContinuation(continuation), mcpHost, gateway, allowedToolNames, onEvent, abortSignal, undefined, toolContext),
	finalizeAgentAfterToolBudget: (params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext) =>
		finalizeOpenAIResponsesAgentAfterToolBudget(params, options, asResponsesContinuation(continuation), allowedToolNames, reason, onEvent, abortSignal, toolContext),
	finalizeAgentAfterToolBudgetStreaming: (params, options, continuation, allowedToolNames, reason, onEvent, abortSignal, toolContext) =>
		finalizeOpenAIResponsesAgentAfterToolBudgetStreaming(params, options, asResponsesContinuation(continuation), allowedToolNames, reason, onEvent, abortSignal, toolContext),
	listModels: async (options: ProviderChatOptions): Promise<ProviderModelInfo[]> => fetchOpenAICompatibleModels(options)
};

function asResponsesContinuation(continuation: AgentContinuation): ResponsesAgentContinuation {
	if (continuation.kind !== "responses") {
		throw new Error("Chat Completions continuation cannot be handled by the Responses adapter.");
	}
	return continuation;
}
