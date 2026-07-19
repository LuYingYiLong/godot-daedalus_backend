import type { AiChatParams, ChatMessage } from "../protocol/types.js";
import { chatWithDeepSeek, type DeepSeekChatOptions } from "../providers/deepseek-client.js";

const TITLE_MAX_CHARS: number = 28;

function clipText(text: string, maxChars: number): string {
	const normalized: string = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}

	return normalized.slice(0, maxChars);
}

export function shouldApplyGeneratedSessionTitle(originalTitle: string | undefined, currentTitle: string | undefined): boolean {
	return (currentTitle ?? "").trim() === (originalTitle ?? "").trim();
}

export function isFirstSessionUserTurn(messages: readonly ChatMessage[], requestId: string): boolean {
	return !messages.some((message: ChatMessage): boolean => (
		message.role === "user" && message.requestId !== requestId
	));
}

export function normalizeGeneratedSessionTitle(rawTitle: string): string {
	let title: string = rawTitle
		.replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, "")
		.replace(/^标题[:：]\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();
	const newlineIndex: number = title.indexOf("\n");
	if (newlineIndex >= 0) {
		title = title.slice(0, newlineIndex).trim();
	}
	title = title.replace(/[。.!！?？]+$/g, "").trim();
	return clipText(title, TITLE_MAX_CHARS);
}

export function createFallbackSessionTitle(userMessage: string): string {
	const normalized: string = userMessage
		.replace(/\s+/g, " ")
		.replace(/^\/[a-zA-Z0-9_-]+\s*/, "")
		.trim();
	if (normalized.length === 0) {
		return "Untitled";
	}

	return clipText(normalized, TITLE_MAX_CHARS);
}

function isEmptyLlmResponseError(error: unknown): boolean {
	return error instanceof Error && error.message === "LLM returned empty response";
}

export async function generateSessionTitle(
	userMessage: string,
	options: DeepSeekChatOptions,
	abortSignal?: AbortSignal | undefined
): Promise<string> {
	const titlePrompt: string = [
		"你是 Godot Daedalus 的会话命名器。请只输出一个简短会话名，不要解释，不要加引号。",
		"要求：",
		"- 6 到 14 个中文字符，或 2 到 5 个英文单词。",
		"- 准确概括用户目标，不要使用泛称。",
		"- 不要直接复述完整用户输入，优先提炼成名词短语。",
		"- 不要包含标点、编号或表情。"
	].join("\n");
	const params: AiChatParams = {
		message: [
			"请为下面用户刚发送的第一条消息生成会话名。",
			"",
			"用户：",
			clipText(userMessage, 1200)
		].join("\n"),
		options: {
			temperature: 0.2,
			maxTokens: 40,
			workflow: "single"
		}
	};
	let text: string;
	try {
		text = await chatWithDeepSeek(params, options, [] satisfies ChatMessage[], titlePrompt, abortSignal);
	} catch (error: unknown) {
		if (!isEmptyLlmResponseError(error)) {
			throw error;
		}

		return createFallbackSessionTitle(userMessage);
	}
	const title: string = normalizeGeneratedSessionTitle(text);
	return title.length > 0 ? title : createFallbackSessionTitle(userMessage);
}
