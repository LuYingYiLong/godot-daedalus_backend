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
		path: "src/prompts/templates/base/godot-assistant.md"
	},
	"gdscript.reviewer": {
		id: "gdscript.reviewer",
		name: "GDScript Reviewer",
		description: "Reviews GDScript code for type safety and style issues",
		path: "src/prompts/templates/base/gdscript-reviewer.md"
	},
	"scene.architect": {
		id: "scene.architect",
		name: "Scene Architect",
		description: "Designs Godot scene structures following scene-first principles",
		path: "src/prompts/templates/base/scene-architect.md"
	},
	"backend.helper": {
		id: "backend.helper",
		name: "Backend Helper",
		description: "TypeScript backend development for the AI Runtime",
		path: "src/prompts/templates/base/backend-helper.md"
	},
};

const promptContentCache: Map<PromptId, string> = new Map();
const extraPromptContentCache: Map<string, string> = new Map();

export const promptModeTemplatePaths = [
	"src/prompts/templates/modes/ask-mode.md"
] as const;

export const promptFragmentPaths = [
	"src/prompts/templates/fragments/tool-call-communication.md",
	"src/prompts/templates/fragments/instruction-priority.md",
	"src/prompts/templates/fragments/custom-instructions-boundary.md"
] as const;

export const internalPromptTemplatePaths = [
	"src/prompts/templates/internal/session-compressor.md"
] as const;

export const promptTemplatePaths: readonly string[] = [
	...Object.values(promptTemplates).map((template: PromptTemplate): string => template.path),
	...promptModeTemplatePaths
];

const ASK_MODE_PROMPT_PATH: string = promptModeTemplatePaths[0];
const TOOL_CALL_COMMUNICATION_PROMPT_PATH: string = promptFragmentPaths[0];
const INSTRUCTION_PRIORITY_PROMPT_PATH: string = promptFragmentPaths[1];
const CUSTOM_INSTRUCTIONS_BOUNDARY_PROMPT_PATH: string = promptFragmentPaths[2];

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

async function loadExtraPromptTemplate(templatePath: string): Promise<string> {
	const cachedContent: string | undefined = extraPromptContentCache.get(templatePath);
	if (cachedContent !== undefined) {
		return cachedContent;
	}

	const content: string = await readFile(resolve(process.cwd(), templatePath), "utf8");
	const trimmedContent: string = content.trim();
	extraPromptContentCache.set(templatePath, trimmedContent);
	return trimmedContent;
}

export async function composeSystemPrompt(
	promptId: PromptId | undefined,
	extraSystemPrompt: string | undefined,
	runtimeContext: string = "",
	chatMode: "agent" | "ask" | undefined = undefined
): Promise<string> {
	const templateContent: string = await loadPromptTemplate(promptId ?? DEFAULT_PROMPT_ID);
	const trimmedExtraPrompt: string = extraSystemPrompt?.trim() ?? "";
	const trimmedRuntimeContext: string = runtimeContext.trim();
	const runtimeContextSection: string = trimmedRuntimeContext.length > 0
		? `\n\n## Runtime 当前模型上下文\n\n${trimmedRuntimeContext}`
		: "";
	const askModePrompt: string = chatMode === "ask"
		? await loadExtraPromptTemplate(ASK_MODE_PROMPT_PATH)
		: "";
	const askModeSection: string = chatMode === "ask"
		? `\n\n## Ask 模式\n\n${askModePrompt}`
		: "";
	const [toolCallCommunicationPrompt, instructionPriorityPrompt] = await Promise.all([
		loadExtraPromptTemplate(TOOL_CALL_COMMUNICATION_PROMPT_PATH),
		loadExtraPromptTemplate(INSTRUCTION_PRIORITY_PROMPT_PATH)
	]);
	const prioritizedTemplateContent: string = `${templateContent}${runtimeContextSection}${askModeSection}\n\n## 工具调用沟通约定\n\n${toolCallCommunicationPrompt}\n\n## 指令优先级\n\n${instructionPriorityPrompt}`;

	if (trimmedExtraPrompt.length === 0) {
		return prioritizedTemplateContent;
	}

	const customInstructionsBoundaryPrompt: string = await loadExtraPromptTemplate(CUSTOM_INSTRUCTIONS_BOUNDARY_PROMPT_PATH);
	return `${prioritizedTemplateContent}\n\n## Settings 用户提示词（本轮生效）\n\n${customInstructionsBoundaryPrompt}\n\n${trimmedExtraPrompt}`;
}
