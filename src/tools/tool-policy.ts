export type ApprovalMode = "read-only" | "manual" | "auto-safe" | "bypass";

export type ToolRisk = "read" | "verify" | "propose" | "write" | "destructive";

export type ToolPolicy = {
	risk: ToolRisk;
};

const TOOL_POLICIES: Record<string, ToolPolicy> = {
	"mcp_godot_get_project_summary": { risk: "read" },
	"mcp_godot_list_project_files": { risk: "read" },
	"mcp_godot_list_scenes": { risk: "read" },
	"mcp_godot_list_scripts": { risk: "read" },
	"mcp_godot_read_text_file": { risk: "read" },
	"mcp_godot_search_text": { risk: "read" },
	"mcp_godot_propose_create_text_file": { risk: "propose" },
	"mcp_godot_create_text_file": { risk: "write" },
	"mcp_godot_propose_overwrite_text_file": { risk: "propose" },
	"mcp_godot_propose_replace_text_in_file": { risk: "propose" },
	"mcp_godot_delete_file": { risk: "destructive" },
	"mcp_terminal_get_capabilities": { risk: "read" },
	"mcp_terminal_run_safe_preset": { risk: "verify" },
	"mcp_terminal_run_write_preset": { risk: "write" },
};

export function getToolPolicy(toolName: string): ToolPolicy | undefined {
	return TOOL_POLICIES[toolName];
}

const HARD_BLOCKED_TOOLS: Set<string> = new Set([]);

export function isHardBlocked(toolName: string): boolean {
	return HARD_BLOCKED_TOOLS.has(toolName);
}

export type ApprovalDecision =
	| { action: "allow" }
	| { action: "request_approval"; reason: string }
	| { action: "deny"; reason: string };

export function evaluateToolCall(
	mode: ApprovalMode,
	toolName: string,
	_args: Record<string, unknown>
): ApprovalDecision {
	const policy: ToolPolicy | undefined = getToolPolicy(toolName);

	if (!policy) {
		return { action: "deny", reason: `未知工具: ${toolName}` };
	}

	if (isHardBlocked(toolName)) {
		return { action: "deny", reason: "该工具已被硬性禁用" };
	}

	if (mode === "read-only") {
		return policy.risk === "read" || policy.risk === "verify"
			? { action: "allow" }
			: { action: "deny", reason: "当前为只读模式，不允许写操作" };
	}

	if (mode === "manual") {
		if (policy.risk === "read" || policy.risk === "verify" || policy.risk === "propose") {
			return { action: "allow" };
		}

		return { action: "request_approval", reason: "写操作需要用户在 Godot 客户端确认" };
	}

	if (mode === "auto-safe") {
		if (policy.risk === "read" || policy.risk === "verify" || policy.risk === "propose") {
			return { action: "allow" };
		}

		return { action: "request_approval", reason: "此写操作需要确认（auto-safe 模式）" };
	}

	if (mode === "bypass") {
		return policy.risk === "destructive"
			? { action: "request_approval", reason: "破坏性操作仍需用户确认" }
			: { action: "allow" };
	}

	return { action: "deny", reason: "未知审批模式" };
}
