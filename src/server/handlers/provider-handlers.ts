import type WebSocket from "ws";
import type { ClientRequest } from "../../protocol/types.js";
import type { McpHost } from "../../mcp/mcp-host.js";
import type { ClientSession } from "../client-session.js";
import { sendJson } from "../send-json.js";
import type { ProviderId } from "../../protocol/types.js";
import { getDefaultModelProfile, resolveModelProfile } from "../../tokens/model-profiles.js";
import { getProviderDefaultModel } from "../../providers/provider-registry.js";
import { clearProviderConfig, getProviderConfigStatus, loadProviderConfigWithSecret, saveProviderConfig, type ProviderConfigWithSecret } from "../../providers/provider-config-store.js";
import { listProviderModels } from "../../providers/provider-models.js";

export function applyProviderConfigToSession(session: ClientSession, config: ProviderConfigWithSecret): void {
	session.activeProvider = config.provider;
	if (config.apiKey !== undefined) {
		session.providerApiKey = config.apiKey;
	}

	session.providerModel = config.model;
	session.providerBaseUrl = config.baseUrl;

	session.modelProfile = resolveModelProfile(config.provider, config.model ?? getProviderDefaultModel(config.provider));
}

export async function ensureProviderConfigured(session: ClientSession): Promise<string | undefined> {
	if (session.providerApiKey !== undefined) {
		return session.providerApiKey;
	}

	const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret();
	if (config === null || config.apiKey === undefined) {
		return undefined;
	}

	applyProviderConfigToSession(session, config);
	return session.providerApiKey;
}



export async function handleProviderRequest(socket: WebSocket, request: ClientRequest, session: ClientSession, mcpHost: McpHost): Promise<void> {
	switch (request.method) {
	case "provider.configure":
		session.activeProvider = request.params.provider;
		session.providerApiKey = request.params.apiKey;
		session.providerModel = request.params.model;
		session.providerBaseUrl = request.params.baseUrl;
		session.modelProfile = resolveModelProfile(request.params.provider, request.params.model ?? getProviderDefaultModel(request.params.provider));

		sendJson(socket, {
			type: "response",
			id: request.id,
			ok: true,
			result: {
				provider: request.params.provider,
				configured: true,
				model: session.providerModel ?? session.modelProfile.model,
				modelProfile: session.modelProfile
			}
		});
		break;

	case "provider.config.get":
		try {
			const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret();
			if (config !== null && config.apiKey !== undefined) {
				applyProviderConfigToSession(session, config);
			}

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await getProviderConfigStatus()
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "provider_config_error",
					message: error instanceof Error ? error.message : "Failed to read provider config"
				}
			});
		}
		break;

	case "provider.config.set":
		try {
			await saveProviderConfig(request.params);
			const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret();
			if (config !== null && config.apiKey !== undefined) {
				applyProviderConfigToSession(session, config);
			}

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: await getProviderConfigStatus()
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "provider_config_error",
					message: error instanceof Error ? error.message : "Failed to save provider config"
				}
			});
		}
		break;

	case "provider.config.clear":
		try {
			const providerToClear: ProviderId | undefined = request.params?.provider;
			const clearedActiveProvider: boolean = providerToClear === undefined || providerToClear === session.activeProvider;
			const status = await clearProviderConfig(providerToClear);
			if (clearedActiveProvider) {
				session.activeProvider = status.activeProvider;
				session.providerApiKey = undefined;
				session.providerModel = undefined;
				session.providerBaseUrl = undefined;
				session.modelProfile = getDefaultModelProfile(status.activeProvider);
			}

			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result: status
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "provider_config_error",
					message: error instanceof Error ? error.message : "Failed to clear provider config"
				}
			});
		}
		break;

	case "provider.models.list": {
		const provider: ProviderId = request.params?.provider ?? session.activeProvider;
		try {
			const config: ProviderConfigWithSecret | null = await loadProviderConfigWithSecret(provider);
			const apiKey: string | undefined = provider === session.activeProvider
				? session.providerApiKey ?? config?.apiKey
				: config?.apiKey;
			const baseUrl: string | undefined = provider === session.activeProvider
				? session.providerBaseUrl ?? config?.baseUrl
				: config?.baseUrl;
			const result = await listProviderModels(
				provider,
				apiKey,
				baseUrl,
				request.params?.refresh === true
			);
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: true,
				result
			});
		} catch (error: unknown) {
			sendJson(socket, {
				type: "response",
				id: request.id,
				ok: false,
				error: {
					code: "provider_models_error",
					message: error instanceof Error ? error.message : "Failed to list provider models"
				}
			});
		}
		break;
	}

		default:
			throw new Error(`Unsupported provider method: ${request.method}`);
	}
}
