import assert from "node:assert/strict";
import test from "node:test";
import { createApprovedPlanExecutionParams, createPlanDecision, createPlannerSystemPrompt, createPlanVisibleDeltaFilter } from "../src/server/plan-mode.js";
import { createPlanMetadata } from "../src/server/plan-store.js";
import type { StoredPlan } from "../src/server/plan-store.js";
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

test("planner prompt anchors backend plans to actual repository conventions", async (): Promise<void> => {
	const prompt = await createPlannerSystemPrompt();

	assert.match(prompt, /# CORE/);
	assert.match(prompt, /调用工具前/);
	assert.match(prompt, /澄清前/);
	assert.match(prompt, /TypeScript WebSocket\/RPC/);
	assert.match(prompt, /zod schema/);
	assert.match(prompt, /Node 内置 test runner/);
	assert.match(prompt, /不要.*Vitest/);
	assert.match(prompt, /不要.*gRPC/);
});

test("plan visible delta filter forwards preludes but suppresses final json", (): void => {
	const filter = createPlanVisibleDeltaFilter();

	assert.equal(filter.push("我先读取项目结构，再判断计划边界。\n"), "我先读取项目结构，再判断计划边界。\n");
	assert.equal(filter.push("\n"), "");
	assert.equal(filter.push("{\"decision\":\"plan_ready\""), "");
	assert.equal(filter.push(",\"title\":\"测试\"}"), "");
});

test("plan events are persisted for timeline recovery", (): void => {
	assert.equal(shouldPersistSessionEvent("plan.clarification.required"), true);
	assert.equal(shouldPersistSessionEvent("plan.generated"), true);
	assert.equal(shouldPersistSessionEvent("plan.revised"), true);
});

test("approved plan execution forces agent multi-phase workflow", (): void => {
	const plan: StoredPlan = {
		metadata: createPlanMetadata({
			sessionId: "session-20260712-test",
			requestId: "request-1",
			status: "ready",
			title: "审批测试计划",
			originalMessage: "审批",
			previewMarkdown: "Summary"
		}),
		markdown: "# 审批测试计划\n\n## Summary\n执行一次需要审批的写入测试。"
	};
	const params = createApprovedPlanExecutionParams(plan);

	assert.equal(params.mode, "agent");
	assert.equal(params.options?.workflow, "multi_phase");
	assert.equal(params.options?.toolBudget, "project_edit");
	assert.match(params.message, /执行用户已经批准的计划/);
	assert.match(params.message, /原始用户请求：\n审批/);
	assert.match(params.systemPrompt ?? "", /执行阶段必须以该计划为主要约束/);
});
