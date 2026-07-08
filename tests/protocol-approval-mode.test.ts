import assert from "node:assert/strict";
import test from "node:test";
import { clientRequestSchema } from "../src/protocol/schema.js";

function createApprovalModeRequest(mode: string): Record<string, unknown> {
	return {
		type: "request",
		id: `approval-mode-${mode}`,
		method: "approval.mode.set",
		params: { mode }
	};
}

test("approval.mode.set accepts only public approval modes", (): void => {
	assert.equal(clientRequestSchema.safeParse(createApprovalModeRequest("manual")).success, true);
	assert.equal(clientRequestSchema.safeParse(createApprovalModeRequest("auto-safe")).success, true);
	assert.equal(clientRequestSchema.safeParse(createApprovalModeRequest("read-only")).success, false);
});
