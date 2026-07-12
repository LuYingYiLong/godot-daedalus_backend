import type { AdditionalContextItem, ChatMessage } from "../protocol/types.js";
import { createWorkspaceMetadataSnapshot, saveSession } from "../session/session-store.js";
import type { ClientSession } from "./client-session.js";
import { cloneAdditionalContextItems } from "./additional-context.js";

export function isLlmContextMessage(message: ChatMessage): boolean {
	return message.excludeFromLlmContext !== true;
}

export function filterLlmContextMessages(messages: readonly ChatMessage[]): ChatMessage[] {
	return messages.filter(isLlmContextMessage);
}

export async function appendFailedChatTurnToSession(
	session: ClientSession,
	userMessage: string,
	error: { code: string; message: string },
	requestId: string,
	userCreatedAt: string = new Date().toISOString(),
	assistantCreatedAt: string = new Date().toISOString(),
	additionalContext?: readonly AdditionalContextItem[] | undefined,
	assistantMessage: string = ""
): Promise<boolean> {
	if (!session.sessionId) {
		return false;
	}
	if (session.messages.some((message: ChatMessage): boolean => message.requestId === requestId)) {
		return false;
	}

	const userChatMessage: ChatMessage = {
		role: "user",
		content: userMessage,
		requestId,
		createdAt: userCreatedAt,
		excludeFromLlmContext: true
	};
	const clonedAdditionalContext: AdditionalContextItem[] | undefined = cloneAdditionalContextItems(additionalContext);
	if (clonedAdditionalContext !== undefined) {
		userChatMessage.additionalContext = clonedAdditionalContext;
	}

	const assistantChatMessage: ChatMessage = {
		role: "assistant",
		content: assistantMessage,
		requestId,
		createdAt: assistantCreatedAt,
		excludeFromLlmContext: true,
		status: "failed",
		error: {
			code: error.code,
			message: error.message
		}
	};

	session.messages = [
		...session.messages,
		userChatMessage,
		assistantChatMessage
	];
	await saveSession(session.sessionId, session.messages, {
		...createWorkspaceMetadataSnapshot(session.activeWorkspace),
	});
	return true;
}

export async function appendTranscriptOnlyChatTurnToSession(
	session: ClientSession,
	userMessage: string,
	assistantMessage: string,
	requestId: string,
	userCreatedAt: string = new Date().toISOString(),
	assistantCreatedAt: string = new Date().toISOString(),
	additionalContext?: readonly AdditionalContextItem[] | undefined
): Promise<boolean> {
	if (!session.sessionId) {
		return false;
	}
	if (session.messages.some((message: ChatMessage): boolean => message.requestId === requestId)) {
		return false;
	}

	const userChatMessage: ChatMessage = {
		role: "user",
		content: userMessage,
		requestId,
		createdAt: userCreatedAt,
		excludeFromLlmContext: true
	};
	const clonedAdditionalContext: AdditionalContextItem[] | undefined = cloneAdditionalContextItems(additionalContext);
	if (clonedAdditionalContext !== undefined) {
		userChatMessage.additionalContext = clonedAdditionalContext;
	}

	session.messages = [
		...session.messages,
		userChatMessage,
		{
			role: "assistant",
			content: assistantMessage,
			requestId,
			createdAt: assistantCreatedAt,
			excludeFromLlmContext: true
		}
	];
	await saveSession(session.sessionId, session.messages, {
		...createWorkspaceMetadataSnapshot(session.activeWorkspace),
	});
	return true;
}
