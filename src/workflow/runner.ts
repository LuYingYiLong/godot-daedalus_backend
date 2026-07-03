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
		source: plan.source,
		revision: plan.revision,
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
		"请只完成当前阶段。不要跳过后续阶段，不要输出最终交付总结，除非当前阶段是最后一步或阶段指令明确要求总结。"
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
	const toolGroupRules: string[] = createPhaseToolGroupRules(phase);
	return [
		"## 工作流阶段约束",
		`- 当前阶段：${phase.title}（${phase.id}）`,
		`- 阶段目标：${phase.instruction}`,
		"- 只完成当前阶段，不要提前总结整个任务。",
		"- 如果需要写入或执行审批工具，按现有审批流程暂停。",
		...toolGroupRules,
		"- 当前阶段实际可用工具：",
		...phase.allowedTools.map((toolName: string): string => `  - ${toolName}`),
		"",
		skillPrompt,
		mcpSystemContext
	].filter((part: string): boolean => part.length > 0).join("\n\n");
}

function createPhaseToolGroupRules(phase: WorkflowPhase): string[] {
	if (phase.toolGroup === "write") {
		return [
			"- 当前是写入/提案阶段：如果阶段目标是预览、提案或 diff，必须调用对应 propose_* 工具。",
			"- 如果阶段目标是实际创建、修改、删除或应用补丁，必须调用实际写入工具；写入工具触发审批时按现有流程暂停。",
			"- 不要只输出计划、意图或“稍后将执行”；后端会把未调用当前阶段所需工具的阶段视为未完成。"
		];
	}

	if (phase.toolGroup === "verify") {
		return [
			"- 当前是验证阶段：优先实际调用诊断或验证工具，不要只描述验证计划。"
		];
	}

	return [];
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
