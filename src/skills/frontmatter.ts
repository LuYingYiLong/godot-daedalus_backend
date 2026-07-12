import type { ParsedSkillDocument } from "./types.js";

export const MAX_SKILL_BYTES: number = 64 * 1024;
export const MAX_SKILL_DESCRIPTION_CHARS: number = 1000;
const REQUIRED_FIELDS: readonly string[] = ["name", "description"];

function parseScalar(rawValue: string, field: string): string {
	const value: string = rawValue.trim();
	if (value.length === 0) {
		throw new Error(`Frontmatter field "${field}" must not be empty.`);
	}
	if (value.startsWith("|") || value.startsWith(">") || value.startsWith("[") || value.startsWith("{") || value.startsWith("&") || value.startsWith("*")) {
		throw new Error(`Frontmatter field "${field}" must be a plain or quoted scalar.`);
	}
	if (value.startsWith("\"") || value.startsWith("'")) {
		const quote: string = value[0]!;
		if (!value.endsWith(quote) || value.length < 2) {
			throw new Error(`Frontmatter field "${field}" has an unterminated quoted value.`);
		}
		if (quote === "\"") {
			try {
				const parsed: unknown = JSON.parse(value);
				if (typeof parsed !== "string") {
					throw new Error();
				}
				return parsed.trim();
			} catch {
				throw new Error(`Frontmatter field "${field}" has an invalid quoted value.`);
			}
		}
		return value.slice(1, -1).replace(/''/g, "'").trim();
	}
	if (/[:#]\s|\s#/.test(value)) {
		throw new Error(`Frontmatter field "${field}" must quote values containing YAML punctuation.`);
	}
	return value;
}

export function parseSkillDocument(content: string): ParsedSkillDocument {
	if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
		throw new Error(`SKILL.md exceeds ${MAX_SKILL_BYTES} bytes.`);
	}
	const normalized: string = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const lines: string[] = normalized.split("\n");
	if (lines[0] !== "---") {
		throw new Error("SKILL.md must start with YAML frontmatter delimited by ---. ");
	}
	const closingIndex: number = lines.indexOf("---", 1);
	if (closingIndex < 0) {
		throw new Error("SKILL.md frontmatter is missing its closing --- delimiter.");
	}
	const fields: Map<string, string> = new Map();
	for (const line of lines.slice(1, closingIndex)) {
		if (line.trim().length === 0) {
			continue;
		}
		const match: RegExpMatchArray | null = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
		if (match === null) {
			throw new Error(`Unsupported frontmatter line: ${line}`);
		}
		const key: string = match[1]!.toLowerCase();
		if (fields.has(key)) {
			throw new Error(`Duplicate frontmatter field "${key}".`);
		}
		fields.set(key, parseScalar(match[2]!, key));
	}
	for (const field of REQUIRED_FIELDS) {
		if (!fields.has(field) || fields.get(field)!.length === 0) {
			throw new Error(`SKILL.md requires a non-empty "${field}" field.`);
		}
	}
	const description: string = fields.get("description")!;
	if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
		throw new Error(`Skill description exceeds ${MAX_SKILL_DESCRIPTION_CHARS} characters.`);
	}
	const body: string = lines.slice(closingIndex + 1).join("\n").trim();
	if (body.length === 0) {
		throw new Error("SKILL.md requires a non-empty instruction body.");
	}
	return { name: fields.get("name")!, description, body };
}
