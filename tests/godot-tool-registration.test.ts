import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { GODOT_MCP_RESOURCE_NAMES, GODOT_MCP_TOOL_NAMES } from "../src/mcp/godot-tool-registration.js";

function uniqueMatches(source: string, pattern: RegExp): string[] {
	const values: string[] = [];
	for (const match of source.matchAll(pattern)) {
		const value: string | undefined = match[1];
		if (value !== undefined && !values.includes(value)) {
			values.push(value);
		}
	}
	return values;
}

test("Godot MCP registration manifest matches registered tools and resources", async (): Promise<void> => {
	const serverPath: string = path.resolve(process.cwd(), "src/mcp/godot/server.ts");
	const source: string = await readFile(serverPath, "utf8");
	const toolNames: string[] = uniqueMatches(source, /server\.registerTool\(\s*"([^"]+)"/g);
	const resourceNames: string[] = uniqueMatches(source, /server\.registerResource\(\s*"([^"]+)"/g);

	assert.deepEqual(toolNames.toSorted(), [...GODOT_MCP_TOOL_NAMES].toSorted());
	assert.deepEqual(resourceNames.toSorted(), [...GODOT_MCP_RESOURCE_NAMES].toSorted());
});
