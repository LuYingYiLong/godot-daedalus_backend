const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";

export async function chatWithDeepSeek(message: string): Promise<string> {
	const apiKey: string | undefined = process.env.DEEPSEEK_API_KEY;

	if (!apiKey) {
		throw new Error("DEEPSEEK_API_KEY is not set");
	}

	const baseUrl: string = process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL;
	const model: string = process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;

	const response: Response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: "你是一个有帮助的助手。" },
				{ role: "user", content: message },
			],
			stream: false,
		}),
	});

	if (!response.ok) {
		const errorText: string = await response.text();
		throw new Error(`DeepSeek API error ${response.status}: ${errorText}`);
	}

	const data: { choices: Array<{ message: { content: string } }> } =
		await response.json() as { choices: Array<{ message: { content: string } }> };

	const choice: { message: { content: string } } | undefined = data.choices[0];

	if (!choice) {
		throw new Error("DeepSeek API returned empty choices");
	}

	return choice.message.content;
}
