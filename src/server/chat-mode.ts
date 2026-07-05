import type { AiChatParams } from "../protocol/types.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../tools/llm-tools.js";
import { READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "../workflow/planner.js";

export function resolveAllowedToolsForChatParams(params: AiChatParams, activeSkillTools: readonly string[] | undefined): readonly string[] | undefined {
	if (params.mode === "ask") {
		return [
			...READ_TOOLS.filter((toolName: string): boolean => toolName !== CUSTOM_MCP_TOOLS_SENTINEL),
			...VERIFY_TOOLS
		];
	}

	if (activeSkillTools !== undefined) {
		return activeSkillTools;
	}

	if (params.options?.toolBudget === "project_edit") {
		return [...READ_TOOLS, ...WRITE_TOOLS, ...VERIFY_TOOLS];
	}

	return undefined;
}

export function normalizeChatParamsForMode(params: AiChatParams): AiChatParams {
	if (params.mode !== "ask") {
		return params;
	}

	return {
		...params,
		options: {
			...params.options,
			toolBudget: "normal",
			workflow: "single"
		}
	};
}
