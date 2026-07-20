import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	applyWorkflowRouteSafety,
	createFallbackWorkflowRoute,
	normalizeWorkflowRouteDecision,
	resolveForcedWorkflowRoute
} from "../../../src/workflow/router.js";

test("workflow router forces single mode to hidden tool answer", (): void => {
	const decision = resolveForcedWorkflowRoute({
		message: "当前是什么工作区？",
		mode: "agent",
		options: {
			workflow: "single"
		}
	});

	assert.equal(decision?.execution, "tool_answer");
	assert.equal(decision?.requiresWrite, false);
	assert.equal(decision?.forcedByOption, "single");
});

test("workflow router forces explicit multi-phase mode to workflow", (): void => {
	const decision = resolveForcedWorkflowRoute({
		message: "实现一个角色控制器",
		mode: "agent",
		options: {
			workflow: "multi_phase"
		}
	});

	assert.equal(decision?.execution, "workflow");
	assert.equal(decision?.requiresWrite, true);
	assert.equal(decision?.forcedByOption, "multi_phase");
});

test("workflow router safety override prevents read-only requests from becoming write workflows", (): void => {
	const decision = applyWorkflowRouteSafety({
		execution: "workflow",
		reason: "Model thought this needs a write plan.",
		requiresTools: true,
		requiresWrite: true,
		planningHint: "Modify scripts/a.gd."
	}, {
		message: "只读 scripts/a.gd，不要修改",
		mode: "agent"
	});

	assert.equal(decision.execution, "tool_answer");
	assert.equal(decision.requiresWrite, false);
	assert.equal(decision.safetyOverride, "explicit_read_only");
});

test("workflow router normalizes direct and tool answers without workflow todos", (): void => {
	assert.equal(normalizeWorkflowRouteDecision({
		execution: "direct_answer",
		reason: "Conceptual explanation.",
		requiresTools: false,
		requiresWrite: false,
		planningHint: ""
	}, {
		message: "解释一下这个概念",
		mode: "agent"
	}).execution, "direct_answer");

	assert.equal(createFallbackWorkflowRoute({
		message: "当前是什么工作区？",
		mode: "agent"
	}).execution, "tool_answer");
});

test("chat orchestrator has a hidden answer path that does not emit workflow todo snapshots", async (): Promise<void> => {
	const source: string = await readFile(new URL("../../../src/server/chat-orchestrator.ts", import.meta.url), "utf8");
	const hiddenAnswerStart: number = source.indexOf("async function runHiddenAnswerExecution");
	const workflowStart: number = source.indexOf("await startWorkflowExecution");

	assert.ok(hiddenAnswerStart >= 0);
	assert.ok(workflowStart > hiddenAnswerStart);
	assert.equal(source.slice(hiddenAnswerStart, workflowStart).includes("sendWorkflowTodoSnapshot"), false);
	assert.equal(source.includes("workflow_route_decided"), true);
});
