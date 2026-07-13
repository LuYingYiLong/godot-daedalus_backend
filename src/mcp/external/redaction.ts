const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|bearer|cookie|password|secret|token)/iu;
const MAX_RETURN_STRING_CHARS = 12000;

function redactValue(value: unknown): unknown {
	if (typeof value === "string") {
		return value.length > MAX_RETURN_STRING_CHARS
			? `${value.slice(0, MAX_RETURN_STRING_CHARS)}\n[truncated]`
			: value;
	}
	if (Array.isArray(value)) {
		return value.map((item: unknown): unknown => redactValue(item));
	}
	if (value !== null && typeof value === "object") {
		const record: Record<string, unknown> = value as Record<string, unknown>;
		const redacted: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(record)) {
			redacted[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactValue(child);
		}
		return redacted;
	}
	return value;
}

export function redactExternalMcpResult<T>(value: T): T {
	return redactValue(value) as T;
}
