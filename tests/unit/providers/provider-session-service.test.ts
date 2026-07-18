import assert from "node:assert/strict";
import test from "node:test";
import { applyProviderConfigToRuntime, type ProviderSessionRuntime } from "../../../src/application/provider-session-service.js";
import { getDefaultModelProfile } from "../../../src/tokens/model-profiles.js";

function createRuntime(): ProviderSessionRuntime {
	return {
		activeProvider: "deepseek",
		providerApiKey: "deepseek-key",
		providerModel: "deepseek-v4-pro",
		providerBaseUrl: "https://api.deepseek.com/v1",
		modelProfile: getDefaultModelProfile("deepseek")
	};
}

test("switching provider without a key clears the previous runtime credential", (): void => {
	const runtime: ProviderSessionRuntime = createRuntime();

	applyProviderConfigToRuntime(runtime, {
		provider: "zhipu",
		model: "glm-5.3"
	});

	assert.equal(runtime.activeProvider, "zhipu");
	assert.equal(runtime.providerModel, "glm-5.3");
	assert.equal(runtime.providerApiKey, undefined);
	assert.equal(runtime.providerBaseUrl, undefined);
	assert.equal(runtime.modelProfile.provider, "zhipu");
	assert.equal(runtime.modelProfile.model, "glm-5.3");
});
