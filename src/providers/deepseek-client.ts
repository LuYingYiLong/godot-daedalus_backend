import OpenAI from "openai";
import type {
	ChatCompletionChunk,
	ChatCompletionCreateParamsBase,
	ChatCompletionCreateParamsNonStreaming,
	ChatCompletionCreateParamsStreaming,
	ChatCompletionMessageParam
} from "openai/resources/chat/completions";
import type { AiChatParams, ChatMessage } from "../protocol/types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

export type DeepSeekChatOptions = {
	apiKey: string;
	baseUrl?: string | undefined;
	model?: string | undefined;
};

function createDeepSeekClient(options: DeepSeekChatOptions): OpenAI {
	return new OpenAI({
		baseURL: options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
		apiKey: options.apiKey
	});
}

function createMessages(params: AiChatParams, history: ChatMessage[]): ChatCompletionMessageParam[] {
	const systemPrompt: string = params.systemPrompt ?? "You are a helpful assistant.";
	return [
		{
			role: "system",
			content: systemPrompt,
		},
		...history.map((message: ChatMessage): ChatCompletionMessageParam => ({
			role: message.role,
			content: message.content
		})),
		{
			role: "user",
			content: params.message,
		}
	];
}

function applyChatOptions(requestBody: ChatCompletionCreateParamsBase, params: AiChatParams): void {
	if (params.options?.temperature !== undefined) {
		requestBody.temperature = params.options.temperature;
	}

	if (params.options?.topP !== undefined) {
		requestBody.top_p = params.options.topP;
	}

	if (params.options?.maxTokens !== undefined) {
		requestBody.max_tokens = params.options.maxTokens;
	}

	if (params.options?.stop !== undefined) {
		requestBody.stop = params.options.stop;
	}

	if (params.options?.responseFormat === "json") {
		requestBody.response_format = { type: "json_object" };
	}
}

export async function chatWithDeepSeek(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	history: ChatMessage[]
): Promise<string> {
	const client: OpenAI = createDeepSeekClient(options);
	const requestBody: ChatCompletionCreateParamsNonStreaming = {
		model: options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
		messages: createMessages(params, history)
	};

	applyChatOptions(requestBody, params);

	const completion = await client.chat.completions.create(requestBody);

	const text: string | null | undefined = completion.choices[0]?.message.content;
	if (!text) {
		throw new Error("LLM returned empty response");
	}

	return text;
}

export async function* streamChatWithDeepSeek(
	params: AiChatParams,
	options: DeepSeekChatOptions,
	history: ChatMessage[]
): AsyncGenerator<string> {
	const client: OpenAI = createDeepSeekClient(options);
	const requestBody: ChatCompletionCreateParamsStreaming = {
		model: options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
		messages: createMessages(params, history),
		stream: true
	};

	applyChatOptions(requestBody, params);

	const stream = await client.chat.completions.create(requestBody);
	for await (const chunk of stream) {
		const delta: string | null | undefined = (chunk as ChatCompletionChunk).choices[0]?.delta.content;
		if (delta !== undefined && delta !== null && delta.length > 0) {
			yield delta;
		}
	}
}
