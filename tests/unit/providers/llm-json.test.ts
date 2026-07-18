import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonObjectFromLlm } from "../../../src/providers/llm-json.js";

test("LLM JSON parser accepts fenced JSON objects", (): void => {
	const parsed = parseJsonObjectFromLlm("```json\n{\"ok\":true}\n```", "bad json");

	assert.deepEqual(parsed, { ok: true });
});

test("LLM JSON parser extracts an object from surrounding text", (): void => {
	const parsed = parseJsonObjectFromLlm("说明文字\n{\"items\":[1,2,3]}\n尾部文字", "bad json");

	assert.deepEqual(parsed, { items: [1, 2, 3] });
});

test("LLM JSON parser hides native parse errors behind stable messages", (): void => {
	assert.throws(
		(): unknown => parseJsonObjectFromLlm("{\"steps\":[{\"title\":\"a\"} {\"title\":\"b\"}]}", "planner json failed"),
		(error: unknown): boolean => {
			assert.ok(error instanceof Error);
			assert.equal(error.message, "planner json failed");
			assert.equal(error.message.includes("Expected ','"), false);
			return true;
		}
	);
});
