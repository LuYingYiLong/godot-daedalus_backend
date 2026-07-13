import type { AdditionalContextItem, ChatMessage } from "../protocol/types.js";
import { createWorkspaceMetadataSnapshot, saveSession } from "../session/session-store.js";
import type { ClientSession } from "./client-session.js";
import { cloneAdditionalContextItems } from "./additional-context.js";

function containsRuntimeModeSelfDiagnosis(content: string): boolean {
	const normalizedContent: string = content.trim();
	if (normalizedContent.length === 0) {
		return false;
	}

	const assertsCurrentMode: boolean = /(当前|现在|目前|本轮|本次|此会话|会话).{0,24}(是|处于|属于|运行在).{0,12}(Ask|Agent|Plan|ask|agent|plan).{0,8}模式/u.test(normalizedContent);
	const infersModeFromTools: boolean = /(工具列表|可用工具|只读工具|没有任何写操作工具|没有写工具)/u.test(normalizedContent);
	return assertsCurrentMode && infersModeFromTools;
}

export function isRuntimeModeSelfDiagnosisMessage(message: ChatMessage): boolean {
	return message.role === "assistant" && containsRuntimeModeSelfDiagnosis(message.content);
}

export function isLlmContextMessage(message: ChatMessage): boolean {
	if (message.excludeFromLlmContext === true) {
		return false;
	}
	// 会话模式是本轮运行时事实，旧的助手自诊断不能参与后续推理。
	return !isRuntimeModeSelfDiagnosisMessage(message);
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
