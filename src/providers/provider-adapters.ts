import { registerProviderAdapter } from "./provider-adapter.js";
import { openAICompatibleAdapter } from "./openai-compatible-adapter.js";
import { openAIResponsesAdapter } from "./openai-responses-adapter.js";
import { anthropicCompatibleAdapter } from "./anthropic-compatible-adapter.js";

registerProviderAdapter(openAICompatibleAdapter);
registerProviderAdapter(openAIResponsesAdapter);
registerProviderAdapter(anthropicCompatibleAdapter);
