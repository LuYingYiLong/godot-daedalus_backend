export type ApprovalCandidate = {
	approvalId?: string | undefined;
	toolName?: string | undefined;
	risk?: string | undefined;
	args?: unknown;
	arguments?: unknown;
	input?: unknown;
};

export type ApprovalWhitelist = {
	allowedTools: readonly string[];
	allowedPathPrefixes: readonly string[];
};

const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|bearer|cookie|password|secret|token)/i;
const MAX_RETURN_STRING_CHARS = 12000;

function normalizePathCandidate(value: string): string | null {
	let normalized = value.trim().replaceAll("\\", "/");
	if (normalized.length === 0) {
		return null;
	}
	if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("/") || normalized.startsWith("//")) {
		return null;
	}
	if (normalized.startsWith("res://")) {
		normalized = normalized.slice("res://".length);
	}
	while (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		return null;
	}
	return normalized;
}

function collectPathCandidates(value: unknown, output: string[] = []): string[] {
	if (typeof value === "string") {
		const normalized = normalizePathCandidate(value);
		if (normalized !== null && (normalized.includes("/") || normalized.includes("."))) {
			output.push(normalized);
		}
		return output;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectPathCandidates(item, output);
		}
		return output;
	}
	if (value !== null && typeof value === "object") {
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (/path|file|script|scene|resource/i.test(key)) {
				collectPathCandidates(child, output);
			}
		}
	}
	return output;
}

export function extractApprovalPaths(candidate: ApprovalCandidate): readonly string[] {
	return collectPathCandidates(candidate.args ?? candidate.arguments ?? candidate.input);
}

export function isApprovalAllowed(candidate: ApprovalCandidate, whitelist: ApprovalWhitelist): boolean {
	if (!candidate.toolName || candidate.risk === "destructive") {
		return false;
	}
	if (!whitelist.allowedTools.includes(candidate.toolName)) {
		return false;
	}

	const paths = extractApprovalPaths(candidate);
	if (paths.length === 0) {
		return false;
	}
	return paths.some((candidatePath: string): boolean =>
		whitelist.allowedPathPrefixes.some((prefix: string): boolean => candidatePath.startsWith(prefix))
	);
}

export function selectMatchingApproval(
	pending: readonly ApprovalCandidate[],
	whitelist: ApprovalWhitelist,
	options: { approvalId?: string | undefined; toolName?: string | undefined } = {}
): ApprovalCandidate | undefined {
	return pending.find((candidate: ApprovalCandidate): boolean => {
		if (options.approvalId !== undefined && candidate.approvalId !== options.approvalId) {
			return false;
		}
		if (options.toolName !== undefined && candidate.toolName !== options.toolName) {
			return false;
		}
		return isApprovalAllowed(candidate, whitelist);
	});
}

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
		const record = value as Record<string, unknown>;
		const redacted: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(record)) {
			redacted[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactValue(child);
		}
		return redacted;
	}
	return value;
}

export function redactAutomationResult<T>(value: T): T {
	return redactValue(value) as T;
}
