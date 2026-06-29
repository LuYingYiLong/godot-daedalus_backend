import type { ChatMessage } from "../protocol/types.js";

export type TokenCounter = {
	countText(text: string): Promise<number>;
	countMessages(messages: ChatMessage[]): Promise<number>;
};

export class ApproxTokenCounter implements TokenCounter {
	async countText(text: string): Promise<number> {
		return Math.max(1, Math.ceil(text.length / 3));
	}

	async countMessages(messages: ChatMessage[]): Promise<number> {
		let total: number = 0;

		for (const message of messages) {
			total += await this.countText(message.content) + 4;
		}

		return total;
	}
}
