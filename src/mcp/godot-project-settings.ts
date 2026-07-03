export const MAX_PROJECT_SETTING_VALUE_CHARS: number = 16 * 1024;
export const MAX_PROJECT_SETTING_VALUE_LINES: number = 240;

export type ProjectSettingEntry = {
	section: string;
	name: string;
	fullKey: string;
	valueExpression: string;
	lineStart: number;
	lineEnd: number;
};

export type ProjectSettingsDocument = {
	content: string;
	lines: string[];
	entries: ProjectSettingEntry[];
	sectionLineIndexes: Map<string, number>;
};

export function normalizeConfigContent(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function makeProjectSettingFullKey(section: string, name: string): string {
	return `${section}/${name}`;
}

export function splitProjectSettingKey(fullKey: string): { section: string; name: string } {
	const normalizedKey: string = fullKey.trim();
	const slashIndex: number = normalizedKey.lastIndexOf("/");
	if (slashIndex <= 0 || slashIndex === normalizedKey.length - 1) {
		throw new Error(`Invalid project setting key: ${fullKey}`);
	}

	return {
		section: normalizedKey.slice(0, slashIndex),
		name: normalizedKey.slice(slashIndex + 1)
	};
}

export function getExpressionBalance(text: string): number {
	let balance: number = 0;
	let inString: boolean = false;
	let escaped: boolean = false;

	for (const char of text) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "\"") {
			inString = !inString;
			continue;
		}
		if (inString) {
			continue;
		}
		if (char === "(" || char === "[" || char === "{") {
			balance += 1;
		} else if (char === ")" || char === "]" || char === "}") {
			balance -= 1;
		}
	}

	return balance;
}

export function normalizeProjectSettingValueExpression(valueExpression: string): string {
	const normalizedValue: string = normalizeConfigContent(valueExpression).trim();
	if (normalizedValue.length === 0) {
		throw new Error("valueExpression must not be empty");
	}
	if (normalizedValue.length > MAX_PROJECT_SETTING_VALUE_CHARS) {
		throw new Error(`valueExpression too large: ${normalizedValue.length} chars`);
	}

	const valueLines: string[] = normalizedValue.split("\n");
	if (valueLines.length > MAX_PROJECT_SETTING_VALUE_LINES) {
		throw new Error(`valueExpression has too many lines: ${valueLines.length}`);
	}
	for (const line of valueLines) {
		if (/^\s*\[.+\]\s*$/.test(line)) {
			throw new Error("valueExpression must not contain project.godot section headers");
		}
	}
	if (getExpressionBalance(normalizedValue) !== 0) {
		throw new Error("valueExpression has unbalanced braces, brackets, or parentheses");
	}

	return normalizedValue;
}

export function parseProjectSettings(content: string): ProjectSettingsDocument {
	const normalizedContent: string = normalizeConfigContent(content);
	const lines: string[] = normalizedContent.split("\n");
	const entries: ProjectSettingEntry[] = [];
	const sectionLineIndexes: Map<string, number> = new Map();
	let currentSection: string = "";

	for (let index = 0; index < lines.length; index += 1) {
		const line: string = lines[index] ?? "";
		const sectionMatch: RegExpMatchArray | null = line.match(/^\s*\[([^\]]+)\]\s*$/);
		if (sectionMatch !== null) {
			currentSection = sectionMatch[1] ?? "";
			sectionLineIndexes.set(currentSection, index);
			continue;
		}

		if (currentSection.length === 0 || line.trim().length === 0 || line.trimStart().startsWith(";")) {
			continue;
		}

		const equalsIndex: number = line.indexOf("=");
		if (equalsIndex <= 0) {
			continue;
		}

		const name: string = line.slice(0, equalsIndex).trim();
		let valueExpression: string = line.slice(equalsIndex + 1).trim();
		const lineStart: number = index;
		let lineEnd: number = index;

		while (getExpressionBalance(valueExpression) > 0 && lineEnd + 1 < lines.length) {
			lineEnd += 1;
			valueExpression += `\n${lines[lineEnd] ?? ""}`;
		}

		entries.push({
			section: currentSection,
			name,
			fullKey: makeProjectSettingFullKey(currentSection, name),
			valueExpression,
			lineStart,
			lineEnd
		});
		index = lineEnd;
	}

	return { content: normalizedContent, lines, entries, sectionLineIndexes };
}

