import assert from "node:assert/strict";
import test from "node:test";
import { composeSystemPrompt } from "../src/prompts/registry.js";

test("system prompt includes runtime provider and model context", async (): Promise<void> => {
	const prompt: string = await composeSystemPrompt(
		"godot.assistant",
		undefined,
		"当前后端实际模型供应商：Moonshot/Kimi（provider id: moonshot）。\n当前后端实际模型 ID：kimi-k2.6。"
	);

	assert.match(prompt, /Runtime 当前模型上下文/);
	assert.match(prompt, /Moonshot\/Kimi/);
	assert.match(prompt, /kimi-k2\.6/);
	assert.match(prompt, /不要用产品角色回避或替代模型\/供应商事实/);
});
