import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GODOT_MCP_RESOURCE_NAMES, GODOT_MCP_TOOL_NAMES } from "../../../src/mcp/godot/tools/tool-registration.js";

type FakeMcpServer = {
	toolNames: string[];
	resourceNames: string[];
	registerTool(name: string, ..._rest: unknown[]): void;
	registerResource(name: string, ..._rest: unknown[]): void;
};

function createFakeServer(): FakeMcpServer {
	return {
		toolNames: [],
		resourceNames: [],
		registerTool(name: string): void {
			this.toolNames.push(name);
		},
		registerResource(name: string): void {
			this.resourceNames.push(name);
		}
	};
}

test("Godot MCP registration manifest matches registered tools and resources", async (): Promise<void> => {
	process.env.GODOT_PROJECT_PATH = path.join(os.tmpdir(), "daedalus-registration-test");
	const { registerGodotToolsAndResources } = await import("../../../src/mcp/godot/registration.js");
	const server: FakeMcpServer = createFakeServer();

	registerGodotToolsAndResources(server as never);

	assert.deepEqual(server.toolNames.toSorted(), [...GODOT_MCP_TOOL_NAMES].toSorted());
	assert.deepEqual(server.resourceNames.toSorted(), [...GODOT_MCP_RESOURCE_NAMES].toSorted());
});