export function findProjectSettingEntry(document: ProjectSettingsDocument, fullKey: string): ProjectSettingEntry | undefined {
	return document.entries.find((entry: ProjectSettingEntry): boolean => entry.fullKey === fullKey);
}

function findProjectSettingInsertIndex(document: ProjectSettingsDocument, section: string): number {
	const sectionLineIndex: number | undefined = document.sectionLineIndexes.get(section);
	if (sectionLineIndex === undefined) {
		return document.lines.length;
	}

	let insertIndex: number = sectionLineIndex + 1;
	for (const entry of document.entries) {
		if (entry.section === section) {
			insertIndex = Math.max(insertIndex, entry.lineEnd + 1);
		}
	}

	return insertIndex;
}

function createProjectSettingAssignmentLines(name: string, valueExpression: string): string[] {
	const valueLines: string[] = valueExpression.split("\n");
	return valueLines.map((line: string, index: number): string => index === 0 ? `${name}=${line}` : line);
}

function finalizeProjectConfigContent(lines: string[]): string {
	return `${lines.join("\n").replace(/\n+$/g, "")}\n`;
}

export function applyProjectSettingSetToContent(content: string, fullKey: string, valueExpression: string): string {
	const { section, name } = splitProjectSettingKey(fullKey);
	const normalizedValue: string = normalizeProjectSettingValueExpression(valueExpression);
	const document: ProjectSettingsDocument = parseProjectSettings(content);
	const entry: ProjectSettingEntry | undefined = findProjectSettingEntry(document, fullKey);
	const lines: string[] = [...document.lines];

	if (entry !== undefined) {
		const existingAssignmentLines: string[] = createProjectSettingAssignmentLines(entry.name, normalizedValue);
		lines.splice(entry.lineStart, entry.lineEnd - entry.lineStart + 1, ...existingAssignmentLines);
		return finalizeProjectConfigContent(lines);
	}

	const assignmentLines: string[] = createProjectSettingAssignmentLines(name, normalizedValue);
	if (!document.sectionLineIndexes.has(section)) {
		if (lines.length > 0 && lines[lines.length - 1] !== "") {
			lines.push("");
		}
		lines.push(`[${section}]`);
		lines.push(...assignmentLines);
		return finalizeProjectConfigContent(lines);
	}

	lines.splice(findProjectSettingInsertIndex(document, section), 0, ...assignmentLines);
	return finalizeProjectConfigContent(lines);
}

export function applyProjectSettingUnsetToContent(content: string, fullKey: string): string {
	const document: ProjectSettingsDocument = parseProjectSettings(content);
	const entry: ProjectSettingEntry | undefined = findProjectSettingEntry(document, fullKey);
	if (entry === undefined) {
		return finalizeProjectConfigContent(document.lines);
	}

	const lines: string[] = [...document.lines];
	lines.splice(entry.lineStart, entry.lineEnd - entry.lineStart + 1);
	return finalizeProjectConfigContent(lines);
}

export function proposeProjectSettingSet(content: string, fullKey: string, valueExpression: string): Record<string, unknown> {
	const nextContent: string = applyProjectSettingSetToContent(content, fullKey, valueExpression);
	const document: ProjectSettingsDocument = parseProjectSettings(nextContent);
	return {
		valid: true,
		key: fullKey,
		entry: findProjectSettingEntry(document, fullKey) ?? null,
		size: nextContent.length
	};
}

export function proposeProjectSettingUnset(content: string, fullKey: string): Record<string, unknown> {
	const nextContent: string = applyProjectSettingUnsetToContent(content, fullKey);
	return {
		valid: true,
		key: fullKey,
		removed: findProjectSettingEntry(parseProjectSettings(content), fullKey) !== undefined,
		size: nextContent.length
	};
}
