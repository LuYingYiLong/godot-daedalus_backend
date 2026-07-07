import type { TokenCounter } from "./token-counter.js";
import { ApproxTokenCounter } from "./token-counter.js";
import type { ChatMessage } from "../protocol/types.js";
import { logger } from "../logger.js";

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
			logger.warn("token_counter", "precise_text_count_failed", {
				message,
				textChars: text.length
			});
			return this.fallback.countText(text);
		}
	}

	async countMessages(messages: ChatMessage[]): Promise<number> {
		try {
			return await this.primary.countMessages(messages);
		} catch (error: unknown) {
			const message: string = error instanceof Error ? error.message : String(error);
			logger.warn("token_counter", "precise_message_count_failed", {
				message,
				messageCount: messages.length
			});
			return this.fallback.countMessages(messages);
		}
	}
}

export async function createTokenCounter(): Promise<TokenCounter> {
	const disableTokenizer: string | undefined = process.env.DISABLE_DEEPSEEK_TOKENIZER;
	const fallback: ApproxTokenCounter = new ApproxTokenCounter();

	if (disableTokenizer === "1" || disableTokenizer === "true") {
		logger.info("token_counter", "deepseek_tokenizer_disabled");
		return fallback;
	}

	try {
		const { DeepSeekTokenizerCounter } = await import("./deepseek-tokenizer-counter.js");
		const counter = new DeepSeekTokenizerCounter();
		await counter.initialize();
		logger.info("token_counter", "deepseek_tokenizer_enabled");
		return new ResilientTokenCounter(counter, fallback);
	} catch (error: unknown) {
		const message: string = error instanceof Error ? error.message : String(error);
		logger.warn("token_counter", "deepseek_tokenizer_unavailable", {
			message
		}, "Falling back to ApproxTokenCounter");
		return fallback;
	}
}
