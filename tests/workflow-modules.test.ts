import assert from "node:assert/strict";
import test from "node:test";
import type { ToolEvent } from "../src/tools/tool-dispatcher.js";
import type { WorkflowPhase } from "../src/workflow/types.js";
import {
	createEmptyWorkflowPhaseToolStats,
	createWorkflowWriteGuardRetryMessage,
	didWorkflowWritePhaseExecute,
	isWorkflowProposalPhase,
	updateWorkflowPhaseToolStats
} from "../src/server/workflow/tool-events.js";
import {
	convertWorkflowSnapshotToAgentSnapshot,
	mapWorkflowEventToAgentEvent
} from "../src/server/workflow/events.js";

test("workflow tool stats track propose, write and approval events", (): void => {
	const stats = createEmptyWorkflowPhaseToolStats();
	const writePhase: WorkflowPhase = {
		id: "write",
		title: "实现功能",
		instruction: "写入文件",
		status: "pending",
		toolGroup: "write",
		toolBudget: "normal",
		allowedTools: []
	} as WorkflowPhase;

	updateWorkflowPhaseToolStats(stats, {
		type: "tool.call",
		toolName: "mcp_godot_propose_create_text_file"
	} as ToolEvent);
	updateWorkflowPhaseToolStats(stats, {
		type: "tool.call",
		toolName: "mcp_godot_create_text_file"
	} as ToolEvent);
	updateWorkflowPhaseToolStats(stats, {
		type: "tool.approval_required",
		toolName: "mcp_godot_create_text_file"
	} as ToolEvent);

	assert.equal(stats.toolEvents, 3);
	assert.equal(stats.proposeToolEvents, 1);
	assert.equal(stats.writeToolEvents, 2);
	assert.equal(stats.approvalEvents, 1);
	assert.equal(didWorkflowWritePhaseExecute(writePhase, stats), true);
});

test("workflow proposal phases satisfy write guard with propose tools", (): void => {
	const phase: WorkflowPhase = {
		id: "preview_patch",
		title: "预览修改方案",
		instruction: "生成 diff 预览",
		status: "pending",
		toolGroup: "write",
		toolBudget: "normal",
		allowedTools: []
	} as WorkflowPhase;
	const stats = createEmptyWorkflowPhaseToolStats();

	updateWorkflowPhaseToolStats(stats, {
		type: "tool.call",
		toolName: "mcp_godot_propose_replace_text_in_file"
	} as ToolEvent);

	assert.equal(isWorkflowProposalPhase(phase), true);
	assert.equal(didWorkflowWritePhaseExecute(phase, stats), true);
	assert.match(createWorkflowWriteGuardRetryMessage("阶段消息"), /后端执行守卫/);
});

test("workflow events map to agent event compatibility surface", (): void => {
	assert.deepEqual(mapWorkflowEventToAgentEvent("workflow.phase.started", {
		workflowId: "workflow-1",
		phaseId: "phase-1",
		phaseRunId: "run-1",
		title: "读取项目",
		toolGroup: "read",
		acceptanceCriteria: ["完成读取"]
	}), {
		eventName: "agent.step.started",
		data: {
			runId: "workflow-1",
			stepId: "phase-1",
			stepRunId: "run-1",
			title: "读取项目",
			toolGroup: "read",
			acceptanceCriteria: ["完成读取"],
			repairOf: undefined,
			repairRound: undefined
		}
	});

	assert.equal(mapWorkflowEventToAgentEvent("workflow.phase.done", {
		workflowId: "workflow-1"
	}), null);
});

test("workflow snapshot conversion preserves agent snapshot fields", (): void => {
	assert.deepEqual(convertWorkflowSnapshotToAgentSnapshot({
		workflowId: "workflow-1",
		title: "公开 Beta",
		source: "llm",
		revision: 2,
		phases: [{ id: "phase-1" }],
		todos: [{ title: "测试" }],
		phaseOutcomes: [{ status: "completed" }],
		activePhaseRunId: "run-1"
	}), {
		runId: "workflow-1",
		title: "公开 Beta",
		source: "llm",
		revision: 2,
		steps: [{ id: "phase-1" }],
		todos: [{ title: "测试" }],
		outcomes: [{ status: "completed" }],
		activeStepRunId: "run-1",
		repairRound: undefined,
		blockedReason: undefined
	});
});
