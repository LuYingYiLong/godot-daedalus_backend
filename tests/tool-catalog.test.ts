import assert from "node:assert/strict";
import test from "node:test";
import { clearDynamicMcpToolsForWorkspace, replaceDynamicMcpToolsForWorkspace } from "../src/tools/dynamic-mcp-tools.js";
import { createWorkspaceToolCatalog } from "../src/tools/tool-catalog.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../src/tools/tool-sentinels.js";

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
	const catalog = createWorkspaceToolCatalog();
	const sceneCapture = catalog.getEntry("mcp_godot_editor_capture_scene_view");
	assert.deepEqual(sceneCapture?.mapping, { serverId: "godot_editor", toolName: "capture_scene_view" });
	assert.equal(sceneCapture?.policy.risk, "read");
	assert.equal(sceneCapture?.capabilityRequirement, "sceneViewCapture");
});
