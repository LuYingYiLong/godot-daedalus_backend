import assert from "node:assert/strict";
import test from "node:test";
import {
	calculateCacheHitRate,
	normalizeUsageFromParts,
	parseAnthropicUsage,
	parseOpenAIChatUsage,
	parseOpenAIResponsesUsage
} from "../../../src/usage/usage-parser.js";

test("OpenAI Chat usage normalizes cache tokens out of fresh input", (): void => {
	const usage = parseOpenAIChatUsage({
		usage: {
			prompt_tokens: 100,
			completion_tokens: 25,
			total_tokens: 125,
			prompt_tokens_details: {
				cached_tokens: 40,
				cache_write_tokens: 10
			}
		}
	});

	assert.equal(usage?.usageSource, "provider");
	assert.equal(usage?.rawInputTokens, 100);
	assert.equal(usage?.inputTokens, 50);
	assert.equal(usage?.cacheReadTokens, 40);
	assert.equal(usage?.cacheCreationTokens, 10);
	assert.equal(usage?.outputTokens, 25);
	assert.equal(usage?.realTotalTokens, 125);
});

test("OpenAI Responses usage supports input token details", (): void => {
	const usage = parseOpenAIResponsesUsage({
		usage: {
			input_tokens: 80,
			output_tokens: 20,
			input_tokens_details: {
				cached_tokens: 30,
				cache_creation_tokens: 5
			}
		}
	});

	assert.equal(usage?.inputTokens, 45);
	assert.equal(usage?.cacheReadTokens, 30);
	assert.equal(usage?.cacheCreationTokens, 5);
	assert.equal(usage?.realTotalTokens, 100);
});

test("Anthropic-compatible usage treats cache tokens as extra token classes", (): void => {
	const usage = parseAnthropicUsage({
		usage: {
			input_tokens: 70,
			output_tokens: 10,
			cache_read_input_tokens: 25,
			cache_creation_input_tokens: 5
		}
	});

	assert.equal(usage?.inputTokens, 70);
	assert.equal(usage?.rawInputTokens, 70);
	assert.equal(usage?.cacheReadTokens, 25);
	assert.equal(usage?.cacheCreationTokens, 5);
	assert.equal(usage?.realTotalTokens, 110);
});

test("cache normalization saturates when cache exceeds raw input", (): void => {
	const usage = normalizeUsageFromParts({
		rawInputTokens: 10,
		outputTokens: 3,
		cacheReadTokens: 15,
		cacheCreationTokens: 4,
		inputIncludesCache: true
	});

	assert.equal(usage.inputTokens, 0);
	assert.equal(usage.realTotalTokens, 22);
});

test("cache hit rate returns zero for empty denominator", (): void => {
	assert.equal(calculateCacheHitRate(0, 0, 0), 0);
	assert.equal(calculateCacheHitRate(60, 30, 10), 0.3);
});
