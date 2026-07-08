import assert from "node:assert/strict";
import test from "node:test";
import { shouldDisableThinkingForToolCalls, shouldSkipRequiredToolChoice } from "../src/providers/deepseek-agent.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

test("DeepSeek V4 thinking models skip required tool_choice", (): void => {
	const tools: ChatCompletionTool[] = [{
		type: "function",
		function: {
			name: "mcp_godot_create_scene",
			description: "Create a scene",
			parameters: {
				type: "object",
				properties: {}
			}
		}
	}];
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}), true);
	assert.equal(shouldDisableThinkingForToolCalls({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}, tools), true);
	assert.equal(shouldDisableThinkingForToolCalls({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}, []), false);
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-v4-flash"
	}), true);
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "deepseek",
		apiKey: "test-key",
		model: "deepseek-chat"
	}), false);
	assert.equal(shouldSkipRequiredToolChoice({
		provider: "moonshot",
		apiKey: "test-key",
		model: "deepseek-v4-pro"
	}), true);
	assert.equal(shouldDisableThinkingForToolCalls({
		provider: "moonshot",
		apiKey: "test-key",
		model: "kimi-k2.7-code"
	}, tools), false);
});
