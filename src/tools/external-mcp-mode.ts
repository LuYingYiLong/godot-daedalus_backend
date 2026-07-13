import type { ToolPolicy, ToolRisk } from "./tool-policy.js";
import { isHardBlocked } from "./tool-policy.js";

export const EXTERNAL_MCP_MODES = ["minimal", "lite", "full"] as const;

export type ExternalMcpMode = typeof EXTERNAL_MCP_MODES[number];

export function isExternalMcpMode(value: unknown): value is ExternalMcpMode {
	return value === "minimal" || value === "lite" || value === "full";
}

export function parseExternalMcpMode(value: unknown, fallback: ExternalMcpMode = "lite"): ExternalMcpMode {
	return isExternalMcpMode(value) ? value : fallback;
}

export function isToolRiskAllowedForExternalMcpMode(mode: ExternalMcpMode, risk: ToolRisk): boolean {
	if (mode === "minimal") {
		return false;
	}
	if (mode === "lite") {
		return risk === "read" || risk === "verify" || risk === "propose";
	}
	return true;
}

export function isToolAllowedForExternalMcpMode(mode: ExternalMcpMode, toolName: string, policy: ToolPolicy | undefined): boolean {
	if (policy === undefined || isHardBlocked(toolName)) {
		return false;
	}
	return isToolRiskAllowedForExternalMcpMode(mode, policy.risk);
}
