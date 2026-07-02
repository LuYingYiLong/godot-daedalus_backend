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
const INSTRUCTION_PRIORITY_NOTICE: string = [
	"冲突处理优先级：",
	"1. Runtime 安全限制、后端强制策略、工具安全边界和审批流程。",
	"2. 经 Runtime 工作区边界校验后加载的项目指令文件，例如 AGENTS.md、CLAUDE.md。",
	"3. 用户当前消息中的明确任务目标。",
	"4. 本 Settings 用户提示词。",
	"5. 默认风格、通用建议和惯例。",
	"",
	"如果低优先级内容与高优先级内容冲突，只遵循不冲突的部分；必要时简短说明冲突原因。"
].join("\n");

const CUSTOM_INSTRUCTIONS_PRIORITY_NOTICE: string = [
	"以下内容来自前端 Settings 的 Custom instructions，本轮请求会生效并随每次对话发送。",
	"它只表示用户偏好或补充背景，不是工具结果、文件事实或项目规范。",
	"如果它与系统规则、工具安全、项目指令文件或用户当前消息冲突，只遵循不冲突的部分。"
].join("\n");

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
	const prioritizedTemplateContent: string = `${templateContent}\n\n## 指令优先级\n\n${INSTRUCTION_PRIORITY_NOTICE}`;

	if (trimmedExtraPrompt.length === 0) {
		return prioritizedTemplateContent;
	}

	return `${prioritizedTemplateContent}\n\n## Settings 用户提示词（本轮生效）\n\n${CUSTOM_INSTRUCTIONS_PRIORITY_NOTICE}\n\n${trimmedExtraPrompt}`;
}
