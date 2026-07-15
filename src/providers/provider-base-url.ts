import type { ProviderId } from "../protocol/types.js";
import { getProviderDefaultBaseUrl } from "./provider-registry.js";

const DASHSCOPE_COMPATIBLE_SUFFIX: string = "/compatible-mode/v1";
const DASHSCOPE_API_SUFFIX: string = "/api/v1";

export function normalizeConfiguredProviderBaseUrl(baseUrl: string | null | undefined): string | undefined {
	const trimmed: string | undefined = baseUrl?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed.replace(/\/+$/, "") : undefined;
}

export function resolveProviderBaseUrl(provider: ProviderId, baseUrl: string | null | undefined): string {
	return normalizeConfiguredProviderBaseUrl(baseUrl) ?? getProviderDefaultBaseUrl(provider);
}

export function resolveDashScopeApiBaseUrl(baseUrl: string | null | undefined): string {
	const resolvedBaseUrl: string = resolveProviderBaseUrl("dashscope", baseUrl);
	if (resolvedBaseUrl.endsWith(DASHSCOPE_API_SUFFIX)) {
		return resolvedBaseUrl;
	}
	if (resolvedBaseUrl.endsWith(DASHSCOPE_COMPATIBLE_SUFFIX)) {
		return `${resolvedBaseUrl.slice(0, -DASHSCOPE_COMPATIBLE_SUFFIX.length)}${DASHSCOPE_API_SUFFIX}`;
	}
	return `${resolvedBaseUrl}${DASHSCOPE_API_SUFFIX}`;
}
