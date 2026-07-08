function stripMarkdownFence(text: string): string {
	const trimmed: string = text.trim();
	const fenceMatch: RegExpMatchArray | null = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
	return fenceMatch?.[1]?.trim() ?? trimmed;
}

function extractJsonObjectCandidate(text: string): string | null {
	const startIndex: number = text.indexOf("{");
	const endIndex: number = text.lastIndexOf("}");
	if (startIndex < 0 || endIndex <= startIndex) {
		return null;
	}

	return text.slice(startIndex, endIndex + 1);
}

export function parseJsonObjectFromLlm(text: string, failureMessage: string): unknown {
	const strippedText: string = stripMarkdownFence(text);
	const candidates: string[] = [strippedText];
	const objectCandidate: string | null = extractJsonObjectCandidate(strippedText);
	if (objectCandidate !== null && objectCandidate !== strippedText) {
		candidates.push(objectCandidate);
	}

	const triedCandidates: Set<string> = new Set();
	for (const candidate of candidates) {
		if (triedCandidates.has(candidate)) {
			continue;
		}
		triedCandidates.add(candidate);
		try {
			return JSON.parse(candidate) as unknown;
		} catch {
			// 这里刻意不透出 V8 的原始 JSON 位置错误，避免模型坏 JSON 变成用户可见后端崩错。
		}
	}

	throw new Error(failureMessage);
}
