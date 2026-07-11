import type { ProviderChatOptions } from "../providers/deepseek-client.js";
import { normalizeConfiguredProviderBaseUrl } from "../providers/provider-base-url.js";
import { getProviderAdapterFamily, getProviderDefaultEndpointType, getProviderDefaultModel } from "../providers/provider-registry.js";
import type { ClientSession } from "./client-session.js";

export function createProviderChatOptions(session: ClientSession, apiKey: string): ProviderChatOptions {
	const endpointType = getProviderDefaultEndpointType(session.activeProvider);
	const options: ProviderChatOptions = {
		provider: session.activeProvider,
		apiKey,
		model: session.providerModel ?? getProviderDefaultModel(session.activeProvider),
		endpointType,
		adapterFamily: getProviderAdapterFamily(session.activeProvider, endpointType),
		modelProfile: session.modelProfile
	};
	const normalizedBaseUrl: string | undefined = normalizeConfiguredProviderBaseUrl(session.providerBaseUrl);
	if (normalizedBaseUrl !== undefined) {
		options.baseUrl = normalizedBaseUrl;
	}

	return options;
}
