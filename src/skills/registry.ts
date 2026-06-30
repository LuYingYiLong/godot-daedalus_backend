import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PromptId } from "../protocol/types.js";

export const skillIds = [
	"godot.project_init",
	"gdscript.review",
	"scene.builder",
	"file.creator",
	"backend.helper"
] as const;

export type SkillId = typeof skillIds[number];

export type Skill = {
	id: SkillId;
	name: string;
	description: string;
	promptPath: string;
	defaultPromptId?: PromptId;
	allowedTools: string[];
};

const READ_TOOLS: string[] = [
	"mcp_godot_get_project_summary",
	"mcp_godot_list_project_files",
	"mcp_godot_list_scenes",
	"mcp_godot_list_scripts",
	"mcp_godot_read_text_file",
	"mcp_godot_search_text",
	"mcp_godot_inspect_scene_tree"
];

const FILE_CREATE_TOOLS: string[] = [
	"mcp_godot_propose_create_text_file",
	"mcp_godot_create_text_file"
];

const VERIFY_TOOLS: string[] = [
	"mcp_terminal_get_capabilities",
	"mcp_terminal_run_safe_preset"
];

const TERMINAL_WRITE_TOOLS: string[] = [
	"mcp_terminal_run_write_preset",
	"mcp_terminal_run_godot_scene_script"
];

const PROPOSE_EDIT_TOOLS: string[] = [
	"mcp_godot_propose_overwrite_text_file",
	"mcp_godot_propose_replace_text_in_file"
];

const FILE_EDIT_TOOLS: string[] = [
	"mcp_godot_overwrite_text_file",
	"mcp_godot_replace_text_in_file"
];

const SCENE_PROPOSE_TOOLS: string[] = [
	"mcp_godot_propose_create_scene",
	"mcp_godot_propose_add_node_to_scene",
	"mcp_godot_propose_attach_script_to_node",
	"mcp_godot_propose_connect_signal_in_scene",
	"mcp_godot_propose_apply_scene_patch"
];

const SCENE_WRITE_TOOLS: string[] = [
	"mcp_godot_create_scene",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_connect_signal_in_scene",
	"mcp_godot_apply_scene_patch"
];

const skills: Record<SkillId, Skill> = {
	"godot.project_init": {
		id: "godot.project_init",
		name: "Godot Project Init",
		description: "Inspect the Godot project and create an AGENTS.md project guide.",
		promptPath: "src/skills/templates/godot-project-init.md",
		defaultPromptId: "godot.assistant",
		allowedTools: [...READ_TOOLS, ...FILE_CREATE_TOOLS, ...PROPOSE_EDIT_TOOLS, ...FILE_EDIT_TOOLS, ...VERIFY_TOOLS, ...TERMINAL_WRITE_TOOLS]
	},
	"gdscript.review": {
		id: "gdscript.review",
		name: "GDScript Review",
		description: "Review GDScript for type safety, Godot lifecycle issues, signals, and style.",
		promptPath: "src/skills/templates/gdscript-review.md",
		defaultPromptId: "gdscript.reviewer",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS, ...SCENE_PROPOSE_TOOLS, ...SCENE_WRITE_TOOLS]
	},
	"scene.builder": {
		id: "scene.builder",
		name: "Scene Builder",
		description: "Plan Godot scene structures and node responsibilities.",
		promptPath: "src/skills/templates/scene-builder.md",
		defaultPromptId: "scene.architect",
		allowedTools: [...READ_TOOLS, ...SCENE_PROPOSE_TOOLS, ...SCENE_WRITE_TOOLS, ...FILE_CREATE_TOOLS, ...VERIFY_TOOLS]
	},
	"file.creator": {
		id: "file.creator",
		name: "File Creator",
		description: "Create new project files through approval-gated tools.",
		promptPath: "src/skills/templates/file-creator.md",
		defaultPromptId: "godot.assistant",
		allowedTools: [...READ_TOOLS, ...FILE_CREATE_TOOLS, ...PROPOSE_EDIT_TOOLS, ...FILE_EDIT_TOOLS, ...VERIFY_TOOLS, ...TERMINAL_WRITE_TOOLS]
	},
	"backend.helper": {
		id: "backend.helper",
		name: "Backend Helper",
		description: "Work on the TypeScript WebSocket/MCP backend.",
		promptPath: "src/skills/templates/backend-helper.md",
		defaultPromptId: "backend.helper",
		allowedTools: [...READ_TOOLS, ...VERIFY_TOOLS]
	}
};

const skillPromptCache: Map<SkillId, string> = new Map();

export function listSkills(): Skill[] {
	return Object.values(skills);
}

export function isSkillId(value: string): value is SkillId {
	return (skillIds as readonly string[]).includes(value);
}

export function getSkill(skillId: SkillId): Skill {
	return skills[skillId];
}

export async function loadSkillPrompt(skillId: SkillId): Promise<string> {
	const cachedPrompt: string | undefined = skillPromptCache.get(skillId);
	if (cachedPrompt !== undefined) {
		return cachedPrompt;
	}

	const skill: Skill = getSkill(skillId);
	const content: string = await readFile(resolve(process.cwd(), skill.promptPath), "utf8");
	const trimmedContent: string = content.trim();
	skillPromptCache.set(skillId, trimmedContent);
	return trimmedContent;
}

export async function composeSkillPrompt(skillId: SkillId | undefined): Promise<string> {
	if (skillId === undefined) {
		return "";
	}

	const skill: Skill = getSkill(skillId);
	const prompt: string = await loadSkillPrompt(skillId);
	return [
		"## 当前激活 Skill",
		`- ID: ${skill.id}`,
		`- 名称: ${skill.name}`,
		`- 描述: ${skill.description}`,
		"- 允许工具:",
		...skill.allowedTools.map((toolName: string): string => `  - ${toolName}`),
		"",
		prompt
	].join("\n");
}
