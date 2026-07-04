import type { AiChatParams } from "../protocol/types.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../tools/llm-tools.js";
import type { WorkflowPhase, WorkflowPhaseId, WorkflowPlan, WorkflowTodoItem } from "./types.js";

type FixedWorkflowPhaseId = "inspect" | "implement" | "review" | "verify" | "summarize";

export const READ_TOOLS: string[] = [
	"mcp_godot_get_project_summary",
	"mcp_godot_list_project_files",
	"mcp_godot_list_scenes",
	"mcp_godot_list_scripts",
	"mcp_godot_read_text_file",
	"mcp_godot_search_text",
	"mcp_godot_get_project_log_config",
	"mcp_godot_list_project_logs",
	"mcp_godot_read_project_log",
	"mcp_godot_get_project_settings",
	"mcp_godot_get_editor_config_summary",
	"mcp_godot_get_editor_settings",
	"mcp_godot_list_editor_config_files",
	"mcp_godot_read_editor_config_file",
	"mcp_godot_get_editor_project_state",
	"mcp_godot_get_recent_projects",
	"mcp_godot_inspect_scene_tree",
	"mcp_godot_editor_get_context",
	"mcp_godot_editor_get_selected_nodes",
	"mcp_godot_editor_inspect_node",
	"mcp_godot_lsp_get_status",
	"mcp_godot_lsp_get_file_diagnostics",
	"mcp_godot_lsp_get_document_symbols",
	"mcp_godot_lsp_hover",
	"mcp_godot_lsp_goto_definition",
	"mcp_godot_dap_get_status",
	"mcp_godot_dap_get_last_error",
	"mcp_godot_dap_get_stack_trace",
	"mcp_godot_dap_get_variables",
	CUSTOM_MCP_TOOLS_SENTINEL
];

export const VERIFY_TOOLS: string[] = [
	"mcp_godot_validate_scene_script_references",
	"mcp_godot_lsp_get_file_diagnostics",
	"mcp_terminal_get_capabilities",
	"mcp_terminal_run_safe_preset"
];

export const WRITE_TOOLS: string[] = [
	"mcp_godot_propose_create_text_file",
	"mcp_godot_create_text_file",
	"mcp_godot_propose_overwrite_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_propose_replace_text_in_file",
	"mcp_godot_replace_text_in_file",
	"mcp_godot_propose_create_scene",
	"mcp_godot_create_scene",
	"mcp_godot_propose_add_node_to_scene",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_propose_attach_script_to_node",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_propose_connect_signal_in_scene",
	"mcp_godot_connect_signal_in_scene",
	"mcp_godot_propose_apply_scene_patch",
	"mcp_godot_apply_scene_patch",
	"mcp_godot_editor_apply_scene_patch",
	"mcp_godot_propose_set_project_setting",
	"mcp_godot_set_project_setting",
	"mcp_godot_propose_unset_project_setting",
	"mcp_godot_unset_project_setting",
	"mcp_terminal_run_write_preset",
	"mcp_terminal_run_godot_scene_script"
];

