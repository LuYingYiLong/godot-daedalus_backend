import assert from "node:assert/strict";
import test from "node:test";
import { createPlanDecision, createPlannerSystemPrompt } from "../src/server/plan-mode.js";
import { createPlanMetadata } from "../src/server/plan-store.js";
import type { ProviderChatOptions } from "../src/providers/deepseek-client.js";
import { shouldPersistSessionEvent } from "../src/server/session-events.js";

const DUMMY_PROVIDER: ProviderChatOptions = {
	provider: "deepseek",
	apiKey: "test-key",
	model: "deepseek-v4-pro"
};

test("broad Godot AI plugin goal requires clarification with at most three replies", async (): Promise<void> => {
	const decision = await createPlanDecision({
		message: "帮我做一个 godot ai 插件",
		mode: "plan"
	}, DUMMY_PROVIDER);

	assert.equal(decision.decision, "needs_clarification");
	assert.ok(decision.question.length > 0);
	assert.ok(decision.recommendedReplies.length > 0);
	assert.ok(decision.recommendedReplies.length <= 3);
	assert.ok(decision.recommendedReplies.some((reply): boolean => reply.text.includes("前端")));
});

test("plan metadata stores PLAN.md under the session plan directory", (): void => {
	const metadata = createPlanMetadata({
		sessionId: "session-20260709-test",
		requestId: "request-1",
		status: "ready",
		title: "测试计划",
		originalMessage: "请先计划",
		previewMarkdown: "# 测试计划"
	});

	assert.match(metadata.planId, /^plan-/);
	assert.equal(metadata.planPath, `plans/${metadata.planId}/PLAN.md`);
	assert.equal(metadata.status, "ready");
	assert.equal(metadata.previewMarkdown, "# 测试计划");
});

test("planner prompt anchors backend plans to actual repository conventions", (): void => {
	const prompt = createPlannerSystemPrompt();

	assert.match(prompt, /TypeScript WebSocket\/RPC/);
	assert.match(prompt, /zod schema/);
	assert.match(prompt, /Node 内置 test runner/);
	assert.match(prompt, /不要.*Vitest/);
	assert.match(prompt, /不要.*gRPC/);
});

test("plan events are persisted for timeline recovery", (): void => {
	assert.equal(shouldPersistSessionEvent("plan.clarification.required"), true);
	assert.equal(shouldPersistSessionEvent("plan.generated"), true);
	assert.equal(shouldPersistSessionEvent("plan.revised"), true);
});
