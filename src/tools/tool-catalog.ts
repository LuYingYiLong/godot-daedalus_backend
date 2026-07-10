import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { BUILTIN_TOOL_DEFINITIONS } from "./builtin-tool-definitions.js";
import {
	getDynamicMcpToolDefinitions,
	getDynamicMcpToolMapping,
	getDynamicMcpToolMetadata,
	isDynamicMcpToolName,
	type DynamicMcpToolMetadata
} from "./dynamic-mcp-tools.js";
import { BUILTIN_TOOL_MAPPINGS, type ToolMapping } from "./tool-mapping.js";
import { TOOL_POLICIES } from "./tool-policy-table.js";
import type { ToolPolicy, ToolRisk } from "./tool-policy.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "./tool-sentinels.js";

export type ToolExecutionContext = {
	workspaceId?: string | undefined;
	editorInstanceId?: string | undefined;
};

export type ToolPhaseEligibility = "read" | "verify" | "write";

export type ToolCatalogEntry = {
	id: string;
	definition: ChatCompletionTool;
	mapping: ToolMapping;
	policy: ToolPolicy;
	phaseEligibility: readonly ToolPhaseEligibility[];
	capabilityRequirement?: string | undefined;
	dynamicMetadata?: DynamicMcpToolMetadata | undefined;
};

function getToolName(definition: ChatCompletionTool): string | undefined {
	return definition.type === "function" ? definition.function.name : undefined;
}

function getPhaseEligibility(risk: ToolRisk): ToolPhaseEligibility[] {
	if (risk === "read") {
		return ["read", "verify", "write"];
	}
	if (risk === "verify") {
		return ["verify", "write"];
	}
	return ["write"];
}

function getCapabilityRequirement(toolName: string): string | undefined {
	return toolName === "mcp_godot_editor_capture_scene_view" ? "sceneViewCapture" : undefined;
}

function createStaticEntry(definition: ChatCompletionTool): ToolCatalogEntry {
	const id: string | undefined = getToolName(definition);
	if (id === undefined) {
		throw new Error("ToolCatalog only supports function tools");
	}

	const mapping: ToolMapping | undefined = BUILTIN_TOOL_MAPPINGS[id];
	const policy: ToolPolicy | undefined = TOOL_POLICIES[id];
	if (mapping === undefined || policy === undefined) {
		throw new Error(`ToolCatalog entry is incomplete: ${id}`);
	}

	return {
		id,
		definition,
		mapping,
		policy,
		phaseEligibility: getPhaseEligibility(policy.risk),
		capabilityRequirement: getCapabilityRequirement(id)
	};
}

function createDynamicEntry(definition: ChatCompletionTool, workspaceId?: string | undefined): ToolCatalogEntry {
	const id: string | undefined = getToolName(definition);
	if (id === undefined) {
		throw new Error("ToolCatalog only supports function tools");
	}

	const mapping: ToolMapping | undefined = getDynamicMcpToolMapping(id, workspaceId);
	const dynamicMetadata: DynamicMcpToolMetadata | undefined = getDynamicMcpToolMetadata(id, workspaceId);
	if (mapping === undefined || dynamicMetadata === undefined) {
		throw new Error(`Dynamic ToolCatalog entry is incomplete: ${id}`);
	}

	const policy: ToolPolicy = { risk: "write" };
	return {
		id,
		definition,
		mapping,
		policy,
		phaseEligibility: dynamicMetadata.planAccess === "read" ? ["read", "verify", "write"] : ["write"],
		dynamicMetadata
	};
}

/**
 * 工具定义、映射与风险判断的唯一运行时入口。
 * workspace 必须由调用方显式提供，避免并发请求借用活动 workspace。
 */
export class WorkspaceToolCatalog {
	private readonly context: ToolExecutionContext;

	constructor(context: ToolExecutionContext = {}) {
		this.context = context;
	}

	getContext(): ToolExecutionContext {
		return { ...this.context };
	}

	getEntries(): ToolCatalogEntry[] {
		const staticEntries: ToolCatalogEntry[] = BUILTIN_TOOL_DEFINITIONS.map(createStaticEntry);
		const dynamicEntries: ToolCatalogEntry[] = getDynamicMcpToolDefinitions(this.context.workspaceId)
			.map((definition: ChatCompletionTool): ToolCatalogEntry => createDynamicEntry(definition, this.context.workspaceId));
		return [...staticEntries, ...dynamicEntries];
	}

	getDefinitions(): ChatCompletionTool[] {
		return this.getEntries().map((entry: ToolCatalogEntry): ChatCompletionTool => entry.definition);
	}

	getDefinitionsForNames(toolNames: readonly string[]): ChatCompletionTool[] {
		const allowedNames: Set<string> = new Set(toolNames);
		const includeDynamicTools: boolean = allowedNames.has(CUSTOM_MCP_TOOLS_SENTINEL);
		return this.getEntries()
			.filter((entry: ToolCatalogEntry): boolean => allowedNames.has(entry.id) || (includeDynamicTools && isDynamicMcpToolName(entry.id)))
			.map((entry: ToolCatalogEntry): ChatCompletionTool => entry.definition);
	}

	getEntry(toolName: string): ToolCatalogEntry | undefined {
		return this.getEntries().find((entry: ToolCatalogEntry): boolean => entry.id === toolName);
	}

	resolveMapping(toolName: string): ToolMapping {
		const entry: ToolCatalogEntry | undefined = this.getEntry(toolName);
		if (entry === undefined) {
			throw new Error(`Unknown tool: ${toolName}`);
		}
		return entry.mapping;
	}

	getPolicy(toolName: string): ToolPolicy | undefined {
		return this.getEntry(toolName)?.policy;
	}

	getToolNamesForPhase(phase: ToolPhaseEligibility): string[] {
		return this.getEntries()
			.filter((entry: ToolCatalogEntry): boolean => entry.phaseEligibility.includes(phase))
			.map((entry: ToolCatalogEntry): string => entry.id);
	}
}

export function createWorkspaceToolCatalog(context: ToolExecutionContext = {}): WorkspaceToolCatalog {
	return new WorkspaceToolCatalog(context);
}
