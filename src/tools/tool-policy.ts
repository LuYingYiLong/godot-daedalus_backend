import { isDynamicMcpToolName } from "./dynamic-mcp-tools.js";
import { HARD_BLOCKED_TOOLS, TOOL_POLICIES } from "./tool-policy-table.js";

export type ApprovalMode = "manual" | "auto-safe" | "bypass";

export type ToolRisk = "read" | "verify" | "propose" | "write" | "destructive";

export type ToolPolicy = {
	risk: ToolRisk;
};

const TERMINAL_PRESET_RISKS: Record<string, ToolRisk> = {
	"backend.typecheck": "verify",
	"git.status": "read",
	"git.diff": "read",
	"git.init": "write",
	"godot.check_only": "verify",
	"godot.validate_scene": "verify"
};

export function getToolPolicy(toolName: string): ToolPolicy | undefined {
	if (isDynamicMcpToolName(toolName)) {
		return { risk: "write" };
	}

	return TOOL_POLICIES[toolName];
}

export function getEffectiveToolPolicy(toolName: string, args: Record<string, unknown>): ToolPolicy | undefined {
	const policy: ToolPolicy | undefined = getToolPolicy(toolName);
	if (policy === undefined) {
		return undefined;
	}

	if (toolName !== "mcp_terminal_run_write_preset") {
		return policy;
	}

	const presetName: unknown = args.presetName;
	if (typeof presetName !== "string") {
		return policy;
	}

	const presetRisk: ToolRisk | undefined = TERMINAL_PRESET_RISKS[presetName];
	if (presetRisk === "read" || presetRisk === "verify") {
		return { risk: presetRisk };
	}

	return policy;
}

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
	args: Record<string, unknown>
): ApprovalDecision {
	const policy: ToolPolicy | undefined = getEffectiveToolPolicy(toolName, args);

	if (!policy) {
		return { action: "deny", reason: `未知工具: ${toolName}` };
	}

	if (isHardBlocked(toolName)) {
		return { action: "deny", reason: "该工具已被硬性禁用" };
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

		if (policy.risk === "write" && !isDynamicMcpToolName(toolName)) {
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
