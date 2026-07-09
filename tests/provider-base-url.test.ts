import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfiguredProviderBaseUrl, resolveProviderBaseUrl } from "../src/providers/provider-base-url.js";

test("provider base url resolves empty values to provider defaults", (): void => {
	assert.equal(resolveProviderBaseUrl("deepseek", undefined), "https://api.deepseek.com");
	assert.equal(resolveProviderBaseUrl("deepseek", ""), "https://api.deepseek.com");
	assert.equal(resolveProviderBaseUrl("deepseek", "   "), "https://api.deepseek.com");
	assert.equal(resolveProviderBaseUrl("moonshot", null), "https://api.moonshot.cn/v1");
});

test("provider base url normalizes custom request endpoints", (): void => {
	assert.equal(normalizeConfiguredProviderBaseUrl(" https://proxy.example/v1/// "), "https://proxy.example/v1");
	assert.equal(resolveProviderBaseUrl("deepseek", "https://proxy.example/v1/"), "https://proxy.example/v1");
});
