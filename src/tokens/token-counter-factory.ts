import type { TokenCounter } from "./token-counter.js";
import { ApproxTokenCounter } from "./token-counter.js";
import type { ChatMessage } from "../protocol/types.js";

class ResilientTokenCounter implements TokenCounter {
	constructor(
		private readonly primary: TokenCounter,
		private readonly fallback: TokenCounter
	) {}

	async countText(text: string): Promise<number> {
		try {
			return await this.primary.countText(text);
		} catch (error: unknown) {
			const message: string = error instanceof Error ? error.message : String(error);
			console.warn(`[token-counter] Precise count failed, using approximate count: ${message}`);
			return this.fallback.countText(text);
		}
	}

	async countMessages(messages: ChatMessage[]): Promise<number> {
		try {
			return await this.primary.countMessages(messages);
		} catch (error: unknown) {
			const message: string = error instanceof Error ? error.message : String(error);
			console.warn(`[token-counter] Precise message count failed, using approximate count: ${message}`);
			return this.fallback.countMessages(messages);
		}
	}
}

export async function createTokenCounter(): Promise<TokenCounter> {
	const disableTokenizer: string | undefined = process.env.DISABLE_DEEPSEEK_TOKENIZER;
	const fallback: ApproxTokenCounter = new ApproxTokenCounter();

	if (disableTokenizer === "1" || disableTokenizer === "true") {
		return fallback;
	}

	try {
		const { DeepSeekTokenizerCounter } = await import("./deepseek-tokenizer-counter.js");
		const counter = new DeepSeekTokenizerCounter();
		await counter.initialize();
		console.log("[token-counter] Using DeepSeekTokenizerCounter (Python)");
		return new ResilientTokenCounter(counter, fallback);
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : String(error);
		console.warn(`[token-counter] DeepSeek tokenizer unavailable: ${message}`);
		console.warn("[token-counter] Falling back to ApproxTokenCounter (char/3 estimate)");
		return fallback;
	}
}
