import assert from "node:assert/strict";
import test from "node:test";
import {
	getCatalogModels,
	getProviderAdapterFamily,
	getProviderDefaultEndpointType,
	getProviderDefaultModel,
	getProviderFallbackModels,
	getProviderIds,
	isProviderId
} from "../src/providers/provider-registry.js";

test("provider catalog exposes valid built-in providers and model references", (): void => {
	const providerIds: string[] = getProviderIds();
	assert.deepEqual(providerIds, ["deepseek", "moonshot", "openai"]);
	assert.equal(isProviderId("deepseek"), true);
	assert.equal(isProviderId("unknown"), false);

	for (const provider of providerIds) {
		const defaultModel: string = getProviderDefaultModel(provider);
		const fallbackModels = getProviderFallbackModels(provider);
		assert.ok(fallbackModels.some((model) => model.id === defaultModel));
		for (const model of fallbackModels) {
			assert.equal(model.provider, provider);
			assert.ok(model.contextWindowTokens > 0);
			assert.ok(model.maxOutputTokens > 0);
		}
	}

	assert.equal(getProviderDefaultEndpointType("deepseek"), "openai-chat-completions");
	assert.equal(getProviderAdapterFamily("deepseek"), "openai-compatible");
	assert.equal(getProviderDefaultEndpointType("openai"), "openai-responses");
	assert.equal(getProviderAdapterFamily("openai"), "openai-responses");
	assert.equal(getCatalogModels().length >= providerIds.length, true);
});
