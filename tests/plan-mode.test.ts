import assert from "node:assert/strict";
import test from "node:test";
import { createPlanDecision } from "../src/server/plan-mode.js";
import { createPlanMetadata } from "../src/server/plan-store.js";
import type { ProviderChatOptions } from "../src/providers/deepseek-client.js";

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
