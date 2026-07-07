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
	const slashIndex: number = normalizedKey.indexOf("/");
	if (
		normalizedKey.length === 0
		|| slashIndex <= 0
		|| slashIndex === normalizedKey.length - 1
		|| normalizedKey.includes("\n")
		|| normalizedKey.includes("\r")
		|| /[\[\]=]/.test(normalizedKey)
		|| !/^[A-Za-z0-9_./-]+$/.test(normalizedKey)
	) {
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
	const normalizedValue: string = normalizeConfigContent(valueExpression).trimEnd();
	if (normalizedValue.length === 0) {
		throw new Error("valueExpression must not be empty");
	}
	if (normalizedValue.length > MAX_PROJECT_SETTING_VALUE_CHARS) {
		throw new Error(`valueExpression too large: ${normalizedValue.length} chars (max ${MAX_PROJECT_SETTING_VALUE_CHARS})`);
	}

	const valueLines: string[] = normalizedValue.split("\n");
	if (valueLines.length > MAX_PROJECT_SETTING_VALUE_LINES) {
		throw new Error(`valueExpression has too many lines: ${valueLines.length} (max ${MAX_PROJECT_SETTING_VALUE_LINES})`);
	}
	for (let index: number = 1; index < valueLines.length; index += 1) {
		if (/^\s*\[[^\]]+\]\s*$/.test(valueLines[index]!)) {
			throw new Error("valueExpression must not contain project.godot section headers");
		}
	}
	const balance: number = valueLines.reduce((sum: number, line: string): number => sum + getExpressionBalance(line), 0);
	if (balance !== 0) {
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
		return -1;
	}

	let nextSectionIndex: number = document.lines.length;
	for (let index: number = sectionLineIndex + 1; index < document.lines.length; index += 1) {
		if (/^\s*\[[^\]]+\]\s*$/.test(document.lines[index]!)) {
			nextSectionIndex = index;
			break;
		}
	}

	let insertIndex: number = nextSectionIndex;
	while (insertIndex > sectionLineIndex + 1 && document.lines[insertIndex - 1]!.trim().length === 0) {
		insertIndex -= 1;
	}

	return insertIndex;
}

function createProjectSettingAssignmentLines(name: string, valueExpression: string): string[] {
	const valueLines: string[] = valueExpression.split("\n");
	return [`${name}=${valueLines[0] ?? ""}`, ...valueLines.slice(1)];
}

function finalizeProjectConfigContent(lines: string[]): string {
	return `${lines.join("\n").replace(/\n*$/g, "")}\n`;
}

export type ProjectSettingSetResult = {
	content: string;
	action: "add" | "update";
	oldValueExpression: string | null;
	lineStart: number | null;
	lineEnd: number | null;
};

export type ProjectSettingUnsetResult = {
	content: string;
	action: "remove" | "noop";
	oldValueExpression: string | null;
	lineStart: number | null;
	lineEnd: number | null;
};

function toProjectSettingsDocument(contentOrDocument: string | ProjectSettingsDocument): ProjectSettingsDocument {
	return typeof contentOrDocument === "string" ? parseProjectSettings(contentOrDocument) : contentOrDocument;
}

export function applyProjectSettingSetToContent(contentOrDocument: string | ProjectSettingsDocument, fullKey: string, valueExpression: string): ProjectSettingSetResult {
	const { section, name } = splitProjectSettingKey(fullKey);
	const normalizedValue: string = normalizeProjectSettingValueExpression(valueExpression);
	const document: ProjectSettingsDocument = toProjectSettingsDocument(contentOrDocument);
	const entry: ProjectSettingEntry | undefined = findProjectSettingEntry(document, fullKey);
	const lines: string[] = [...document.lines];

	if (entry !== undefined) {
		const assignmentLines: string[] = createProjectSettingAssignmentLines(entry.name, normalizedValue);
		lines.splice(entry.lineStart, entry.lineEnd - entry.lineStart + 1, ...assignmentLines);
		return {
			content: finalizeProjectConfigContent(lines),
			action: "update",
			oldValueExpression: entry.valueExpression,
			lineStart: entry.lineStart + 1,
			lineEnd: entry.lineEnd + 1
		};
	}

	const assignmentLines: string[] = createProjectSettingAssignmentLines(name, normalizedValue);
	const sectionInsertIndex: number = findProjectSettingInsertIndex(document, section);
	if (sectionInsertIndex >= 0) {
		lines.splice(sectionInsertIndex, 0, ...assignmentLines);
		return {
			content: finalizeProjectConfigContent(lines),
			action: "add",
			oldValueExpression: null,
			lineStart: sectionInsertIndex + 1,
			lineEnd: sectionInsertIndex + assignmentLines.length
		};
	}

	let insertIndex: number = lines.length;
	if (insertIndex > 0 && lines[insertIndex - 1] === "") {
		insertIndex -= 1;
	}

	const insertedLines: string[] = [];
	if (insertIndex > 0 && lines[insertIndex - 1]!.trim().length > 0) {
		insertedLines.push("");
	}
	insertedLines.push(`[${section}]`, "", ...assignmentLines);
	lines.splice(insertIndex, 0, ...insertedLines);

	return {
		content: finalizeProjectConfigContent(lines),
		action: "add",
		oldValueExpression: null,
		lineStart: insertIndex + insertedLines.length - assignmentLines.length + 1,
		lineEnd: insertIndex + insertedLines.length
	};
}

export function applyProjectSettingUnsetToContent(contentOrDocument: string | ProjectSettingsDocument, fullKey: string): ProjectSettingUnsetResult {
	splitProjectSettingKey(fullKey);
	const document: ProjectSettingsDocument = toProjectSettingsDocument(contentOrDocument);
	const entry: ProjectSettingEntry | undefined = findProjectSettingEntry(document, fullKey);
	if (entry === undefined) {
		return {
			content: document.content,
			action: "noop",
			oldValueExpression: null,
			lineStart: null,
			lineEnd: null
		};
	}

	const lines: string[] = [...document.lines];
	lines.splice(entry.lineStart, entry.lineEnd - entry.lineStart + 1);
	return {
		content: finalizeProjectConfigContent(lines),
		action: "remove",
		oldValueExpression: entry.valueExpression,
		lineStart: entry.lineStart + 1,
		lineEnd: entry.lineEnd + 1
	};
}

export function proposeProjectSettingSet(content: string, fullKey: string, valueExpression: string): Record<string, unknown> {
	const result: ProjectSettingSetResult = applyProjectSettingSetToContent(content, fullKey, valueExpression);
	const document: ProjectSettingsDocument = parseProjectSettings(result.content);
	return {
		valid: true,
		key: fullKey,
		action: result.action,
		oldValueExpression: result.oldValueExpression,
		entry: findProjectSettingEntry(document, fullKey) ?? null,
		size: result.content.length
	};
}

export function proposeProjectSettingUnset(content: string, fullKey: string): Record<string, unknown> {
	const result: ProjectSettingUnsetResult = applyProjectSettingUnsetToContent(content, fullKey);
	return {
		valid: true,
		key: fullKey,
		action: result.action,
		removed: result.action === "remove",
		oldValueExpression: result.oldValueExpression,
		size: result.content.length
	};
}
