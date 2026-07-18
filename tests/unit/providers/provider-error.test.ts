import assert from "node:assert/strict";
import test from "node:test";
import { classifyProviderError, createProviderStatusEvent } from "../../../src/providers/provider-error.js";

test("provider quota errors are classified by status and message", (): void => {
	assert.equal(classifyProviderError({ status: 402, message: "Payment Required" }).code, "provider_quota_exhausted");
	assert.equal(classifyProviderError(new Error("insufficient balance")).code, "provider_quota_exhausted");
	assert.equal(classifyProviderError(new Error("余额不足，请充值")).code, "provider_quota_exhausted");
});

test("generic provider errors stay generic", (): void => {
	const result = classifyProviderError(new Error("upstream timeout"));

	assert.equal(result.code, "provider_error");
	assert.equal(result.message, "upstream timeout");
});

test("quota status event uses visual status fields", (): void => {
	const event = createProviderStatusEvent(new Error("insufficient quota"));

	assert.equal(event.status, "error");
	assert.equal(event.code, "provider_quota_exhausted");
	assert.equal(event.actionId, "provider-settings");
});
