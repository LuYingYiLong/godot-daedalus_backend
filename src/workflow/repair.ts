import { READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "./planner.js";
import type { WorkflowFailedCheck, WorkflowPhase, WorkflowPlan, WorkflowTodoItem } from "./types.js";

const AUTO_REPAIR_ID_PREFIX: string = "auto-repair-";
const AUTO_VERIFY_ID_PREFIX: string = "auto-verify-";

export function countWorkflowAutoRepairRounds(plan: WorkflowPlan): number {
	return plan.phases.filter((phase: WorkflowPhase): boolean => (
		phase.id.startsWith(AUTO_REPAIR_ID_PREFIX) || phase.id.startsWith(AUTO_VERIFY_ID_PREFIX)
	)).length;
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

function shouldUseVerifyOnlyRepair(failedChecks: WorkflowFailedCheck[]): boolean {
	if (failedChecks.length === 0) {
		return false;
	}

	const verifyOnlyCodes: Set<string> = new Set([
		"lsp_diagnostics_required",
		"godot_check_only_required",
		"scene_validation_required",
		"verify_tool_missing",
		"validation_environment_unavailable"
	]);
	return failedChecks.every((check: WorkflowFailedCheck): boolean => verifyOnlyCodes.has(check.code));
}

function createAutoVerifyPhase(
	plan: WorkflowPlan,
	failedPhase: WorkflowPhase,
	round: number,
	acceptanceCriteria: string[],
	verifyFailureReason: string,
	verifyOnly: boolean
): WorkflowPhase {
	return {
		id: createUniquePhaseId(plan, AUTO_VERIFY_ID_PREFIX, round),
		title: verifyOnly ? "补跑验证" : "重新验证修复",
		toolGroup: "verify",
		toolBudget: "normal",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS],
		repairOf: failedPhase.id,
		repairRound: round,
		acceptanceCriteria,
		instruction: verifyOnly
			? [
				`上一验证阶段「${failedPhase.title}」缺少必要验证或验证环境不可用。`,
				"请只补跑与失败点相关的验证工具，不能修改项目文件。",
				"如果 LSP、Godot CLI 或其它验证环境不可用，请明确报告环境原因，不要进入写入修复。",
				"",
				"## 验证失败内容",
				verifyFailureReason
			].join("\n")
			: "重新运行与失败点相关的验证。只有确认失败已消除，且没有新的阻塞问题，才能报告验证通过。"
	};
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
	const verifyOnly: boolean = shouldUseVerifyOnlyRepair(failedChecks);
	const verifyPhase: WorkflowPhase = createAutoVerifyPhase(plan, failedPhase, round, acceptanceCriteria, verifyFailureReason, verifyOnly);
	if (verifyOnly) {
		const phases: WorkflowPhase[] = [
			...plan.phases.slice(0, insertIndex),
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
