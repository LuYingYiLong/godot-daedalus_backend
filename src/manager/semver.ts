export function parseSemver(value: string): [number, number, number] | null {
	const match: RegExpMatchArray | null = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
	if (match === null) {
		return null;
	}

	return [Number.parseInt(match[1]!, 10), Number.parseInt(match[2]!, 10), Number.parseInt(match[3]!, 10)];
}

export function isVersionNewer(candidate: string, current: string): boolean {
	const left: [number, number, number] | null = parseSemver(candidate);
	const right: [number, number, number] | null = parseSemver(current);
	if (left === null || right === null) {
		return false;
	}

	for (let index: number = 0; index < 3; index += 1) {
		const leftValue: number = left[index]!;
		const rightValue: number = right[index]!;
		if (leftValue > rightValue) {
			return true;
		}
		if (leftValue < rightValue) {
			return false;
		}
	}

	return false;
}
