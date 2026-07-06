export const DEFAULT_TOOL_STEPS: number = 10;

export type ToolBudgetLevel = "simple" | "normal" | "codegen" | "project_edit";

const TOOL_BUDGET_MAP: Record<ToolBudgetLevel, number> = {
	simple: 4,
	normal: 10,
	codegen: 20,
	project_edit: 30
};

const SKILL_BUDGET_MAP: Record<string, number> = {
	"gdscript.review": 8,
	"godot.project_init": 12,
	"file.creator": 16,
	"scene.builder": 20,
	"backend.helper": 10
};

export function resolveToolBudget(
	budgetLevel?: ToolBudgetLevel | string,
	skillId?: string
): number {
	if (budgetLevel && TOOL_BUDGET_MAP[budgetLevel as ToolBudgetLevel]) {
		return TOOL_BUDGET_MAP[budgetLevel as ToolBudgetLevel];
	}

	if (skillId && SKILL_BUDGET_MAP[skillId]) {
		return SKILL_BUDGET_MAP[skillId];
	}

	return DEFAULT_TOOL_STEPS;
}

export const MAX_TOOL_RESULT_CHARS: number = 12000;
export const MAX_TOTAL_TOOL_RESULT_CHARS: number = 48000;
