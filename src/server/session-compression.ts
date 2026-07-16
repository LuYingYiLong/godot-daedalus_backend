import type { ChatMessage } from "../protocol/types.js";
import { createDeepSeekClient, resolveChatModel } from "../providers/deepseek-client.js";
import { writeSummary, type SessionSummary } from "../session/session-store.js";
import type { ClientSession } from "./client-session.js";
import { createProviderChatOptions } from "./provider-chat-options.js";
import { createSummaryMessage, filterLlmContextMessages, loadSessionCompressorPrompt } from "./token-budget.js";

export type SessionCompressionResult =
	| {
		compressed: true;
		oldMessageCount: number;
		keptMessageCount: number;
		summaryLength: number;
	}
	| {
		compressed: false;
		reason: string;
		messageCount: number;
	};

export async function compressSessionHistory(
	session: ClientSession,
	apiKey: string,
	keepRecent: number = 8
): Promise<SessionCompressionResult> {
	if (!session.sessionId) {
		return { compressed: false, reason: "No active session", messageCount: session.messages.length };
	}

	const allMessages: ChatMessage[] = session.messages;
	if (allMessages.length <= keepRecent) {
		return { compressed: false, reason: "Not enough messages", messageCount: allMessages.length };
	}

	const oldMessages: ChatMessage[] = allMessages.slice(0, allMessages.length - keepRecent);
	const recentMessages: ChatMessage[] = allMessages.slice(allMessages.length - keepRecent);
	const conversationText: string = filterLlmContextMessages(oldMessages)
		.map((message: ChatMessage): string => `${message.role}: ${message.content.slice(0, 300)}`)
		.join("\n");
	const compressorOptions = createProviderChatOptions(session, apiKey);
	const client = createDeepSeekClient(compressorOptions);
	const compressorPrompt: string = await loadSessionCompressorPrompt();
	const completion = await client.chat.completions.create({
		model: resolveChatModel(compressorOptions),
		messages: [
			{
				role: "system",
				content: compressorPrompt
			},
			{ role: "user", content: conversationText }
		],
		max_tokens: 800
	});
	const summaryContent: string = completion.choices[0]?.message?.content ?? "(empty summary)";
	const summaryObj: SessionSummary = {
		content: summaryContent,
		messageCount: oldMessages.length,
		tokenEstimate: Math.ceil(conversationText.length / 3),
		generatedAt: new Date().toISOString()
	};

	await writeSummary(session.sessionId, summaryObj);
	session.summaryMessage = createSummaryMessage(summaryObj);
	session.summaryCoveredMessageCount = summaryObj.messageCount;
	session.messages = allMessages;

	return {
		compressed: true,
		oldMessageCount: oldMessages.length,
		keptMessageCount: recentMessages.length,
		summaryLength: summaryContent.length
	};
}
