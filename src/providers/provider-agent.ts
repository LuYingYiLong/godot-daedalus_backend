import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import type { McpHost } from "../mcp/mcp-host.js";
import type { ApprovalGateway } from "../tools/approval-gateway.js";
import type { OnToolEvent, ToolResultEnricher } from "../tools/tool-dispatcher.js";
import type { AgentContinuation, ApprovedToolResult, ProviderAgentResult } from "./agent-types.js";
import type { ProviderChatOptions } from "./provider-types.js";
import { WorkspaceToolCatalog, type ToolExecutionContext } from "../tools/tool-catalog.js";
import { resolveProviderAdapter } from "./provider-adapter.js";
import "./provider-adapters.js";
import { resolveImageGenerationAvailability, type ImageGenerationAvailability } from "./image-generation.js";

const IMAGE_GENERATION_TOOL_NAME: string = "mcp_image_generate";
const IMAGE_AVAILABILITY_CACHE_TTL_MS: number = 5 * 60 * 1000;
const imageAvailabilityByRequestId: Map<string, { value: ImageGenerationAvailability; expiresAt: number }> = new Map();

async function getImageGenerationAvailability(toolContext?: ToolExecutionContext | undefined): Promise<ImageGenerationAvailability> {
	const requestId: string | undefined = toolContext?.requestId;
	const cached = requestId === undefined ? undefined : imageAvailabilityByRequestId.get(requestId);
	if (cached !== undefined && cached.expiresAt > Date.now()) {
		return cached.value;
	}
	const value: ImageGenerationAvailability = await resolveImageGenerationAvailability();
	if (requestId !== undefined) {
		if (imageAvailabilityByRequestId.size > 500) {
			for (const [cachedRequestId, item] of imageAvailabilityByRequestId) {
				if (item.expiresAt <= Date.now()) {
					imageAvailabilityByRequestId.delete(cachedRequestId);
				}
			}
		}
		imageAvailabilityByRequestId.set(requestId, {
			value,
			expiresAt: Date.now() + IMAGE_AVAILABILITY_CACHE_TTL_MS
		});
	}
	return value;
}

async function prepareToolAvailability(
	allowedToolNames: readonly string[] | undefined,
	systemPrompt: string,
	toolContext?: ToolExecutionContext | undefined
): Promise<{ allowedToolNames: readonly string[] | undefined; systemPrompt: string }> {
	const includesImageGeneration: boolean = allowedToolNames === undefined
		|| allowedToolNames.includes(IMAGE_GENERATION_TOOL_NAME);
	if (!includesImageGeneration) {
		return { allowedToolNames, systemPrompt };
	}
	const availability: ImageGenerationAvailability = await getImageGenerationAvailability(toolContext);
	if (availability.available) {
		return { allowedToolNames, systemPrompt };
	}
	const effectiveNames: string[] = (allowedToolNames ?? new WorkspaceToolCatalog(toolContext).getEntries().map((entry): string => entry.id))
		.filter((toolName: string): boolean => toolName !== IMAGE_GENERATION_TOOL_NAME);
	return {
		allowedToolNames: effectiveNames,
		systemPrompt: `${systemPrompt}\n\nRuntime capability note: image generation is unavailable for this run and mcp_image_generate is not exposed. Reason: ${availability.reason ?? "not configured"}`
	};
}

async function filterContinuationTools(
	allowedToolNames: readonly string[] | undefined,
	toolContext?: ToolExecutionContext | undefined
): Promise<readonly string[] | undefined> {
	return (await prepareToolAvailability(allowedToolNames, "", toolContext)).allowedToolNames;
}

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
	const prepared = await prepareToolAvailability(allowedToolNames, systemPrompt, toolContext);
	return resolveProviderAdapter(options).runAgent(params, options, history, prepared.systemPrompt, mcpHost, gateway, prepared.allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext);
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
	const prepared = await prepareToolAvailability(allowedToolNames, systemPrompt, toolContext);
	return resolveProviderAdapter(options).runAgentStreaming(params, options, history, prepared.systemPrompt, mcpHost, gateway, prepared.allowedToolNames, onEvent, abortSignal, toolResultEnricher, toolContext);
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
	return resolveProviderAdapter(options).continueAgent(params, options, continuation, approvedToolResult, mcpHost, gateway, await filterContinuationTools(allowedToolNames, toolContext), onEvent, abortSignal, toolContext);
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
	return resolveProviderAdapter(options).continueAgentStreaming(params, options, continuation, approvedToolResult, mcpHost, gateway, await filterContinuationTools(allowedToolNames, toolContext), onEvent, abortSignal, toolContext);
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
	return resolveProviderAdapter(options).continueAgentAfterToolBudget(params, options, continuation, mcpHost, gateway, await filterContinuationTools(allowedToolNames, toolContext), onEvent, abortSignal, toolContext);
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
	return resolveProviderAdapter(options).continueAgentAfterToolBudgetStreaming(params, options, continuation, mcpHost, gateway, await filterContinuationTools(allowedToolNames, toolContext), onEvent, abortSignal, toolContext);
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
