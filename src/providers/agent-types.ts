import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { AnthropicMessageParam } from "./anthropic-compatible-client.js";

export type ChatCompletionsAgentContinuation = {
	kind?: "chat_completions";
	messages: ChatCompletionMessageParam[];
	nextStep: number;
	totalToolResultChars: number;
};

export type ResponsesAgentContinuation = {
	kind: "responses";
	instructions: string;
	inputItems: ResponseInputItem[];
	nextStep: number;
	totalToolResultChars: number;
};

export type AnthropicMessagesAgentContinuation = {
	kind: "anthropic_messages";
	systemPrompt: string;
	messages: AnthropicMessageParam[];
	nextStep: number;
	totalToolResultChars: number;
};

export type AgentContinuation = ChatCompletionsAgentContinuation | ResponsesAgentContinuation | AnthropicMessagesAgentContinuation;

export type ProviderAgentResult =
	| { status: "completed"; text: string }
	| { status: "protocol_violation"; text: string; reason: string }
	| {
		status: "approval_required";
		approvalId: string;
		toolName: string;
		reason: string;
		continuation: AgentContinuation;
	};

export type ApprovedToolResult = {
	toolCallId: string;
	content: string;
};
