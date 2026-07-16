import assert from "node:assert/strict";
import test from "node:test";
import {
	getCatalogModels,
	getProviderAdapterFamily,
	getProviderDefinition,
	getProviderDefaultEndpointType,
	getProviderDefaultModel,
	getProviderFallbackModels,
	getProviderIds,
	isProviderId
} from "../src/providers/provider-registry.js";
import { listProviderModels } from "../src/providers/provider-models.js";

test("provider catalog exposes valid built-in providers and model references", (): void => {
	const providerIds: string[] = getProviderIds();
	assert.deepEqual(providerIds, ["deepseek", "moonshot", "openai", "zhipu", "dashscope", "volcengine", "minimax"]);
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
	assert.equal(getProviderDefaultModel("zhipu"), "glm-5.2");
	assert.equal(getProviderDefaultEndpointType("zhipu"), "openai-chat-completions");
	assert.equal(getProviderAdapterFamily("zhipu"), "openai-compatible");
	const zhipuModels = getProviderFallbackModels("zhipu");
	assert.equal(zhipuModels.find((model) => model.id === "glm-5v-turbo")?.capabilities.imageInput, true);
	assert.equal(zhipuModels.find((model) => model.id === "glm-5v-turbo")?.capabilities.vision, true);
	assert.equal(zhipuModels.find((model) => model.id === "glm-5.2")?.capabilities.reasoning, true);
	assert.equal(zhipuModels.find((model) => model.id === "glm-5.2")?.capabilities.tools, true);
	assert.equal(zhipuModels.find((model) => model.id === "glm-5.2")?.contextWindowTokens, 1_000_000);
	assert.equal(getProviderDefaultModel("dashscope"), "qwen3.7-plus");
	assert.equal(getProviderDefinition("dashscope").modelListMode, "catalog-recommended");
	assert.equal(getProviderDefaultEndpointType("dashscope"), "openai-chat-completions");
	assert.equal(getProviderAdapterFamily("dashscope"), "openai-compatible");
	const dashscopeModels = getProviderFallbackModels("dashscope");
	assert.equal(dashscopeModels.find((model) => model.id === "qwen3.7-plus")?.capabilities.reasoning, true);
	assert.equal(dashscopeModels.find((model) => model.id === "qwen3.7-plus")?.capabilities.tools, true);
	assert.equal(dashscopeModels.find((model) => model.id === "qwen-image-2.0-pro")?.capabilities.imageGeneration, true);
	assert.equal(dashscopeModels.find((model) => model.id === "qwen-image-2.0-pro")?.capabilities.imageEdit, true);
	assert.equal(dashscopeModels.find((model) => model.id === "qwen-image-2.0-pro-2026-06-22")?.capabilities.imageGeneration, true);
	assert.equal(dashscopeModels.find((model) => model.id === "qwen-image-max")?.capabilities.imageGeneration, true);
	assert.equal(dashscopeModels.find((model) => model.id === "qwen-image-max")?.capabilities.imageEdit, undefined);
	assert.equal(dashscopeModels.find((model) => model.id === "qwen-image-edit")?.capabilities.imageGeneration, undefined);
	assert.equal(dashscopeModels.find((model) => model.id === "qwen-image-edit")?.capabilities.imageEdit, true);
	assert.equal(dashscopeModels.find((model) => model.id === "qwen-image-edit-plus-2025-12-15")?.capabilities.imageEdit, true);
	assert.equal(getProviderDefaultModel("volcengine"), "doubao-seed-evolving");
	assert.equal(getProviderDefinition("volcengine").modelListMode, "catalog-recommended");
	assert.equal(getProviderDefaultEndpointType("volcengine"), "openai-chat-completions");
	assert.equal(getProviderAdapterFamily("volcengine"), "openai-compatible");
	const volcengineModels = getProviderFallbackModels("volcengine");
	assert.equal(volcengineModels.length, 3);
	assert.equal(volcengineModels.find((model) => model.id === "doubao-seed-evolving")?.capabilities.imageInput, true);
	assert.equal(volcengineModels.find((model) => model.id === "doubao-seed-evolving")?.capabilities.videoInput, true);
	assert.equal(volcengineModels.find((model) => model.id === "doubao-seed-evolving")?.capabilities.reasoning, true);
	assert.equal(volcengineModels.find((model) => model.id === "doubao-seed-evolving")?.capabilities.tools, true);
	assert.equal(volcengineModels.find((model) => model.id === "doubao-seed-evolving")?.capabilities.vision, true);
	assert.equal(volcengineModels.find((model) => model.id === "doubao-seed-2-1-pro-260628")?.capabilities.imageInput, true);
	assert.equal(volcengineModels.find((model) => model.id === "doubao-seed-2-1-pro-260628")?.capabilities.tools, true);
	assert.equal(volcengineModels.find((model) => model.id === "doubao-seedream-5-0-pro-260628")?.capabilities.imageGeneration, true);
	assert.equal(volcengineModels.find((model) => model.id === "doubao-seedream-5-0-pro-260628")?.capabilities.imageEdit, undefined);
	assert.equal(getProviderDefaultModel("minimax"), "MiniMax-M3");
	assert.equal(getProviderDefinition("minimax").modelListMode, "catalog-recommended");
	assert.equal(getProviderDefaultEndpointType("minimax"), "openai-chat-completions");
	assert.equal(getProviderAdapterFamily("minimax"), "openai-compatible");
	assert.equal(getProviderDefinition("minimax").defaultBaseUrl, "https://api.minimaxi.com/v1");
	assert.equal(getProviderDefinition("minimax").modelsPath, "/models");
	const minimaxModels = getProviderFallbackModels("minimax");
	assert.equal(minimaxModels.length, 10);
	assert.equal(minimaxModels.find((model) => model.id === "MiniMax-M3")?.contextWindowTokens, 1_000_000);
	assert.equal(minimaxModels.find((model) => model.id === "MiniMax-M3")?.capabilities.imageInput, true);
	assert.equal(minimaxModels.find((model) => model.id === "MiniMax-M3")?.capabilities.videoInput, true);
	assert.equal(minimaxModels.find((model) => model.id === "MiniMax-M3")?.capabilities.reasoning, true);
	assert.equal(minimaxModels.find((model) => model.id === "MiniMax-M3")?.capabilities.tools, true);
	assert.equal(minimaxModels.find((model) => model.id === "MiniMax-M3")?.capabilities.vision, true);
	assert.equal(minimaxModels.find((model) => model.id === "MiniMax-M2.7")?.capabilities.tools, true);
	assert.equal(minimaxModels.find((model) => model.id === "image-01")?.capabilities.imageGeneration, true);
	assert.equal(minimaxModels.find((model) => model.id === "image-01")?.capabilities.imageEdit, undefined);
	assert.equal(minimaxModels.find((model) => model.id === "image-01-live")?.capabilities.imageGeneration, true);
	assert.equal(minimaxModels.find((model) => model.id === "image-01-live")?.capabilities.imageEdit, undefined);
	const openaiModels = getProviderFallbackModels("openai");
	assert.equal(openaiModels.find((model) => model.id === "gpt-5.5")?.capabilities.webSearch, true);
	assert.equal(openaiModels.find((model) => model.id === "gpt-5.5")?.capabilities.vision, true);
	assert.equal(getCatalogModels().length >= providerIds.length, true);
});

