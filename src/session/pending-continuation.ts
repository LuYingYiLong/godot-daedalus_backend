import type { AiChatParams } from "../protocol/types.js";
import type { AgentContinuation } from "../providers/agent-types.js";
import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import type { WorkflowRunState } from "../workflow/types.js";

export type PendingAiContinuation = {
	params: AiChatParams;
	options: ProviderChatOptions;
	continuation: AgentContinuation;
	allowedToolNames?: readonly string[] | undefined;
	userMessage: string;
	requestId: string;
	userCreatedAt: string;
	stream: boolean;
	agentRunState?: WorkflowRunState | undefined;
	workflowState?: WorkflowRunState | undefined;
};
