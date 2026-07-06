import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import type { ClientSession } from "./client-session.js";

export function createProviderChatOptions(session: ClientSession, apiKey: string): ProviderChatOptions {
	const options: ProviderChatOptions = { provider: session.activeProvider, apiKey };
	if (session.providerModel !== undefined) {
		options.model = session.providerModel;
	}
	if (session.providerBaseUrl !== undefined) {
		options.baseUrl = session.providerBaseUrl;
	}

	return options;
}
