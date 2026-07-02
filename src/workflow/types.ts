import type { AiChatParams, ChatMessage, PromptId } from "../protocol/types.js";
import type { SkillId } from "../skills/registry.js";
import type { ToolBudgetLevel } from "../tools/llm-tools.js";

export type WorkflowPhaseId = string;

export type WorkflowTodoStatus = "pending" | "running" | "done" | "failed" | "paused";

export type WorkflowSource = "fixed" | "llm";

export type WorkflowToolGroup = "read" | "write" | "verify" | "summarize";

export type WorkflowPhase = {
	id: WorkflowPhaseId;
	title: string;
	toolGroup?: WorkflowToolGroup | undefined;
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
	source?: WorkflowSource | undefined;
	revision?: number | undefined;
	maxRevisions?: number | undefined;
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
	planningContext?: string | undefined;
};

export type WorkflowTodoSnapshot = {
	workflowId: string;
	title: string;
	source?: WorkflowSource | undefined;
	revision?: number | undefined;
	phases: Array<{
		id: WorkflowPhaseId;
		title: string;
		status: WorkflowTodoStatus;
	}>;
	todos: WorkflowTodoItem[];
};
