import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	getToolDefinitions,
	getToolDefinitionsForNames
} from "../src/tools/builtin-tool-definitions.js";
import {
	getDynamicMcpToolMetadata,
	getPlanSafeDynamicMcpToolNames,
	isPlanSafeDynamicMcpToolName,
	replaceDynamicMcpTools
} from "../src/tools/dynamic-mcp-tools.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../src/tools/tool-sentinels.js";
import { resolveToolMapping } from "../src/tools/tool-mapping.js";

type FunctionTool = ReturnType<typeof getToolDefinitions>[number] & {
	type: "function";
	function: {
		name: string;
	};
};

afterEach((): void => {
	replaceDynamicMcpTools([]);
});

function isFunctionTool(tool: ReturnType<typeof getToolDefinitions>[number]): tool is FunctionTool {
	return tool.type === "function" && "function" in tool;
}

function getToolNames(): string[] {
	return getToolDefinitions()
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name);
}

test("builtin tool definitions expose representative Godot tools", (): void => {
	const names: string[] = getToolNames();

	assert.ok(names.includes("mcp_godot_read_text_file"));
	assert.ok(names.includes("mcp_godot_propose_replace_text_in_file"));
	assert.ok(names.includes("mcp_godot_apply_scene_patch"));
	assert.ok(names.includes("mcp_terminal_get_job_status"));
	assert.ok(names.includes("mcp_terminal_cancel_job"));
});

test("dynamic MCP tools are included only through the custom sentinel", (): void => {
	replaceDynamicMcpTools([
		{
			serverId: "custom-server",
			serverName: "Custom Server",
			toolName: "make_level",
			description: "创建测试关卡",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string" }
				},
				required: ["name"]
			}
		}
	]);

	const withoutSentinel: string[] = getToolDefinitionsForNames(["mcp_godot_read_text_file"])
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name);
	const withSentinel: string[] = getToolDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL])
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name);
	const dynamicName: string | undefined = withSentinel.find((name: string): boolean => name.startsWith("mcp_custom_"));

	assert.deepEqual(withoutSentinel, ["mcp_godot_read_text_file"]);
	assert.notEqual(dynamicName, undefined);
	assert.equal(getDynamicMcpToolMetadata(dynamicName ?? "")?.toolName, "make_level");
});

test("tool mapping resolves builtin and dynamic tools", (): void => {
	assert.deepEqual(resolveToolMapping("mcp_godot_read_text_file"), {
		serverId: "godot",
		toolName: "read_text_file"
	});
	assert.deepEqual(resolveToolMapping("mcp_terminal_get_job_status"), {
		serverId: "terminal",
		toolName: "get_terminal_job_status"
	});

	replaceDynamicMcpTools([
		{
			serverId: "external",
			serverName: "External",
			toolName: "write_asset"
		}
	]);

	const dynamicName: string | undefined = getToolDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL])
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name)
		.find((name: string): boolean => name.startsWith("mcp_custom_"));

	assert.notEqual(dynamicName, undefined);
	assert.deepEqual(resolveToolMapping(dynamicName ?? ""), {
		serverId: "external",
		toolName: "write_asset"
	});
});

test("dynamic MCP tools expose plan-safe metadata only when explicitly marked read", (): void => {
	replaceDynamicMcpTools([
		{
			serverId: "context7",
			serverName: "context7",
			toolName: "resolve-library-id",
			planAccess: "read"
		},
		{
			serverId: "writer",
			serverName: "Writer",
			toolName: "write_file"
		}
	]);

	const dynamicNames: string[] = getToolDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL])
		.filter(isFunctionTool)
		.map((tool): string => tool.function.name);
	const planSafeNames: string[] = getPlanSafeDynamicMcpToolNames();
	const contextName: string | undefined = dynamicNames.find((name: string): boolean => getDynamicMcpToolMetadata(name)?.serverId === "context7");
	const writerName: string | undefined = dynamicNames.find((name: string): boolean => getDynamicMcpToolMetadata(name)?.serverId === "writer");

	assert.notEqual(contextName, undefined);
	assert.notEqual(writerName, undefined);
	assert.deepEqual(planSafeNames, [contextName]);
	assert.equal(isPlanSafeDynamicMcpToolName(contextName ?? ""), true);
	assert.equal(isPlanSafeDynamicMcpToolName(writerName ?? ""), false);
});
