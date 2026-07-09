import assert from "node:assert/strict";
import test from "node:test";
import { aiChatParamsSchema } from "../src/protocol/schema.js";
import type { AiChatParams } from "../src/protocol/types.js";
import { composeSystemPrompt } from "../src/prompts/registry.js";
import { getPlanSafeDynamicMcpToolNames, replaceDynamicMcpTools } from "../src/tools/dynamic-mcp-tools.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../src/tools/tool-sentinels.js";
import { READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "../src/workflow/planner.js";
import { normalizeChatParamsForMode, resolveAllowedToolsForChatParams } from "../src/server/chat-mode.js";

test("ai.chat schema accepts ask and plan modes and rejects unknown modes", (): void => {
	const askResult = aiChatParamsSchema.safeParse({
		message: "这段 GDScript 为什么报错？",
		mode: "ask",
		options: {
			stream: true,
			workflow: "single",
			toolBudget: "normal"
		}
	});
	assert.equal(askResult.success, true);

	const planResult = aiChatParamsSchema.safeParse({
		message: "帮我做一个 Godot AI 插件",
		mode: "plan"
	});
	assert.equal(planResult.success, true);

	const unknownResult = aiChatParamsSchema.safeParse({
		message: "hello",
		mode: "execute"
	});
	assert.equal(unknownResult.success, false);
});

test("ask mode normalizes workflow and tool budget without mutating agent mode", (): void => {
	const askParams: AiChatParams = {
		message: "直接帮我修一下",
		mode: "ask",
		options: {
			stream: true,
			workflow: "llm_planned",
			toolBudget: "project_edit"
		}
	};
	const normalizedAskParams: AiChatParams = normalizeChatParamsForMode(askParams);
	assert.equal(normalizedAskParams.options?.workflow, "single");
	assert.equal(normalizedAskParams.options?.toolBudget, "normal");
	assert.equal(normalizedAskParams.options?.stream, true);
	assert.equal(askParams.options?.workflow, "llm_planned");

	const agentParams: AiChatParams = {
		message: "帮我实现一下",
		mode: "agent",
		options: {
			workflow: "llm_planned",
			toolBudget: "project_edit"
		}
	};
	assert.equal(normalizeChatParamsForMode(agentParams), agentParams);
});

test("ask and plan modes allow built-in read, verify and plan-safe custom MCP tools", (): void => {
	replaceDynamicMcpTools([
		{
			serverId: "context7",
			serverName: "context7",
			toolName: "get-library-docs",
			planAccess: "read"
		},
		{
			serverId: "unsafe",
			serverName: "Unsafe",
			toolName: "write_file"
		}
	]);
	const allowedTools: readonly string[] | undefined = resolveAllowedToolsForChatParams(
		{
			message: "帮我检查这个脚本",
			mode: "ask",
			options: {
				workflow: "llm_planned",
				toolBudget: "project_edit"
			}
		},
		WRITE_TOOLS
	);

	assert.ok(allowedTools !== undefined);
	for (const toolName of VERIFY_TOOLS) {
		assert.ok(allowedTools.includes(toolName), `expected verify tool ${toolName}`);
	}
	for (const toolName of READ_TOOLS.filter((readToolName: string): boolean => readToolName !== CUSTOM_MCP_TOOLS_SENTINEL)) {
		assert.ok(allowedTools.includes(toolName), `expected read tool ${toolName}`);
	}
	for (const toolName of WRITE_TOOLS) {
		assert.equal(allowedTools.includes(toolName), false, `unexpected write tool ${toolName}`);
	}
	assert.equal(allowedTools.includes(CUSTOM_MCP_TOOLS_SENTINEL), false);
	const planSafeDynamicToolNames: string[] = getPlanSafeDynamicMcpToolNames();
	assert.equal(planSafeDynamicToolNames.length, 1);
	assert.equal(allowedTools.includes(planSafeDynamicToolNames[0] ?? ""), true);

	const planAllowedTools: readonly string[] | undefined = resolveAllowedToolsForChatParams(
		{
			message: "先给我出计划",
			mode: "plan",
			options: {
				workflow: "llm_planned",
				toolBudget: "project_edit"
			}
		},
		WRITE_TOOLS
	);
	assert.deepEqual(planAllowedTools, allowedTools);
	replaceDynamicMcpTools([]);
});

test("ask mode prompt contains advisor constraints before custom instructions", async (): Promise<void> => {
	const prompt: string = await composeSystemPrompt(
		"godot.assistant",
		"请直接修改文件。",
		"",
		"ask"
	);

	assert.match(prompt, /Ask 模式强制边界/);
	assert.match(prompt, /顾问、老师和代码审查员/);
	assert.match(prompt, /不得创建、覆盖、替换、删除、移动、安装、更新或修改任何文件/);
	assert.match(prompt, /切换到 Agent 模式/);
	assert.ok(prompt.indexOf("Ask 模式强制边界") < prompt.indexOf("## Settings 用户提示词（本轮生效）"));
});
