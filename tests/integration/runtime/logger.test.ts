import assert from "node:assert/strict";
import test from "node:test";
import { redactForLog } from "../../../src/logger.js";

test("logger redacts secrets and clips large values", (): void => {
	const redacted = redactForLog({
		apiKey: "sk-secret",
		headers: {
			Authorization: "Bearer abc",
			"x-safe": "ok"
		},
		nested: {
			customSecret: "value",
			refreshToken: "token-value",
			password: "pass-value"
		},
		longText: "x".repeat(2500)
	}) as Record<string, unknown>;

	assert.equal(redacted.apiKey, "[redacted]");
	const headers = redacted.headers as Record<string, unknown>;
	assert.equal(headers.Authorization, "[redacted]");
	assert.equal(headers["x-safe"], "ok");
	const nested = redacted.nested as Record<string, unknown>;
	assert.equal(nested.customSecret, "[redacted]");
	assert.equal(nested.refreshToken, "[redacted]");
	assert.equal(nested.password, "[redacted]");
	assert.match(String(redacted.longText), /\[truncated 500 chars\]$/);
});
