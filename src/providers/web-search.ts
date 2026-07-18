import type { ProviderId } from "../protocol/types.js";
import { resolveProviderBaseUrl } from "./provider-base-url.js";
import { resolveWebSearchRuntimeConfig } from "../web-search-settings-store.js";
import type { WebSearchRuntimeConfig } from "../web-search-settings-store.js";

export type WebSearchToolArgs = {
	query: string;
	reason?: string | undefined;
	maxResults?: number | undefined;
};

export type WebSearchResultItem = {
	title: string;
	url: string;
	summary?: string | undefined;
	source?: string | undefined;
	publishedAt?: string | undefined;
};

export type WebSearchResult = {
	ok: true;
	type: "web_search";
	provider: ProviderId;
	model: string;
	query: string;
	answer: string;
	results: WebSearchResultItem[];
};

const DEFAULT_MAX_RESULTS: number = 5;
const MAX_RESULTS: number = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampInteger(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.floor(value)));
}

export function parseWebSearchToolArgs(args: Record<string, unknown>): WebSearchToolArgs {
	const query: string | undefined = getString(args.query);
	if (query === undefined) {
		throw new Error("Web search requires a non-empty query.");
	}

	const rawMaxResults: number | undefined = getNumber(args.maxResults);
	return {
		query,
		reason: getString(args.reason),
		maxResults: rawMaxResults === undefined ? undefined : clampInteger(rawMaxResults, 1, MAX_RESULTS)
	};
}

function createSearchPrompt(input: WebSearchToolArgs): string {
	const lines: string[] = [
		"Use web search to answer the query with current, source-grounded information.",
		"Return a concise answer. Prefer official or primary sources when they are available.",
		`Query: ${input.query}`
	];
	if (input.reason !== undefined) {
		lines.push(`Why search is needed: ${input.reason}`);
	}
	return lines.join("\n");
}

function getObjectArray(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter((item: unknown): item is Record<string, unknown> => isRecord(item))
		: [];
}

function getNestedValue(record: Record<string, unknown>, path: readonly string[]): unknown {
	let current: unknown = record;
	for (const key of path) {
		if (!isRecord(current)) {
			return undefined;
		}
		current = current[key];
	}
	return current;
}

function collectZhipuSearchRecords(body: Record<string, unknown>): Record<string, unknown>[] {
	const topLevelResults: Record<string, unknown>[] = getObjectArray(body.web_search);
	if (topLevelResults.length > 0) {
		return topLevelResults;
	}

	const choiceResults: Record<string, unknown>[] = [];
	for (const choice of getObjectArray(body.choices)) {
		choiceResults.push(...getObjectArray(getNestedValue(choice, ["message", "web_search"])));
	}
	return choiceResults;
}

function parseSearchResultItem(record: Record<string, unknown>): WebSearchResultItem | null {
	const url: string | undefined = getString(record.link) ?? getString(record.url);
	const title: string | undefined = getString(record.title);
	if (url === undefined || title === undefined) {
		return null;
	}

	const item: WebSearchResultItem = {
		title,
		url
	};
	const summary: string | undefined = getString(record.content) ?? getString(record.summary) ?? getString(record.snippet);
	if (summary !== undefined) {
		item.summary = summary;
	}
	const source: string | undefined = getString(record.media) ?? getString(record.source) ?? getString(record.refer);
	if (source !== undefined) {
		item.source = source;
	}
	const publishedAt: string | undefined = getString(record.publish_date) ?? getString(record.publishedAt);
	if (publishedAt !== undefined) {
		item.publishedAt = publishedAt;
	}
	return item;
}

function getZhipuAnswer(body: Record<string, unknown>): string {
	const choices: Record<string, unknown>[] = getObjectArray(body.choices);
	const firstChoice: Record<string, unknown> | undefined = choices[0];
	const content: string | undefined = firstChoice === undefined
		? undefined
		: getString(getNestedValue(firstChoice, ["message", "content"]));
	return content ?? "";
}

function createEndpointUrl(config: WebSearchRuntimeConfig): string {
	return `${resolveProviderBaseUrl(config.provider, config.baseUrl)}/chat/completions`;
}

async function parseErrorMessage(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json() as unknown;
		if (isRecord(body)) {
			const message: unknown = getNestedValue(body, ["error", "message"]) ?? body.message;
			if (typeof message === "string" && message.trim().length > 0) {
				return message.trim();
			}
		}
	} catch {
		// 响应体不可解析时使用 HTTP 状态。
	}
	return `HTTP ${response.status}`;
}

async function executeZhipuWebSearch(config: WebSearchRuntimeConfig, input: WebSearchToolArgs): Promise<WebSearchResult> {
	const response: Response = await fetch(createEndpointUrl(config), {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${config.apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({
			model: config.model,
			messages: [
				{
					role: "user",
					content: createSearchPrompt(input)
				}
			],
			tools: [
				{
					type: "web_search",
					web_search: {
						enable: true,
						search_result: true,
						count: input.maxResults ?? DEFAULT_MAX_RESULTS
					}
				}
			],
			temperature: 0.2
		})
	});

	if (!response.ok) {
		throw new Error(`Web search request failed: ${await parseErrorMessage(response)}`);
	}

	const body: unknown = await response.json() as unknown;
	if (!isRecord(body)) {
		throw new Error("Web search response is not an object.");
	}

	return {
		ok: true,
		type: "web_search",
		provider: config.provider,
		model: config.model,
		query: input.query,
		answer: getZhipuAnswer(body),
		results: collectZhipuSearchRecords(body)
			.map(parseSearchResultItem)
			.filter((item: WebSearchResultItem | null): item is WebSearchResultItem => item !== null)
	};
}

export async function executeWebSearch(input: WebSearchToolArgs): Promise<WebSearchResult> {
	const config: WebSearchRuntimeConfig | null = await resolveWebSearchRuntimeConfig();
	if (config === null) {
		throw new Error("Web search is not enabled or the configured search provider is missing an API key.");
	}

	if (config.provider === "zhipu") {
		return executeZhipuWebSearch(config, input);
	}

	throw new Error(`Provider does not support Daedalus web search: ${config.provider}`);
}
