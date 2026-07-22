import type { NormalizedLlmUsage } from "./metrics-types.js";

type UsageParts = {
	rawInputTokens?: number | undefined;
	outputTokens?: number | undefined;
	cacheReadTokens?: number | undefined;
	cacheCreationTokens?: number | undefined;
	totalTokens?: number | undefined;
	inputIncludesCache: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number | undefined {
	const value: unknown = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}
	return Math.max(0, Math.floor(value));
}

function readNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const value: unknown = record[key];
	return isRecord(value) ? value : undefined;
}

export function normalizeUsageFromParts(parts: UsageParts): NormalizedLlmUsage {
	const rawInputTokens: number = Math.max(0, Math.floor(parts.rawInputTokens ?? 0));
	const outputTokens: number = Math.max(0, Math.floor(parts.outputTokens ?? 0));
	const cacheReadTokens: number = Math.max(0, Math.floor(parts.cacheReadTokens ?? 0));
	const cacheCreationTokens: number = Math.max(0, Math.floor(parts.cacheCreationTokens ?? 0));
	const cachedTokens: number = cacheReadTokens + cacheCreationTokens;
	const inputTokens: number = parts.inputIncludesCache
		? Math.max(rawInputTokens - cachedTokens, 0)
		: rawInputTokens;
	const totalTokens: number = Math.max(0, Math.floor(parts.totalTokens ?? (rawInputTokens + outputTokens)));
	const realTotalTokens: number = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

	return {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		rawInputTokens,
		totalTokens,
		realTotalTokens,
		usageSource: "provider",
		inputTokenSemantics: "fresh"
	};
}

export function createEstimatedUsage(inputTokens: number, outputTokens: number): NormalizedLlmUsage {
	const normalizedInputTokens: number = Math.max(0, Math.floor(inputTokens));
	const normalizedOutputTokens: number = Math.max(0, Math.floor(outputTokens));
	return {
		inputTokens: normalizedInputTokens,
		outputTokens: normalizedOutputTokens,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		rawInputTokens: normalizedInputTokens,
		totalTokens: normalizedInputTokens + normalizedOutputTokens,
		realTotalTokens: normalizedInputTokens + normalizedOutputTokens,
		usageSource: "estimated",
		inputTokenSemantics: "fresh"
	};
}

export function createMissingUsage(): NormalizedLlmUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		rawInputTokens: 0,
		totalTokens: 0,
		realTotalTokens: 0,
		usageSource: "missing",
		inputTokenSemantics: "fresh"
	};
}

export function parseOpenAIChatUsage(value: unknown): NormalizedLlmUsage | null {
	if (!isRecord(value)) {
		return null;
	}
	const usage: unknown = isRecord(value.usage) ? value.usage : value;
	if (!isRecord(usage)) {
		return null;
	}
	const rawInputTokens: number | undefined = readNonNegativeInteger(usage, "prompt_tokens");
	const outputTokens: number | undefined = readNonNegativeInteger(usage, "completion_tokens");
	if (rawInputTokens === undefined && outputTokens === undefined) {
		return null;
	}

	const promptDetails: Record<string, unknown> | undefined = readNestedRecord(usage, "prompt_tokens_details");
	const cacheReadTokens: number = readNonNegativeInteger(promptDetails ?? usage, "cached_tokens")
		?? readNonNegativeInteger(usage, "cache_read_input_tokens")
		?? 0;
	const cacheCreationTokens: number = readNonNegativeInteger(promptDetails ?? usage, "cache_write_tokens")
		?? readNonNegativeInteger(promptDetails ?? usage, "cache_creation_tokens")
		?? readNonNegativeInteger(usage, "cache_creation_input_tokens")
		?? 0;

	return normalizeUsageFromParts({
		rawInputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		totalTokens: readNonNegativeInteger(usage, "total_tokens"),
		inputIncludesCache: true
	});
}

export function parseOpenAIResponsesUsage(value: unknown): NormalizedLlmUsage | null {
	if (!isRecord(value)) {
		return null;
	}
	const usage: unknown = isRecord(value.usage) ? value.usage : value;
	if (!isRecord(usage)) {
		return null;
	}
	const rawInputTokens: number | undefined = readNonNegativeInteger(usage, "input_tokens");
	const outputTokens: number | undefined = readNonNegativeInteger(usage, "output_tokens");
	if (rawInputTokens === undefined && outputTokens === undefined) {
		return null;
	}
	const inputDetails: Record<string, unknown> | undefined = readNestedRecord(usage, "input_tokens_details");
	const cacheReadTokens: number = readNonNegativeInteger(inputDetails ?? usage, "cached_tokens")
		?? readNonNegativeInteger(usage, "cache_read_input_tokens")
		?? 0;
	const cacheCreationTokens: number = readNonNegativeInteger(inputDetails ?? usage, "cache_write_tokens")
		?? readNonNegativeInteger(inputDetails ?? usage, "cache_creation_tokens")
		?? readNonNegativeInteger(usage, "cache_creation_input_tokens")
		?? 0;

	return normalizeUsageFromParts({
		rawInputTokens,
		outputTokens,
		cacheReadTokens,
		cacheCreationTokens,
		totalTokens: readNonNegativeInteger(usage, "total_tokens"),
		inputIncludesCache: true
	});
}

export function parseAnthropicUsage(value: unknown): NormalizedLlmUsage | null {
	if (!isRecord(value)) {
		return null;
	}
	const usage: unknown = isRecord(value.usage) ? value.usage : value;
	if (!isRecord(usage)) {
		return null;
	}
	const inputTokens: number | undefined = readNonNegativeInteger(usage, "input_tokens");
	const outputTokens: number | undefined = readNonNegativeInteger(usage, "output_tokens");
	if (inputTokens === undefined && outputTokens === undefined) {
		return null;
	}
	return normalizeUsageFromParts({
		rawInputTokens: inputTokens,
		outputTokens,
		cacheReadTokens: readNonNegativeInteger(usage, "cache_read_input_tokens") ?? 0,
		cacheCreationTokens: readNonNegativeInteger(usage, "cache_creation_input_tokens") ?? 0,
		inputIncludesCache: false
	});
}

export function calculateCacheHitRate(inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number): number {
	const denominator: number = inputTokens + cacheReadTokens + cacheCreationTokens;
	if (denominator <= 0) {
		return 0;
	}
	return cacheReadTokens / denominator;
}
