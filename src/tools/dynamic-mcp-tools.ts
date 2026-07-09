import { createHash } from "node:crypto";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { CUSTOM_MCP_TOOL_PREFIX } from "./tool-sentinels.js";
import type { ToolMapping } from "./tool-mapping.js";
import { getCurrentMcpWorkspaceId } from "../mcp/request-context.js";

const MAX_DYNAMIC_TOOLS_TOTAL: number = 96;
const MAX_DYNAMIC_TOOLS_PER_SERVER: number = 32;
const MAX_DYNAMIC_SCHEMA_CHARS: number = 8000;

export type DynamicMcpToolSource = {
	serverId: string;
	serverName: string;
	toolName: string;
	description?: string | undefined;
	inputSchema?: unknown;
	planAccess?: "disabled" | "read" | undefined;
};

export type DynamicMcpToolMetadata = DynamicMcpToolSource & {
	llmToolName: string;
};

const dynamicToolDefinitions: ChatCompletionTool[] = [];
const dynamicToolMap: Map<string, ToolMapping> = new Map();
const dynamicToolMetadata: Map<string, DynamicMcpToolMetadata> = new Map();
const workspaceDynamicTools: Map<string, {
	definitions: ChatCompletionTool[];
	mapping: Map<string, ToolMapping>;
	metadata: Map<string, DynamicMcpToolMetadata>;
}> = new Map();

function buildDynamicToolSet(sources: readonly DynamicMcpToolSource[]): {
	definitions: ChatCompletionTool[];
	mapping: Map<string, ToolMapping>;
	metadata: Map<string, DynamicMcpToolMetadata>;
} {
	const definitions: ChatCompletionTool[] = [];
	const mapping: Map<string, ToolMapping> = new Map();
	const metadata: Map<string, DynamicMcpToolMetadata> = new Map();
	const perServerCounts: Map<string, number> = new Map();
	for (const source of sources) {
		if (definitions.length >= MAX_DYNAMIC_TOOLS_TOTAL) {
			break;
		}

		const nextServerCount: number = (perServerCounts.get(source.serverId) ?? 0) + 1;
		if (nextServerCount > MAX_DYNAMIC_TOOLS_PER_SERVER) {
			continue;
		}
		perServerCounts.set(source.serverId, nextServerCount);

		const llmToolName: string = createDynamicToolName(source);
		const definition: ChatCompletionTool = createDynamicToolDefinition(source, llmToolName);
		definitions.push(definition);
		mapping.set(llmToolName, {
			serverId: source.serverId,
			toolName: source.toolName
		});
		metadata.set(llmToolName, {
			...source,
			llmToolName
		});
	}

	return { definitions, mapping, metadata };
}

function getActiveDynamicToolSet(): {
	definitions: ChatCompletionTool[];
	mapping: Map<string, ToolMapping>;
	metadata: Map<string, DynamicMcpToolMetadata>;
} {
	const workspaceId: string | undefined = getCurrentMcpWorkspaceId();
	if (workspaceId !== undefined) {
		return workspaceDynamicTools.get(workspaceId) ?? {
			definitions: [],
			mapping: new Map(),
			metadata: new Map()
		};
	}

	return {
		definitions: dynamicToolDefinitions,
		mapping: dynamicToolMap,
		metadata: dynamicToolMetadata
	};
}

function slugifyToolPart(value: string, maxLength: number): string {
	const slug: string = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, maxLength);
	return slug.length > 0 ? slug : "tool";
}

function createDynamicToolName(source: DynamicMcpToolSource): string {
	const serverSlug: string = slugifyToolPart(source.serverName || source.serverId, 16);
	const toolSlug: string = slugifyToolPart(source.toolName, 27);
	const hash: string = createHash("sha1")
		.update(`${source.serverId}\n${source.toolName}`)
		.digest("hex")
		.slice(0, 8);
	return `${CUSTOM_MCP_TOOL_PREFIX}${serverSlug}_${toolSlug}_${hash}`;
}

function sanitizeDynamicInputSchema(inputSchema: unknown): Record<string, unknown> {
	if (inputSchema === null || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
		return {
			type: "object",
			properties: {},
			additionalProperties: true
		};
	}

	const schema: Record<string, unknown> = { ...(inputSchema as Record<string, unknown>) };
	delete schema.$schema;
	if (schema.type !== "object") {
		schema.type = "object";
	}
	if (JSON.stringify(schema).length > MAX_DYNAMIC_SCHEMA_CHARS) {
		return {
			type: "object",
			properties: {},
			additionalProperties: true
		};
	}

	return schema;
}

function createDynamicToolDefinition(source: DynamicMcpToolSource, llmToolName: string): ChatCompletionTool {
	const descriptionParts: string[] = [
		`自定义 MCP 工具，来自 server "${source.serverName}" 的工具 "${source.toolName}"。`,
		"该工具由用户配置的外部 MCP server 提供，默认按写风险处理，调用前会走审批。"
	];
	if (source.description !== undefined && source.description.trim().length > 0) {
		descriptionParts.push(source.description.trim());
	}

	return {
		type: "function",
		function: {
			name: llmToolName,
			description: descriptionParts.join(" ").slice(0, 1024),
			parameters: sanitizeDynamicInputSchema(source.inputSchema)
		}
	};
}

export function replaceDynamicMcpTools(sources: readonly DynamicMcpToolSource[]): void {
	const toolSet = buildDynamicToolSet(sources);
	dynamicToolDefinitions.length = 0;
	dynamicToolMap.clear();
	dynamicToolMetadata.clear();
	dynamicToolDefinitions.push(...toolSet.definitions);
	for (const [key, value] of toolSet.mapping) {
		dynamicToolMap.set(key, value);
	}
	for (const [key, value] of toolSet.metadata) {
		dynamicToolMetadata.set(key, value);
	}
}

export function replaceDynamicMcpToolsForWorkspace(workspaceId: string, sources: readonly DynamicMcpToolSource[]): void {
	workspaceDynamicTools.set(workspaceId, buildDynamicToolSet(sources));
}

export function clearDynamicMcpToolsForWorkspace(workspaceId: string): void {
	workspaceDynamicTools.delete(workspaceId);
}

export function getDynamicMcpToolNames(): string[] {
	return Array.from(getActiveDynamicToolSet().mapping.keys());
}

export function getPlanSafeDynamicMcpToolNames(): string[] {
	return Array.from(getActiveDynamicToolSet().metadata.entries())
		.filter(([_toolName, metadata]: [string, DynamicMcpToolMetadata]): boolean => metadata.planAccess === "read")
		.map(([toolName]: [string, DynamicMcpToolMetadata]): string => toolName);
}

export function isDynamicMcpToolName(toolName: string): boolean {
	return toolName.startsWith(CUSTOM_MCP_TOOL_PREFIX);
}

export function getDynamicMcpToolMetadata(toolName: string): DynamicMcpToolMetadata | undefined {
	return getActiveDynamicToolSet().metadata.get(toolName);
}

export function isPlanSafeDynamicMcpToolName(toolName: string): boolean {
	return getDynamicMcpToolMetadata(toolName)?.planAccess === "read";
}

export function getDynamicMcpToolDefinitions(): ChatCompletionTool[] {
	return [...getActiveDynamicToolSet().definitions];
}

export function getDynamicMcpToolMapping(toolName: string): ToolMapping | undefined {
	return getActiveDynamicToolSet().mapping.get(toolName);
}
