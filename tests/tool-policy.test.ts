import assert from "node:assert/strict";
import test from "node:test";
import { ReadOnlyToolApprovalGateway } from "../src/tools/approval-gateway.js";
import { getDynamicMcpToolNames, replaceDynamicMcpTools } from "../src/tools/dynamic-mcp-tools.js";
import { evaluateToolCall, getEffectiveToolPolicy, getToolPolicy } from "../src/tools/tool-policy.js";

const readTool: string = "mcp_godot_read_text_file";
const verifyTool: string = "mcp_terminal_run_safe_preset";
const proposeTool: string = "mcp_godot_propose_create_text_file";
const writeTool: string = "mcp_godot_create_text_file";
const destructiveTool: string = "mcp_godot_delete_file";
const dynamicMcpTool: string = "mcp_custom_server_tool_12345678";

test("tool policy classifies representative risks", (): void => {
	assert.equal(getToolPolicy(readTool)?.risk, "read");
	assert.equal(getToolPolicy("mcp_terminal_get_job_status")?.risk, "read");
	assert.equal(getToolPolicy("mcp_terminal_get_job_tail")?.risk, "read");
	assert.equal(getToolPolicy(verifyTool)?.risk, "verify");
	assert.equal(getToolPolicy(proposeTool)?.risk, "propose");
	assert.equal(getToolPolicy(writeTool)?.risk, "write");
	assert.equal(getToolPolicy("mcp_terminal_cancel_job")?.risk, "write");
	assert.equal(getToolPolicy(destructiveTool)?.risk, "destructive");
	assert.equal(getToolPolicy(dynamicMcpTool)?.risk, "write");
});

test("manual mode requests approval for write risks", (): void => {
	assert.equal(evaluateToolCall("manual", readTool, {}).action, "allow");
	assert.equal(evaluateToolCall("manual", verifyTool, {}).action, "allow");
	assert.equal(evaluateToolCall("manual", proposeTool, {}).action, "allow");
	assert.equal(evaluateToolCall("manual", writeTool, {}).action, "request_approval");
	assert.equal(evaluateToolCall("manual", dynamicMcpTool, {}).action, "request_approval");
	assert.equal(evaluateToolCall("manual", destructiveTool, {}).action, "request_approval");
});

test("terminal write preset uses actual preset risk at approval boundary", (): void => {
	assert.equal(getEffectiveToolPolicy("mcp_terminal_run_write_preset", { presetName: "godot.check_only" })?.risk, "verify");
	assert.equal(evaluateToolCall("manual", "mcp_terminal_run_write_preset", {
		presetName: "godot.check_only",
		resourcePath: "scripts/game.gd"
	}).action, "allow");
	assert.equal(evaluateToolCall("manual", "mcp_terminal_run_write_preset", { presetName: "git.init" }).action, "request_approval");
	assert.equal(evaluateToolCall("manual", "mcp_terminal_run_write_preset", { presetName: "godot.list_scenes" }).action, "request_approval");
});

test("auto-safe mode self-approves builtin write tools but not dynamic MCP or destructive tools", (): void => {
	assert.equal(evaluateToolCall("auto-safe", readTool, {}).action, "allow");
	assert.equal(evaluateToolCall("auto-safe", verifyTool, {}).action, "allow");
	assert.equal(evaluateToolCall("auto-safe", proposeTool, {}).action, "allow");
	assert.equal(evaluateToolCall("auto-safe", writeTool, {}).action, "allow");
	assert.equal(evaluateToolCall("auto-safe", dynamicMcpTool, {}).action, "request_approval");
	assert.equal(evaluateToolCall("auto-safe", destructiveTool, {}).action, "request_approval");
});

test("read-only gateway allows only read, verify and plan-safe dynamic MCP tools", async (): Promise<void> => {
	replaceDynamicMcpTools([
		{
			serverId: "custom-context7",
			serverName: "context7",
			toolName: "query-docs",
			description: "Read docs",
			inputSchema: { type: "object" },
			planAccess: "read"
		},
		{
			serverId: "custom-unsafe",
			serverName: "unsafe",
			toolName: "mutate",
			description: "Unknown external mutation",
			inputSchema: { type: "object" }
		}
	]);
	const dynamicToolNames: string[] = getDynamicMcpToolNames();
	const planSafeToolName: string = dynamicToolNames.find((toolName: string): boolean => toolName.includes("context7")) ?? "";
	const unsafeToolName: string = dynamicToolNames.find((toolName: string): boolean => toolName.includes("unsafe")) ?? "";
	const gateway = new ReadOnlyToolApprovalGateway([
		readTool,
		verifyTool,
		writeTool,
		planSafeToolName,
		unsafeToolName
	]);

	assert.equal((await gateway.evaluate(readTool, {}, "call-read")).action, "allow");
	assert.equal((await gateway.evaluate(verifyTool, { presetName: "godot.check_only" }, "call-verify")).action, "allow");
	assert.equal((await gateway.evaluate(writeTool, {}, "call-write")).action, "deny");
	assert.equal((await gateway.evaluate(planSafeToolName, {}, "call-custom-read")).action, "allow");
	assert.equal((await gateway.evaluate(unsafeToolName, {}, "call-custom-unsafe")).action, "deny");
	assert.equal(getToolPolicy(planSafeToolName)?.risk, "write");

	replaceDynamicMcpTools([]);
});

test("bypass mode still requires approval for destructive tools", (): void => {
	assert.equal(evaluateToolCall("bypass", readTool, {}).action, "allow");
	assert.equal(evaluateToolCall("bypass", writeTool, {}).action, "allow");
	assert.equal(evaluateToolCall("bypass", destructiveTool, {}).action, "request_approval");
});

test("unknown tools are denied", (): void => {
	const decision = evaluateToolCall("manual", "mcp_godot_missing_tool", {});
	assert.equal(decision.action, "deny");
	assert.match(decision.reason, /未知工具/);
});
