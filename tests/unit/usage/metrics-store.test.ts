import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	getUsageMetricsSummary,
	getUsageMetricsTrends,
	listUsageMetricsLogs,
	recordUsageMetrics,
	resetUsageMetricsStoreForTests
} from "../../../src/usage/metrics-store.js";
import { recordProviderUsage } from "../../../src/usage/provider-recorder.js";

function createRecord(overrides: Partial<Parameters<typeof recordUsageMetrics>[0]> = {}): Parameters<typeof recordUsageMetrics>[0] {
	const usageId: string = overrides.usageId ?? `usage-${Math.random().toString(36).slice(2)}`;
	return {
		usageId,
		requestId: "request-a",
		runId: "run-a",
		sessionId: "session-a",
		workspaceId: "workspace-a",
		operation: "chat",
		provider: "deepseek",
		model: "deepseek-v4-pro",
		endpointType: "openai-chat-completions",
		adapterFamily: "openai-compatible",
		startedAt: "2026-07-21T10:00:00.000Z",
		completedAt: "2026-07-21T10:00:01.000Z",
		durationMs: 1000,
		status: "success",
		streaming: true,
		usage: {
			inputTokens: 60,
			outputTokens: 20,
			cacheReadTokens: 30,
			cacheCreationTokens: 10,
			rawInputTokens: 100,
			totalTokens: 120,
			realTotalTokens: 120,
			usageSource: "provider",
			inputTokenSemantics: "fresh"
		},
		...overrides
	};
}

test("usage metrics store inserts idempotently and aggregates filters", async (): Promise<void> => {
	const root: string = join(tmpdir(), `daedalus-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(root, { recursive: true });
	resetUsageMetricsStoreForTests(join(root, "usage.sqlite"));
	try {
		const first = createRecord({ usageId: "usage-a" });
		assert.equal(await recordUsageMetrics(first), true);
		assert.equal(await recordUsageMetrics(first), false);
		assert.equal(await recordUsageMetrics(createRecord({
			usageId: "usage-b",
			requestId: "request-b",
			sessionId: "session-b",
			workspaceId: "workspace-b",
			provider: "moonshot",
			model: "kimi-k3",
			status: "error",
			usage: {
				inputTokens: 10,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				rawInputTokens: 10,
				totalTokens: 10,
				realTotalTokens: 10,
				usageSource: "estimated",
				inputTokenSemantics: "fresh"
			}
		})), true);

		const summary = await getUsageMetricsSummary({ provider: "deepseek" });
		assert.equal(summary.available, true);
		assert.equal(summary.requests, 1);
		assert.equal(summary.successfulRequests, 1);
		assert.equal(summary.providerRows, 1);
		assert.equal(summary.realTotalTokens, 120);
		assert.equal(summary.cacheHitRate, 0.3);
		assert.deepEqual(summary.byProvider.map((item) => item.key), ["deepseek"]);

		const logs = await listUsageMetricsLogs({ limit: 10, offset: 0, status: "error" });
		assert.equal(logs.total, 1);
		assert.equal(logs.logs[0]?.provider, "moonshot");
		assert.equal(logs.logs[0]?.usageSource, "estimated");

		const trends = await getUsageMetricsTrends({ bucket: "hour" });
		assert.equal(trends.points.length, 1);
		assert.equal(trends.points[0]?.bucket, "2026-07-21T10:00:00Z");
		assert.equal(trends.points[0]?.requests, 2);
	} finally {
		resetUsageMetricsStoreForTests(null);
		await rm(root, { recursive: true, force: true });
	}
});

test("provider recorder estimates missing usage without failing the caller", async (): Promise<void> => {
	const root: string = join(tmpdir(), `daedalus-usage-recorder-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const previousDisableTokenizer: string | undefined = process.env.DISABLE_DEEPSEEK_TOKENIZER;
	process.env.DISABLE_DEEPSEEK_TOKENIZER = "1";
	await mkdir(root, { recursive: true });
	resetUsageMetricsStoreForTests(join(root, "usage.sqlite"));
	try {
		await recordProviderUsage({
			options: {
				provider: "deepseek",
				apiKey: "test-key",
				model: "deepseek-v4-pro",
				endpointType: "openai-chat-completions",
				adapterFamily: "openai-compatible",
				usageContext: {
					requestId: "request-estimated",
					runId: "run-estimated",
					sessionId: "session-estimated",
					workspaceId: "workspace-estimated",
					operation: "direct_answer"
				}
			},
			requestBody: {
				model: "deepseek-v4-pro",
				messages: [{ role: "user", content: "hello" }]
			},
			outputText: "world",
			startedAtMs: Date.now() - 50,
			status: "success",
			streaming: false,
			usage: null
		});

		const logs = await listUsageMetricsLogs({ sessionId: "session-estimated" });
		assert.equal(logs.logs.length, 1);
		assert.equal(logs.logs[0]?.usageSource, "estimated");
		assert.ok((logs.logs[0]?.realTotalTokens ?? 0) > 0);
	} finally {
		resetUsageMetricsStoreForTests(null);
		if (previousDisableTokenizer === undefined) {
			delete process.env.DISABLE_DEEPSEEK_TOKENIZER;
		} else {
			process.env.DISABLE_DEEPSEEK_TOKENIZER = previousDisableTokenizer;
		}
		await rm(root, { recursive: true, force: true });
	}
});
