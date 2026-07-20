import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import type { ApprovalGateway } from "../tools/approval-gateway.js";
import type { OnToolEvent, ToolResultEnricher } from "../tools/tool-dispatcher.js";
import type { ToolExecutionContext } from "../tools/tool-catalog.js";
import type { AgentContinuation, ApprovedToolResult, ProviderAgentResult } from "./agent-types.js";
import type { AdapterFamily, EndpointType, ProviderChatOptions, ProviderModelInfo } from "./provider-types.js";
import { getProviderAdapterFamily, getProviderDefaultEndpointType } from "./provider-registry.js";

export type ProviderAdapterKey = `${AdapterFamily}:${EndpointType}`;

export type ProviderAdapter = {
	adapterFamily: AdapterFamily;
	endpointType: EndpointType;
	chat: (
		params: AiChatParams,
		options: ProviderChatOptions,
		history: ChatMessage[],
		systemPrompt: string,
		abortSignal?: AbortSignal | undefined
	) => Promise<string>;
	streamChat: (
		params: AiChatParams,
		options: ProviderChatOptions,
		history: ChatMessage[],
		systemPrompt: string,
		abortSignal?: AbortSignal | undefined
	) => AsyncGenerator<string>;
	runAgent: (
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
	) => Promise<ProviderAgentResult>;
	runAgentStreaming: (
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
	) => Promise<ProviderAgentResult>;
	continueAgent: (
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
	) => Promise<ProviderAgentResult>;
	continueAgentStreaming: (
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
	) => Promise<ProviderAgentResult>;
	continueAgentAfterToolBudget: (
		params: AiChatParams,
		options: ProviderChatOptions,
		continuation: AgentContinuation,
		mcpHost: McpHost,
		gateway: ApprovalGateway,
		allowedToolNames?: readonly string[] | undefined,
		onEvent?: OnToolEvent,
		abortSignal?: AbortSignal | undefined,
		toolContext?: ToolExecutionContext | undefined
	) => Promise<ProviderAgentResult>;
	continueAgentAfterToolBudgetStreaming: (
		params: AiChatParams,
		options: ProviderChatOptions,
		continuation: AgentContinuation,
		mcpHost: McpHost,
		gateway: ApprovalGateway,
		allowedToolNames?: readonly string[] | undefined,
		onEvent?: OnToolEvent,
		abortSignal?: AbortSignal | undefined,
		toolContext?: ToolExecutionContext | undefined
	) => Promise<ProviderAgentResult>;
	finalizeAgentAfterToolBudget: (
		params: AiChatParams,
		options: ProviderChatOptions,
		continuation: AgentContinuation,
		allowedToolNames: readonly string[] | undefined,
		reason: string,
		onEvent?: OnToolEvent,
		abortSignal?: AbortSignal | undefined,
		toolContext?: ToolExecutionContext | undefined
	) => Promise<ProviderAgentResult>;
	finalizeAgentAfterToolBudgetStreaming: (
		params: AiChatParams,
		options: ProviderChatOptions,
		continuation: AgentContinuation,
		allowedToolNames: readonly string[] | undefined,
		reason: string,
		onEvent?: OnToolEvent,
		abortSignal?: AbortSignal | undefined,
		toolContext?: ToolExecutionContext | undefined
	) => Promise<ProviderAgentResult>;
	listModels: (
		options: ProviderChatOptions,
		refresh?: boolean | undefined
	) => Promise<ProviderModelInfo[]>;
	estimateMessagesTokens?: (
		options: ProviderChatOptions,
		messages: ChatCompletionMessageParam[],
		abortSignal?: AbortSignal | undefined
	) => Promise<number | null>;
};

const adapters: Map<ProviderAdapterKey, ProviderAdapter> = new Map();

function createAdapterKey(adapterFamily: AdapterFamily, endpointType: EndpointType): ProviderAdapterKey {
	return `${adapterFamily}:${endpointType}`;
}

export function registerProviderAdapter(adapter: ProviderAdapter): void {
	adapters.set(createAdapterKey(adapter.adapterFamily, adapter.endpointType), adapter);
}

export function resolveProviderEndpointType(options: ProviderChatOptions): EndpointType {
	return options.endpointType ?? getProviderDefaultEndpointType(options.provider);
}

export function resolveProviderAdapterFamily(options: ProviderChatOptions): AdapterFamily {
	const endpointType: EndpointType = resolveProviderEndpointType(options);
	return options.adapterFamily ?? getProviderAdapterFamily(options.provider, endpointType);
}

export function resolveProviderAdapter(options: ProviderChatOptions): ProviderAdapter {
	const endpointType: EndpointType = resolveProviderEndpointType(options);
	const adapterFamily: AdapterFamily = resolveProviderAdapterFamily(options);
	const adapter: ProviderAdapter | undefined = adapters.get(createAdapterKey(adapterFamily, endpointType));
	if (adapter === undefined) {
		throw new Error(`No provider adapter registered for ${adapterFamily}/${endpointType}`);
	}
	return adapter;
}
