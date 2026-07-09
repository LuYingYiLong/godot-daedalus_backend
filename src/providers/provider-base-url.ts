import type { ProviderId } from "../protocol/types.js";
import { getProviderDefaultBaseUrl } from "./provider-registry.js";

export function normalizeConfiguredProviderBaseUrl(baseUrl: string | null | undefined): string | undefined {
	const trimmed: string | undefined = baseUrl?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : undefined;
}

export function resolveProviderBaseUrl(provider: ProviderId, baseUrl: string | null | undefined): string {
	return normalizeConfiguredProviderBaseUrl(baseUrl) ?? getProviderDefaultBaseUrl(provider);
}