const PHASE_TEMPLATES: Record<FixedWorkflowPhaseId, WorkflowPhase> = {
	inspect: {
		id: "inspect",
		title: "理解上下文",
		toolGroup: "read",
		toolBudget: "normal",
		allowedTools: READ_TOOLS,
		instruction: "读取最小必要上下文，确认相关文件、场景、脚本和项目约束。只做事实收集，不修改文件。",
		acceptanceCriteria: ["已确认相关文件、场景、脚本和项目约束。"]
	},
	implement: {
		id: "implement",
		title: "实现修改",
		toolGroup: "write",
		skillId: "file.creator",
		promptId: "godot.assistant",
		toolBudget: "project_edit",
		allowedTools: [...READ_TOOLS, ...WRITE_TOOLS],
		instruction: "基于已收集上下文完成必要修改。优先小步修改，必须使用 create/overwrite/replace/apply/add/attach/connect/set/unset 等实际写入工具完成修改；这些写入工具会走审批系统。修改项目设置时先用 propose_* 预览，但不要把 propose_* 当作实现结果。",
		acceptanceCriteria: ["必要文件、场景或项目设置已由实际写入工具完成修改。"]
	},
	review: {
		id: "review",
		title: "审查结果",
		toolGroup: "verify",
		skillId: "gdscript.review",
		promptId: "gdscript.reviewer",
		toolBudget: "normal",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS],
		instruction: "审查修改后的代码、场景和相邻调用。优先指出真实风险、回归和遗漏验证。默认不要写文件。",
		acceptanceCriteria: ["已审查修改后的代码、场景和相邻调用。"]
	},
	verify: {
		id: "verify",
		title: "运行验证",
		toolGroup: "verify",
		toolBudget: "normal",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS],
		instruction: "运行可用的低成本验证。修改 .gd 后优先读取 LSP diagnostics，再运行 Godot check-only、类型检查或安全预设。记录通过、失败和未覆盖项。如果发现失败或需要修改的问题，用 VERIFY_REQUIRES_FIX: 开头说明阻塞点，不要把验证阶段标成通过。",
		acceptanceCriteria: ["相关 LSP diagnostics、Godot check-only 或场景验证已经实际运行且无阻塞失败。"]
	},
	summarize: {
		id: "summarize",
		title: "总结交付",
		toolGroup: "summarize",
		promptId: "godot.assistant",
		toolBudget: "simple",
		allowedTools: [],
		instruction: "只基于前面阶段的结果给用户最终总结。说明完成内容、验证状态、剩余风险和是否有审批未完成。不要再调用工具。",
		acceptanceCriteria: ["所有前置阶段均完成，且不存在未解决的验证失败、阻塞或审批。"]
	}
};

export function createWorkflowId(): string {
	return `workflow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function includesAny(text: string, terms: readonly string[]): boolean {
	return terms.some((term: string): boolean => text.includes(term));
}

function createPhase(phaseId: FixedWorkflowPhaseId): WorkflowPhase {
	const phase: WorkflowPhase = PHASE_TEMPLATES[phaseId];
	return {
		...phase,
		allowedTools: [...phase.allowedTools]
	};
}

function createTodos(phases: WorkflowPhase[]): WorkflowTodoItem[] {
	return phases.map((phase: WorkflowPhase): WorkflowTodoItem => ({
		id: `${phase.id}-todo`,
		phaseId: phase.id,
		text: phase.title,
		status: "pending"
	}));
}

function createPlan(title: string, phaseIds: FixedWorkflowPhaseId[]): WorkflowPlan {
	const phases: WorkflowPhase[] = phaseIds.map(createPhase);
	return {
		id: createWorkflowId(),
		title,
		phases,
		todos: createTodos(phases),
		source: "fixed",
		revision: 0
	};
}

export function createWorkflowTitle(message: string): string {
	const normalized: string = message.replace(/\s+/g, " ").trim();
	if (normalized.length <= 24) {
		return normalized.length > 0 ? normalized : "多阶段任务";
	}

	return `${normalized.slice(0, 24)}...`;
}

export function planWorkflow(params: AiChatParams): WorkflowPlan | null {
	const workflowMode = params.options?.workflow ?? "auto";
	if (workflowMode === "single" || workflowMode === "llm_planned") {
		return null;
	}

	const text: string = params.message.toLowerCase();
	const wantsReview: boolean = includesAny(text, ["审查", "检查", "review", "code review", "复查", "评审"]);
	const wantsImplementation: boolean = includesAny(text, [
		"完善",
		"实现",
		"修改",
		"编写",
		"写一个",
		"写下",
		"创建",
		"新增",
		"修复",
		"改一下",
		"生成",
		"搭建",
		"做一个"
	]);

	const title: string = createWorkflowTitle(params.message);

	if (workflowMode === "multi_phase" && !wantsReview && !wantsImplementation) {
		return createPlan(title, ["inspect", "implement", "verify", "summarize"]);
	}

	if (wantsImplementation && wantsReview) {
		return createPlan(title, ["inspect", "implement", "review", "verify", "summarize"]);
	}

	if (wantsReview) {
		return createPlan(title, ["inspect", "review", "summarize"]);
	}

	if (wantsImplementation) {
		return createPlan(title, ["inspect", "implement", "verify", "summarize"]);
	}

	return null;
}
