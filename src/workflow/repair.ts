import { READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "./planner.js";
import type { WorkflowFailedCheck, WorkflowPhase, WorkflowPlan, WorkflowTodoItem } from "./types.js";

const MAX_VERIFY_REPAIR_REASON_CHARS: number = 2400;
const AUTO_REPAIR_ID_PREFIX: string = "auto-repair-";
const AUTO_VERIFY_ID_PREFIX: string = "auto-verify-";

function includesAny(text: string, terms: readonly string[]): boolean {
	return terms.some((term: string): boolean => text.includes(term));
}

function normalizeSearchText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function clipRepairReason(text: string): string {
	const trimmedText: string = text.trim();
	if (trimmedText.length <= MAX_VERIFY_REPAIR_REASON_CHARS) {
		return trimmedText;
	}

	return `${trimmedText.slice(0, MAX_VERIFY_REPAIR_REASON_CHARS)}\n\n[验证问题摘要已截断，原始长度 ${trimmedText.length} 字符]`;
}

export function detectWorkflowVerifyRepairNeed(phase: WorkflowPhase, phaseText: string): string | null {
	if (phase.toolGroup !== "verify") {
		return null;
	}

	const normalizedText: string = normalizeSearchText(phaseText);
	if (normalizedText.length === 0) {
		return null;
	}

	const explicitRepairMarkers: string[] = [
		"verify_requires_fix",
		"verification_requires_fix",
		"verification_failed",
		"验证失败",
		"校验失败",
		"检查失败",
		"运行失败",
		"验证未通过",
		"未通过验证"
	];
	if (includesAny(normalizedText, explicitRepairMarkers)) {
		return clipRepairReason(phaseText);
	}

	const failureTerms: string[] = [
		"failed",
		"failure",
		"not found",
		"non-zero",
		"exit code 1",
		"exit 1",
		"报错",
		"失败",
		"未通过",
		"不通过",
		"找不到",
		"未找到"
	];
	const repairTerms: string[] = [
		"need to fix",
		"needs to fix",
		"requires fix",
		"let me fix",
		"let me change",
		"let me replace",
		"let me use",
		"should change",
		"should replace",
		"需要修复",
		"需要修改",
		"需要改",
		"需改",
		"待修复",
		"让我修",
		"让我修改",
		"让我用",
		"改为",
		"替换",
		"设置"
	];
	if (includesAny(normalizedText, failureTerms) && includesAny(normalizedText, repairTerms)) {
		return clipRepairReason(phaseText);
	}

	const futureFixTerms: string[] = [
		"propose_replace",
		"replace_text_in_file",
		"overwrite_text_file",
		"apply_scene_patch",
		"set_property",
		"修复脚本",
		"修改脚本",
		"修复场景",
		"修改场景"
	];
	if (includesAny(normalizedText, futureFixTerms)) {
		return clipRepairReason(phaseText);
	}

	return null;
}

export function countWorkflowAutoRepairRounds(plan: WorkflowPlan): number {
	return plan.phases.filter((phase: WorkflowPhase): boolean => phase.id.startsWith(AUTO_REPAIR_ID_PREFIX)).length;
}

function createUniquePhaseId(plan: WorkflowPlan, prefix: string, round: number): string {
	const existingIds: Set<string> = new Set(plan.phases.map((phase: WorkflowPhase): string => phase.id));
	let phaseId: string = `${prefix}${round}`;
	let suffix: number = 2;
	while (existingIds.has(phaseId)) {
		phaseId = `${prefix}${round}-${suffix}`;
		suffix += 1;
	}

	return phaseId;
}

function createTodoForPhase(phase: WorkflowPhase): WorkflowTodoItem {
	return {
		id: `${phase.id}-todo`,
		phaseId: phase.id,
		text: phase.title,
		status: "pending"
	};
}

function rebuildTodosForPhases(plan: WorkflowPlan, phases: WorkflowPhase[]): WorkflowTodoItem[] {
	const existingTodos: Map<string, WorkflowTodoItem> = new Map(
		plan.todos.map((todo: WorkflowTodoItem): [string, WorkflowTodoItem] => [todo.phaseId, todo])
	);

	return phases.map((phase: WorkflowPhase): WorkflowTodoItem => existingTodos.get(phase.id) ?? createTodoForPhase(phase));
}

export function insertWorkflowAutoRepairPhases(
	plan: WorkflowPlan,
	insertIndex: number,
	failedPhase: WorkflowPhase,
	verifyFailureReason: string,
	failedChecks: WorkflowFailedCheck[] = []
): WorkflowPlan {
	const round: number = countWorkflowAutoRepairRounds(plan) + 1;
	const acceptanceCriteria: string[] = failedChecks.length > 0
		? failedChecks.map((check: WorkflowFailedCheck): string => check.message)
		: [verifyFailureReason];
	const repairPhase: WorkflowPhase = {
		id: createUniquePhaseId(plan, AUTO_REPAIR_ID_PREFIX, round),
		title: "修复验证问题",
		toolGroup: "write",
		skillId: "file.creator",
		promptId: "godot.assistant",
		toolBudget: "project_edit",
		allowedTools: [...READ_TOOLS, ...WRITE_TOOLS],
		repairOf: failedPhase.id,
		repairRound: round,
		acceptanceCriteria,
		instruction: [
			`上一验证阶段「${failedPhase.title}」发现任务尚未可交付。`,
			"请根据验证失败内容完成必要修复，必须调用实际写入工具；如果写入触发审批，按审批流程暂停。",
			"不要只输出计划或修复建议。",
			"",
			"## 验证失败内容",
			verifyFailureReason
		].join("\n")
	};
	const verifyPhase: WorkflowPhase = {
		id: createUniquePhaseId(plan, AUTO_VERIFY_ID_PREFIX, round),
		title: "重新验证修复",
		toolGroup: "verify",
		toolBudget: "normal",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS],
		repairOf: failedPhase.id,
		repairRound: round,
		acceptanceCriteria,
		instruction: "重新运行与失败点相关的验证。只有确认失败已消除，且没有新的阻塞问题，才能报告验证通过。"
	};
	const phases: WorkflowPhase[] = [
		...plan.phases.slice(0, insertIndex),
		repairPhase,
		verifyPhase,
		...plan.phases.slice(insertIndex)
	];

	return {
		...plan,
		phases,
		todos: rebuildTodosForPhases(plan, phases),
		revision: (plan.revision ?? 0) + 1
	};
}
