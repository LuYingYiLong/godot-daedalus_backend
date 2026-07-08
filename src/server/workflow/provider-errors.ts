export function isEmptyProviderResponseError(error: unknown): boolean {
	return error instanceof Error && /LLM returned empty response/u.test(error.message);
}
