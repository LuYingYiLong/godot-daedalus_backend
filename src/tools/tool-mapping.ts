import { getDynamicMcpToolMapping } from "./dynamic-mcp-tools.js";

export type ToolMapping = {
	serverId: string;
	toolName: string;
};

const TOOL_MAP: Record<string, ToolMapping> = {
	"mcp_godot_get_project_summary": {
		serverId: "godot",
		toolName: "get_project_summary"
	},
	"mcp_godot_list_project_files": {
		serverId: "godot",
		toolName: "list_project_files"
	},
	"mcp_godot_list_scenes": {
		serverId: "godot",
		toolName: "list_scenes"
	},
	"mcp_godot_list_scripts": {
		serverId: "godot",
		toolName: "list_scripts"
	},
	"mcp_godot_read_text_file": {
		serverId: "godot",
		toolName: "read_text_file"
	},
	"mcp_godot_search_text": {
		serverId: "godot",
		toolName: "search_text"
	},
	"mcp_godot_get_project_log_config": {
		serverId: "godot",
		toolName: "get_project_log_config"
	},
	"mcp_godot_list_project_logs": {
		serverId: "godot",
		toolName: "list_project_logs"
	},
	"mcp_godot_read_project_log": {
		serverId: "godot",
		toolName: "read_project_log"
	},
	"mcp_godot_get_project_settings": {
		serverId: "godot",
		toolName: "get_project_settings"
	},
	"mcp_godot_get_editor_config_summary": {
		serverId: "godot",
		toolName: "get_editor_config_summary"
	},
	"mcp_godot_get_editor_settings": {
		serverId: "godot",
		toolName: "get_editor_settings"
	},
	"mcp_godot_list_editor_config_files": {
		serverId: "godot",
		toolName: "list_editor_config_files"
	},
	"mcp_godot_read_editor_config_file": {
		serverId: "godot",
		toolName: "read_editor_config_file"
	},
	"mcp_godot_get_editor_project_state": {
		serverId: "godot",
		toolName: "get_editor_project_state"
	},
	"mcp_godot_get_recent_projects": {
		serverId: "godot",
		toolName: "get_recent_projects"
	},
	"mcp_godot_propose_set_project_setting": {
		serverId: "godot",
		toolName: "propose_set_project_setting"
	},
	"mcp_godot_set_project_setting": {
		serverId: "godot",
		toolName: "set_project_setting"
	},
	"mcp_godot_propose_unset_project_setting": {
		serverId: "godot",
		toolName: "propose_unset_project_setting"
	},
	"mcp_godot_unset_project_setting": {
		serverId: "godot",
		toolName: "unset_project_setting"
	},
	"mcp_godot_propose_create_text_file": {
		serverId: "godot",
		toolName: "propose_create_text_file"
	},
	"mcp_godot_create_text_file": {
		serverId: "godot",
		toolName: "create_text_file"
	},
	"mcp_godot_propose_overwrite_text_file": {
		serverId: "godot",
		toolName: "propose_overwrite_text_file"
	},
	"mcp_godot_overwrite_text_file": {
		serverId: "godot",
		toolName: "overwrite_text_file"
	},
	"mcp_godot_propose_replace_text_in_file": {
		serverId: "godot",
		toolName: "propose_replace_text_in_file"
	},
	"mcp_godot_replace_text_in_file": {
		serverId: "godot",
		toolName: "replace_text_in_file"
	},
	"mcp_godot_delete_file": {
		serverId: "godot",
		toolName: "delete_file"
	},
	"mcp_terminal_run_safe_preset": {
		serverId: "terminal",
		toolName: "run_safe_preset"
	},
	"mcp_terminal_run_write_preset": {
		serverId: "terminal",
		toolName: "run_write_preset"
	},
	"mcp_terminal_get_job_status": {
		serverId: "terminal",
		toolName: "get_terminal_job_status"
	},
	"mcp_terminal_get_job_tail": {
		serverId: "terminal",
		toolName: "get_terminal_job_tail"
	},
	"mcp_terminal_cancel_job": {
		serverId: "terminal",
		toolName: "cancel_terminal_job"
	},
	"mcp_terminal_get_capabilities": {
		serverId: "terminal",
		toolName: "get_terminal_capabilities"
	},
	"mcp_godot_inspect_scene_tree": {
		serverId: "godot",
		toolName: "inspect_scene_tree"
	},
	"mcp_godot_validate_scene_script_references": {
		serverId: "godot",
		toolName: "validate_scene_script_references"
	},
	"mcp_godot_propose_create_scene": {
		serverId: "godot",
		toolName: "propose_create_scene"
	},
	"mcp_godot_create_scene": {
		serverId: "godot",
		toolName: "create_scene"
	},
	"mcp_godot_propose_add_node_to_scene": {
		serverId: "godot",
		toolName: "propose_add_node_to_scene"
	},
	"mcp_godot_add_node_to_scene": {
		serverId: "godot",
		toolName: "add_node_to_scene"
	},
	"mcp_godot_propose_attach_script_to_node": {
		serverId: "godot",
		toolName: "propose_attach_script_to_node"
	},
	"mcp_godot_attach_script_to_node": {
		serverId: "godot",
		toolName: "attach_script_to_node"
	},
	"mcp_godot_propose_connect_signal_in_scene": {
		serverId: "godot",
		toolName: "propose_connect_signal_in_scene"
	},
	"mcp_godot_connect_signal_in_scene": {
		serverId: "godot",
		toolName: "connect_signal_in_scene"
	},
	"mcp_godot_propose_apply_scene_patch": {
		serverId: "godot",
		toolName: "propose_apply_scene_patch"
	},
	"mcp_godot_apply_scene_patch": {
		serverId: "godot",
		toolName: "apply_scene_patch"
	},
	"mcp_godot_editor_get_context": {
		serverId: "godot_editor",
		toolName: "get_context"
	},
	"mcp_godot_editor_get_selected_nodes": {
		serverId: "godot_editor",
		toolName: "get_selected_nodes"
	},
	"mcp_godot_editor_inspect_node": {
		serverId: "godot_editor",
		toolName: "inspect_node"
	},
	"mcp_godot_editor_apply_scene_patch": {
		serverId: "godot_editor",
		toolName: "apply_scene_patch"
	},
	"mcp_godot_lsp_get_status": {
		serverId: "godot_diagnostics",
		toolName: "lsp_get_status"
	},
	"mcp_godot_lsp_get_file_diagnostics": {
		serverId: "godot_diagnostics",
		toolName: "lsp_get_file_diagnostics"
	},
	"mcp_godot_lsp_get_document_symbols": {
		serverId: "godot_diagnostics",
		toolName: "lsp_get_document_symbols"
	},
	"mcp_godot_lsp_hover": {
		serverId: "godot_diagnostics",
		toolName: "lsp_hover"
	},
	"mcp_godot_lsp_goto_definition": {
		serverId: "godot_diagnostics",
		toolName: "lsp_goto_definition"
	},
	"mcp_godot_dap_get_status": {
		serverId: "godot_diagnostics",
		toolName: "dap_get_status"
	},
	"mcp_godot_dap_get_last_error": {
		serverId: "godot_diagnostics",
		toolName: "dap_get_last_error"
	},
	"mcp_godot_dap_get_stack_trace": {
		serverId: "godot_diagnostics",
		toolName: "dap_get_stack_trace"
	},
	"mcp_godot_dap_get_variables": {
		serverId: "godot_diagnostics",
		toolName: "dap_get_variables"
	},
	"mcp_terminal_run_godot_scene_script": {
		serverId: "terminal",
		toolName: "run_godot_scene_script"
	}
};

export function resolveToolMapping(llmToolName: string): ToolMapping {
	const mapping: ToolMapping | undefined = TOOL_MAP[llmToolName] ?? getDynamicMcpToolMapping(llmToolName);

	if (!mapping) {
		throw new Error(`Unknown tool: ${llmToolName}`);
	}

	return mapping;
}
