import type { AiChatParams } from "../protocol/types.js";
import type {
	WorkflowPhase,
	WorkflowPhaseOutput,
	WorkflowPlan,
	WorkflowTodoItem,
	WorkflowTodoSnapshot,
	WorkflowTodoStatus
} from "./types.js";

const MAX_PHASE_OUTPUT_CHARS: number = 5000;

export function createWorkflowTodoSnapshot(plan: WorkflowPlan): WorkflowTodoSnapshot {
	return {
		workflowId: plan.id,
		title: plan.title,
		phases: plan.phases.map((phase: WorkflowPhase) => ({
			id: phase.id,
			title: phase.title,
			status: getPhaseStatus(plan, phase.id)
		})),
		todos: plan.todos.map((todo: WorkflowTodoItem) => ({ ...todo }))
	};
}

export function updateWorkflowPhaseStatus(plan: WorkflowPlan, phaseId: string, status: WorkflowTodoStatus): WorkflowPlan {
	return {
		...plan,
		todos: plan.todos.map((todo: WorkflowTodoItem): WorkflowTodoItem => (
			todo.phaseId === phaseId ? { ...todo, status } : todo
		))
	};
}

export function markRemainingWorkflowTodos(plan: WorkflowPlan, status: WorkflowTodoStatus): WorkflowPlan {
	return {
		...plan,
		todos: plan.todos.map((todo: WorkflowTodoItem): WorkflowTodoItem => (
			todo.status === "done" ? todo : { ...todo, status }
		))
	};
}

export function createPhaseMessage(
	originalParams: AiChatParams,
	plan: WorkflowPlan,
	phase: WorkflowPhase,
	phaseOutputs: WorkflowPhaseOutput[]
): string {
	const previousResults: string = phaseOutputs.length > 0
		? phaseOutputs.map(formatPhaseOutput).join("\n\n")
		: "（暂无上一阶段结果）";

	return [
		`当前执行工作流：${plan.title}`,
		`当前阶段：${phase.title}（${phase.id}）`,
		"",
		"## 用户原始需求",
		originalParams.message,
		"",
		"## 当前阶段指令",
		phase.instruction,
		"",
		"## 上一阶段结果",
		previousResults,
		"",
		"请只完成当前阶段。不要跳过后续阶段，不要输出最终交付总结，除非当前阶段是 summarize。"
	].join("\n");
}

export function createPhaseParams(originalParams: AiChatParams, phase: WorkflowPhase, message: string, stream: boolean): AiChatParams {
	return {
		...originalParams,
		message,
		promptId: phase.promptId ?? originalParams.promptId,
		skillId: phase.skillId,
		options: {
			...(originalParams.options ?? {}),
			stream,
			toolBudget: phase.toolBudget,
			workflow: "single"
		}
	};
}

export function createPhasePrompt(phase: WorkflowPhase, skillPrompt: string, mcpSystemContext: string): string {
	return [
		"## 工作流阶段约束",
		`- 当前阶段：${phase.title}（${phase.id}）`,
		`- 阶段目标：${phase.instruction}`,
		"- 只完成当前阶段，不要提前总结整个任务。",
		"- 如果需要写入或执行审批工具，按现有审批流程暂停。",
		"",
		skillPrompt,
		mcpSystemContext
	].filter((part: string): boolean => part.length > 0).join("\n\n");
}

export function appendPhaseOutput(outputs: WorkflowPhaseOutput[], phase: WorkflowPhase, text: string): WorkflowPhaseOutput[] {
	const clippedText: string = text.length > MAX_PHASE_OUTPUT_CHARS
		? `${text.slice(0, MAX_PHASE_OUTPUT_CHARS)}\n\n[阶段输出已截断，原始长度 ${text.length} 字符]`
		: text;

	return [
		...outputs,
		{
			phaseId: phase.id,
			title: phase.title,
			text: clippedText
		}
	];
}

function formatPhaseOutput(output: WorkflowPhaseOutput): string {
	return [
		`### ${output.title}`,
		output.text
	].join("\n");
}

function getPhaseStatus(plan: WorkflowPlan, phaseId: string): WorkflowTodoStatus {
	const phaseTodos: WorkflowTodoItem[] = plan.todos.filter((todo: WorkflowTodoItem): boolean => todo.phaseId === phaseId);
	if (phaseTodos.some((todo: WorkflowTodoItem): boolean => todo.status === "failed")) {
		return "failed";
	}
	if (phaseTodos.some((todo: WorkflowTodoItem): boolean => todo.status === "paused")) {
		return "paused";
	}
	if (phaseTodos.some((todo: WorkflowTodoItem): boolean => todo.status === "running")) {
		return "running";
	}
	if (phaseTodos.length > 0 && phaseTodos.every((todo: WorkflowTodoItem): boolean => todo.status === "done")) {
		return "done";
	}

	return "pending";
}
