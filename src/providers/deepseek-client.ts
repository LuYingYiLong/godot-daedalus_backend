import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { AiChatParams } from "../protocol/types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

export type DeepSeekChatOptions = {
	apiKey: string;
	baseUrl?: string | undefined;
	model?: string | undefined;
};

export async function chatWithDeepSeek(params: AiChatParams, options: DeepSeekChatOptions): Promise<string> {
	const client: OpenAI = new OpenAI({
		baseURL: options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
		apiKey: options.apiKey
	});

	const systemPrompt: string = params.systemPrompt ?? "You are a helpful assistant.";
	const requestBody: ChatCompletionCreateParamsNonStreaming = {
		model: options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
		messages: [
			{
				role: "system",
				content: systemPrompt,
			},
			{
				role: "user",
				content: params.message,
			}
		]
	};

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

	const completion = await client.chat.completions.create(requestBody);

	const text: string | null | undefined = completion.choices[0]?.message.content;
	if (!text) {
		throw new Error("LLM returned empty response");
	}

	return text;
}
