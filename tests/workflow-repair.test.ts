import assert from "node:assert/strict";
import test from "node:test";
import { insertWorkflowAutoRepairPhases } from "../src/workflow/repair.js";
import type { WorkflowPhase, WorkflowPlan, WorkflowTodoItem } from "../src/workflow/types.js";

function createPhase(id: string, title: string, toolGroup: WorkflowPhase["toolGroup"]): WorkflowPhase {
	return {
		id,
		title,
		toolGroup,
		toolBudget: toolGroup === "write" ? "project_edit" : "normal",
		allowedTools: [],
		instruction: title
	};
}

function createTodo(phase: WorkflowPhase, status: WorkflowTodoItem["status"] = "pending"): WorkflowTodoItem {
	return {
		id: `${phase.id}-todo`,
		phaseId: phase.id,
		text: phase.title,
		status
	};
}

test("workflow auto repair insertion preserves current todos and adds repair plus reverify", (): void => {
	const inspect: WorkflowPhase = createPhase("inspect", "理解上下文", "read");
	const implement: WorkflowPhase = createPhase("implement", "实现修改", "write");
	const verify: WorkflowPhase = createPhase("verify", "运行验证", "verify");
	const summarize: WorkflowPhase = createPhase("summarize", "总结交付", "summarize");
	const plan: WorkflowPlan = {
		id: "workflow-test",
		title: "测试 workflow 修复",
		source: "fixed",
		revision: 0,
		phases: [inspect, implement, verify, summarize],
		todos: [
			createTodo(inspect, "done"),
			createTodo(implement, "done"),
			createTodo(verify, "failed"),
			createTodo(summarize)
		]
	};

	const repairedPlan: WorkflowPlan = insertWorkflowAutoRepairPhases(
		plan,
		3,
		verify,
		"`%TitleLabel` 未设置 unique name，需要修复脚本或场景。"
	);

	assert.deepEqual(
		repairedPlan.phases.map((phase: WorkflowPhase): string => phase.id),
		["inspect", "implement", "verify", "auto-repair-1", "auto-verify-1", "summarize"]
	);
	assert.equal(repairedPlan.todos.find((todo: WorkflowTodoItem): boolean => todo.phaseId === "verify")?.status, "failed");
	assert.equal(repairedPlan.todos.find((todo: WorkflowTodoItem): boolean => todo.phaseId === "auto-repair-1")?.status, "pending");
	assert.equal(repairedPlan.phases[3]?.toolGroup, "write");
	assert.equal(repairedPlan.phases[4]?.toolGroup, "verify");
	assert.ok(repairedPlan.phases[3]?.allowedTools.includes("mcp_godot_replace_text_in_file"));
	assert.ok(repairedPlan.phases[4]?.allowedTools.includes("mcp_terminal_run_safe_preset"));
	assert.equal(repairedPlan.revision, 1);
});
