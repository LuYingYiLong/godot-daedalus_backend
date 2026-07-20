import assert from "node:assert/strict";
import test from "node:test";
import { createToolBudgetRequiredResult, getContinuedMaxSteps, getContinuedToolResultCharLimit } from "../../../src/providers/agent-tool-budget.js";
import type { ChatCompletionsAgentContinuation } from "../../../src/providers/agent-types.js";
import { MAX_TOTAL_TOOL_RESULT_CHARS, TOOL_BUDGET_CONTINUE_STEPS, TOOL_RESULT_CONTINUE_CHARS, resolveToolBudget } from "../../../src/tools/llm-tool-budget.js";

test("default tool budgets are slightly raised for simple and normal runs", (): void => {
	assert.equal(resolveToolBudget("simple"), 6);
	assert.equal(resolveToolBudget("normal"), 12);
	assert.equal(resolveToolBudget("codegen"), 20);
	assert.equal(resolveToolBudget("project_edit"), 30);
});

test("tool budget continuation grants the configured extra step and char budget", (): void => {
	const continuation: ChatCompletionsAgentContinuation = {
		kind: "chat_completions",
		messages: [],
		nextStep: 12,
		totalToolResultChars: 46000,
		maxSteps: 12,
		toolResultCharLimit: MAX_TOTAL_TOOL_RESULT_CHARS
	};

	const result = createToolBudgetRequiredResult({
		limitKind: "steps",
		reason: "工具调用达到最大步数 12",
		usedSteps: 12,
		maxSteps: 12,
		totalToolResultChars: 46000,
		toolResultCharLimit: MAX_TOTAL_TOOL_RESULT_CHARS,
		continuation
	});

	assert.equal(result.additionalSteps, TOOL_BUDGET_CONTINUE_STEPS);
	assert.equal(getContinuedMaxSteps({ message: "继续" }, result.continuation), 22);
	assert.equal(getContinuedToolResultCharLimit(result.continuation), MAX_TOTAL_TOOL_RESULT_CHARS + TOOL_RESULT_CONTINUE_CHARS);
});
