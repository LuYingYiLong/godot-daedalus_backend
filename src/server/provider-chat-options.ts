import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import { normalizeConfiguredProviderBaseUrl } from "../providers/provider-base-url.js";
import type { ClientSession } from "./client-session.js";

export function createProviderChatOptions(session: ClientSession, apiKey: string): ProviderChatOptions {
	const options: ProviderChatOptions = { provider: session.activeProvider, apiKey };
	if (session.providerModel !== undefined) {
		options.model = session.providerModel;
	}
	const normalizedBaseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(session.providerBaseUrl);
	if (normalizedBaseUrl !== undefined) {
		options.baseUrl = normalizedBaseUrl;
	}

	return options;
}
