import type { AiChatParams, ChatMessage, PromptId } from "../protocol/types.js";
import type { SkillId } from "../skills/registry.js";
import type { ToolBudgetLevel } from "../tools/llm-tools.js";

export type WorkflowPhaseId = "inspect" | "implement" | "review" | "verify" | "summarize";

export type WorkflowTodoStatus = "pending" | "running" | "done" | "failed" | "paused";

export type WorkflowPhase = {
	id: WorkflowPhaseId;
	title: string;
	skillId?: SkillId | undefined;
	promptId?: PromptId | undefined;
	toolBudget: ToolBudgetLevel;
	allowedTools: string[];
	instruction: string;
};

export type WorkflowTodoItem = {
	id: string;
	phaseId: WorkflowPhaseId;
	text: string;
	status: WorkflowTodoStatus;
};

export type WorkflowPlan = {
	id: string;
	title: string;
	phases: WorkflowPhase[];
	todos: WorkflowTodoItem[];
};

export type WorkflowPhaseOutput = {
	phaseId: WorkflowPhaseId;
	title: string;
	text: string;
};

export type WorkflowRunState = {
	plan: WorkflowPlan;
	phaseIndex: number;
	phaseOutputs: WorkflowPhaseOutput[];
	originalParams: AiChatParams;
	history: ChatMessage[];
	historyBudgetTokens: number;
};

export type WorkflowTodoSnapshot = {
	workflowId: string;
	title: string;
	phases: Array<{
		id: WorkflowPhaseId;
		title: string;
		status: WorkflowTodoStatus;
	}>;
	todos: WorkflowTodoItem[];
};
