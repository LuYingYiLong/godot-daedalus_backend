import type { ChatMessage, ModelProfile } from "../protocol/types.js";
import type { TokenCounter } from "../tokens/token-counter.js";

const MIN_RECENT_MESSAGES: number = 4;

export type SessionCompressionParams = {
	profile: ModelProfile;
	outputReserveTokens: number;
	systemPromptTokens: number;
	mcpContextTokens: number;
	toolDefinitionsTokens: number;
	currentMessageTokens: number;
	tokenCounter: TokenCounter;
};

export async function computeInputBudget(params: SessionCompressionParams): Promise<number> {
	const { profile, outputReserveTokens, systemPromptTokens, mcpContextTokens, toolDefinitionsTokens, currentMessageTokens } = params;
	const fixedOverhead: number = systemPromptTokens + mcpContextTokens + toolDefinitionsTokens + currentMessageTokens;

	return Math.max(0, profile.contextWindowTokens - outputReserveTokens - profile.safetyMarginTokens - fixedOverhead);
}

export async function selectMessagesWithinBudget(
	messages: ChatMessage[],
	budgetTokens: number,
	tokenCounter: TokenCounter
): Promise<ChatMessage[]> {
	if (messages.length === 0) {
		return [];
	}

	const selected: ChatMessage[] = [];
	let usedTokens: number = 0;

	for (let index: number = messages.length - 1; index >= 0; index -= 1) {
		const message: ChatMessage | undefined = messages[index];
		if (message === undefined) {
			continue;
		}

		const messageTokens: number = await tokenCounter.countText(message.content) + 4;

		if (usedTokens + messageTokens > budgetTokens) {
			if (selected.length >= MIN_RECENT_MESSAGES) {
				break;
			}
		}

		selected.unshift(message);
		usedTokens += messageTokens;
	}

	return selected;
}

export function summarizeMessagesAsSummary(messages: ChatMessage[]): string {
	const turns: string[] = [];

	for (const message of messages) {
		const roleLabel: string = message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : "系统";
		const truncated: string = message.content.length > 200
			? message.content.slice(0, 200) + "..."
			: message.content;
		turns.push(`${roleLabel}: ${truncated}`);
	}

	return turns.join("\n");
}
