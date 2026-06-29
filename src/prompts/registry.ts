import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PromptId } from "../protocol/types.js";

export type PromptTemplate = {
	id: PromptId;
	name: string;
	description: string;
	path: string;
};

export const DEFAULT_PROMPT_ID: PromptId = "godot.assistant";

export const promptTemplates: Record<PromptId, PromptTemplate> = {
	"godot.assistant": {
		id: "godot.assistant",
		name: "Godot Assistant",
		description: "General Godot Development Assistant",
		path: "src/prompts/templates/godot-assistant.md"
	},
	"gdscript.reviewer": {
		id: "gdscript.reviewer",
		name: "GDScript Reviewer",
		description: "Reviews GDScript code for type safety and style issues",
		path: "src/prompts/templates/gdscript-reviewer.md"
	},
	"scene.architect": {
		id: "scene.architect",
		name: "Scene Architect",
		description: "Designs Godot scene structures following scene-first principles",
		path: "src/prompts/templates/scene-architect.md"
	},
	"backend.helper": {
		id: "backend.helper",
		name: "Backend Helper",
		description: "TypeScript backend development for the AI Runtime",
		path: "src/prompts/templates/backend-helper.md"
	},
};

const promptContentCache: Map<PromptId, string> = new Map();

export function listPromptTemplates(): PromptTemplate[] {
	return Object.values(promptTemplates);
}

export async function loadPromptTemplate(promptId: PromptId): Promise<string> {
	const cachedContent: string | undefined = promptContentCache.get(promptId);
	if (cachedContent !== undefined) {
		return cachedContent;
	}

	const template: PromptTemplate = promptTemplates[promptId];
	const templatePath: string = resolve(process.cwd(), template.path);
	const content: string = await readFile(templatePath, "utf8");
	const trimmedContent: string = content.trim();
	promptContentCache.set(promptId, trimmedContent);
	return trimmedContent;
}

export async function composeSystemPrompt(
	promptId: PromptId | undefined,
	extraSystemPrompt: string | undefined
): Promise<string> {
	const templateContent: string = await loadPromptTemplate(promptId ?? DEFAULT_PROMPT_ID);
	const trimmedExtraPrompt: string = extraSystemPrompt?.trim() ?? "";

	if (trimmedExtraPrompt.length === 0) {
		return templateContent;
	}

	return `${templateContent}\n\n## 本次额外指令\n\n${trimmedExtraPrompt}`;
}
