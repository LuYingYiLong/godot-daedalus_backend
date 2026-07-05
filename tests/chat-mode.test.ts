import assert from "node:assert/strict";
import test from "node:test";
import { aiChatParamsSchema } from "../src/protocol/schema.js";
import type { AiChatParams } from "../src/protocol/types.js";
import { composeSystemPrompt } from "../src/prompts/registry.js";
import { CUSTOM_MCP_TOOLS_SENTINEL } from "../src/tools/llm-tools.js";
import { READ_TOOLS, VERIFY_TOOLS, WRITE_TOOLS } from "../src/workflow/planner.js";
import { normalizeChatParamsForMode, resolveAllowedToolsForChatParams } from "../src/server/chat-mode.js";

test("ai.chat schema accepts ask mode and rejects unknown modes", (): void => {
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

	const unknownResult = aiChatParamsSchema.safeParse({
		message: "hello",
		mode: "plan"
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

test("ask mode allows built-in read and verify tools but blocks write tools and custom MCP", (): void => {
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
	assert.ok(prompt.indexOf("Ask 模式强制边界") < prompt.indexOf("Settings 用户提示词"));
});
