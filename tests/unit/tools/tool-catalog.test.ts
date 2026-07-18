import assert from "node:assert/strict";
import test from "node:test";
import { clearDynamicMcpToolsForWorkspace, replaceDynamicMcpToolsForWorkspace } from "../../../src/tools/dynamic-mcp-tools.js";
import { createWorkspaceToolCatalog } from "../../../src/tools/tool-catalog.js";
import { filterToolNamesForWorkspace, getDefaultWorkflowToolNames } from "../../../src/tools/tool-catalog.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../../../src/tools/tool-sentinels.js";

function getFunctionToolName(tool: { type: string; function?: { name: string } | undefined }): string {
	assert.equal(tool.type, "function");
	const functionDefinition: { name: string } | undefined = tool.function;
	assert.notEqual(functionDefinition, undefined);
	if (functionDefinition === undefined) {
		throw new Error("Expected a function tool");
	}
	return functionDefinition.name;
}

test("workspace tool catalog keeps dynamic MCP definitions isolated", (): void => {
	replaceDynamicMcpToolsForWorkspace("catalog-a", [{
		serverId: "a",
		serverName: "Catalog A",
		toolName: "inspect",
		planAccess: "read"
	}]);
	replaceDynamicMcpToolsForWorkspace("catalog-b", [{
		serverId: "b",
		serverName: "Catalog B",
		toolName: "mutate"
	}]);

	try {
		const catalogA = createWorkspaceToolCatalog({ workspaceId: "catalog-a" });
		const catalogB = createWorkspaceToolCatalog({ workspaceId: "catalog-b" });
		const dynamicA = catalogA.getDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL]);
		const dynamicB = catalogB.getDefinitionsForNames([CUSTOM_MCP_TOOLS_SENTINEL]);
		const nameA: string = getFunctionToolName(dynamicA[0]!);
		const nameB: string = getFunctionToolName(dynamicB[0]!);

		assert.notEqual(nameA, nameB);
		assert.deepEqual(catalogA.resolveMapping(nameA), { serverId: "a", toolName: "inspect" });
		assert.equal(catalogA.getPolicy(nameA)?.risk, "write");
		assert.equal(catalogA.getToolNamesForPhase("read").includes(nameA), true);
		assert.equal(catalogB.getEntry(nameA), undefined);
	} finally {
		clearDynamicMcpToolsForWorkspace("catalog-a");
		clearDynamicMcpToolsForWorkspace("catalog-b");
	}
});

test("workspace tool catalog keeps builtin metadata complete", (): void => {
	const catalog = createWorkspaceToolCatalog({ workspaceId: "workspace-a" });
	const sceneCapture = catalog.getEntry("mcp_godot_editor_capture_scene_view");
	assert.deepEqual(sceneCapture?.mapping, { serverId: "godot_editor", toolName: "capture_scene_view" });
	assert.equal(sceneCapture?.policy.risk, "read");
	assert.equal(sceneCapture?.capabilityRequirement, "sceneViewCapture");
});

test("workspace runtime filter hides Godot tools without an active workspace", (): void => {
	const names: string[] = filterToolNamesForWorkspace([
		"mcp_skills_load",
		"mcp_godot_get_runtime_status",
		"mcp_image_generate",
		"mcp_web_search"
	], undefined).sort();
	assert.deepEqual(names, ["mcp_image_generate", "mcp_web_search"]);
	assert.deepEqual(filterToolNamesForWorkspace(getDefaultWorkflowToolNames("write"), undefined), ["mcp_image_generate"]);
});

test("workflow defaults are catalog-backed and resolve to known tools", (): void => {
	const catalog = createWorkspaceToolCatalog({ workspaceId: "workspace-a" });
	for (const group of ["read", "verify", "write"] as const) {
		for (const toolName of getDefaultWorkflowToolNames(group)) {
			if (toolName === CUSTOM_MCP_TOOLS_SENTINEL) {
				continue;
			}
			assert.notEqual(catalog.getEntry(toolName), undefined, `${group} tool is missing from catalog: ${toolName}`);
		}
	}
});
