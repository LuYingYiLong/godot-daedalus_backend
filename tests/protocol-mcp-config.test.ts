import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../src/protocol/schema.js";

test("mcp.config.update schema accepts stdio and http updates", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-stdio",
		method: "mcp.config.update",
		params: {
			serverId: "custom-demo",
			description: "Updated",
			transport: "stdio",
			enabled: true,
			planAccess: "read",
			command: "npx",
			args: ["-y", "demo"],
			env: {
				TOKEN: "",
				NEW_TOKEN: "new-value",
				OPTIONAL: null
			}
		}
	}).success, true);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-http",
		method: "mcp.config.update",
		params: {
			serverId: "custom-demo",
			transport: "http",
			planAccess: "disabled",
			url: "https://example.com/mcp",
			headers: {
				Authorization: ""
			}
		}
	}).success, true);
});

test("mcp.config.add schema accepts plan-safe custom MCP access", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-add-plan-safe",
		method: "mcp.config.add",
		params: {
			name: "context7",
			transport: "stdio",
			planAccess: "read",
			command: "npx",
			args: ["-y", "@upstash/context7-mcp"]
		}
	}).success, true);
});

test("mcp.config.update schema rejects invalid update payloads", (): void => {
	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-missing-id",
		method: "mcp.config.update",
		params: {
			transport: "stdio",
			command: "npx"
		}
	}).success, false);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-bad-url",
		method: "mcp.config.update",
		params: {
			serverId: "custom-demo",
			transport: "http",
			url: "not-a-url"
		}
	}).success, false);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-rename",
		method: "mcp.config.update",
		params: {
			serverId: "custom-demo",
			name: "Renamed",
			transport: "stdio",
			command: "npx"
		}
	}).success, false);

	assert.equal(clientRequestSchema.safeParse({
		type: "request",
		id: "mcp-update-bad-plan-access",
		method: "mcp.config.update",
		params: {
			serverId: "custom-demo",
			transport: "stdio",
			planAccess: "write",
			command: "npx"
		}
	}).success, false);
});
