import OpenAI from "openai";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";

export type DeepSeekChatOptions = {
	apiKey: string;
	baseUrl?: string | undefined;
	model?: string | undefined;
};

export async function chatWithDeepSeek(message: string, options: DeepSeekChatOptions): Promise<string> {
	const client: OpenAI = new OpenAI({
		baseURL: options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
		apiKey: options.apiKey
	});

	const completion = await client.chat.completions.create({
		model: options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL,
		messages: [
			{
				role: "system",
				content: "You are a helpful assistant.",
			},
			{
				role: "user",
				content: message,
			}
		]
	});

	const text: string | null | undefined = completion.choices[0]?.message.content;
	if (!text) {
		throw new Error("LLM returned empty response");
	}

	return text;
}
