import type { TokenCounter } from "./token-counter.js";
import { ApproxTokenCounter } from "./token-counter.js";

export async function createTokenCounter(): Promise<TokenCounter> {
	return new ApproxTokenCounter();
}