test("provider model list fallback returns normalized capabilities", async (): Promise<void> => {
	const result = await listProviderModels("openai", undefined, undefined);
	const model = result.models.find((item) => item.id === "gpt-5.5");
	const zhipuResult = await listProviderModels("zhipu", undefined, undefined);
	const dashscopeResult = await listProviderModels("dashscope", undefined, undefined);
	const volcengineResult = await listProviderModels("volcengine", undefined, undefined);
	const minimaxResult = await listProviderModels("minimax", undefined, undefined);

	assert.equal(result.source, "fallback");
	assert.equal(model?.capabilities.reasoning, true);
	assert.equal(model?.capabilities.tools, true);
	assert.equal(model?.capabilities.webSearch, true);
	assert.equal(model?.capabilities.vision, true);
	assert.equal(zhipuResult.models.find((item) => item.id === "glm-image")?.capabilities.imageGeneration, true);
	assert.equal(zhipuResult.models.find((item) => item.id === "glm-image")?.capabilities.imageEdit, undefined);
	assert.equal(zhipuResult.models.find((item) => item.id === "cogview-4")?.capabilities.imageGeneration, true);
	assert.equal(zhipuResult.models.find((item) => item.id === "cogview-4")?.capabilities.imageEdit, undefined);
	assert.equal(dashscopeResult.models.find((item) => item.id === "qwen-image-2.0")?.capabilities.imageGeneration, true);
	assert.equal(dashscopeResult.models.find((item) => item.id === "qwen-image-2.0")?.capabilities.imageEdit, true);
	assert.equal(dashscopeResult.models.find((item) => item.id === "qwen-image")?.capabilities.imageGeneration, true);
	assert.equal(dashscopeResult.models.find((item) => item.id === "qwen-image")?.capabilities.imageEdit, undefined);
	assert.equal(dashscopeResult.models.find((item) => item.id === "qwen-image-edit")?.capabilities.imageGeneration, undefined);
	assert.equal(dashscopeResult.models.find((item) => item.id === "qwen-image-edit")?.capabilities.imageEdit, true);
	assert.equal(volcengineResult.models.find((item) => item.id === "doubao-seed-evolving")?.capabilities.vision, true);
	assert.equal(volcengineResult.models.find((item) => item.id === "doubao-seedream-5-0-pro-260628")?.capabilities.imageGeneration, true);
	assert.equal(minimaxResult.models.find((item) => item.id === "MiniMax-M3")?.capabilities.vision, true);
	assert.equal(minimaxResult.models.find((item) => item.id === "MiniMax-M3")?.capabilities.imageInput, true);
	assert.equal(minimaxResult.models.find((item) => item.id === "image-01")?.capabilities.imageGeneration, true);
	assert.equal(minimaxResult.models.find((item) => item.id === "image-01")?.capabilities.imageEdit, undefined);
});
