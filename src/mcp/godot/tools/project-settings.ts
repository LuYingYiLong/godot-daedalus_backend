import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs/promises";
import { z } from "zod";
import { applyProjectSettingSetToContent, applyProjectSettingUnsetToContent, findProjectSettingEntry, normalizeProjectSettingValueExpression, parseProjectSettings, type ProjectSettingEntry, type ProjectSettingsDocument } from "./project-settings-document.js";
import { asJsonTextResult, getProjectConfigPath, readProjectSettingsDocument } from "../context.js";

const MAX_PROJECT_SETTINGS_RESULT: number = 500;

function formatProjectSettingEntry(entry: ProjectSettingEntry): Record<string, unknown> {
	return {
		key: entry.fullKey,
		section: entry.section,
		name: entry.name,
		valueExpression: entry.valueExpression,
		lineStart: entry.lineStart + 1,
		lineEnd: entry.lineEnd + 1
	};
}

async function getProjectSettings(keys: string[] | undefined, prefix: string | undefined): Promise<Record<string, unknown>> {
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const trimmedKeys: string[] = (keys ?? []).map((key: string): string => key.trim()).filter((key: string): boolean => key.length > 0);
	const trimmedPrefix: string | undefined = prefix?.trim();
	let entries: ProjectSettingEntry[];

	if (trimmedKeys.length > 0) {
		entries = trimmedKeys
			.map((key: string): ProjectSettingEntry | undefined => findProjectSettingEntry(document, key))
			.filter((entry: ProjectSettingEntry | undefined): entry is ProjectSettingEntry => entry !== undefined);
	} else if (trimmedPrefix !== undefined && trimmedPrefix.length > 0) {
		entries = document.entries.filter((entry: ProjectSettingEntry): boolean => entry.fullKey.startsWith(trimmedPrefix));
	} else {
		entries = document.entries;
	}

	const clippedEntries: ProjectSettingEntry[] = entries.slice(0, MAX_PROJECT_SETTINGS_RESULT);
	const missingKeys: string[] = trimmedKeys.filter((key: string): boolean => findProjectSettingEntry(document, key) === undefined);

	return {
		projectConfigPath: getProjectConfigPath(),
		settings: clippedEntries.map(formatProjectSettingEntry),
		missingKeys,
		totalMatched: entries.length,
		truncated: entries.length > clippedEntries.length
	};
}

async function proposeSetProjectSetting(fullKey: string, valueExpression: string): Promise<Record<string, unknown>> {
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const result = applyProjectSettingSetToContent(document, fullKey, valueExpression);

	return {
		valid: true,
		key: fullKey.trim(),
		action: result.action,
		oldValueExpression: result.oldValueExpression,
		newValueExpression: normalizeProjectSettingValueExpression(valueExpression),
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath(),
		preview: result.content.slice(0, 1200) + (result.content.length > 1200 ? "\n..." : "")
	};
}

async function setProjectSetting(fullKey: string, valueExpression: string): Promise<Record<string, unknown>> {
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const result = applyProjectSettingSetToContent(document, fullKey, valueExpression);
	await fs.writeFile(getProjectConfigPath(), result.content, "utf8");

	return {
		modified: true,
		key: fullKey.trim(),
		action: result.action,
		oldValueExpression: result.oldValueExpression,
		newValueExpression: normalizeProjectSettingValueExpression(valueExpression),
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath()
	};
}

async function proposeUnsetProjectSetting(fullKey: string): Promise<Record<string, unknown>> {
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const result = applyProjectSettingUnsetToContent(document, fullKey);

	return {
		valid: true,
		key: fullKey.trim(),
		action: result.action,
		oldValueExpression: result.oldValueExpression,
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath(),
		preview: result.content.slice(0, 1200) + (result.content.length > 1200 ? "\n..." : "")
	};
}

async function unsetProjectSetting(fullKey: string): Promise<Record<string, unknown>> {
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const result = applyProjectSettingUnsetToContent(document, fullKey);
	if (result.action === "remove") {
		await fs.writeFile(getProjectConfigPath(), result.content, "utf8");
	}

	return {
		modified: result.action === "remove",
		key: fullKey.trim(),
		action: result.action,
		oldValueExpression: result.oldValueExpression,
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath()
	};
}

export function registerProjectSettingsTools(server: McpServer): void {
server.registerTool(
		"get_project_settings",
		{
			title: "Get Godot Project Settings",
			description: "结构化读取 project.godot 中显式写出的项目设置。key 使用 Godot 完整路径，例如 application/config/name 或 debug/file_logging/log_path。",
			inputSchema: z.object({
				keys: z.array(z.string().min(1)).max(64).optional().describe("可选，按完整 key 精确读取"),
				prefix: z.string().optional().describe("可选，按完整 key 前缀过滤，例如 debug/file_logging/")
			})
		},
		async ({ keys, prefix }) => asJsonTextResult(await getProjectSettings(keys, prefix))
	);

server.registerTool(
		"propose_set_project_setting",
		{
			title: "Propose Set Godot Project Setting",
			description: "预览设置 project.godot 中的某个项目设置，不会写入磁盘。valueExpression 必须是 Godot project.godot 右侧原始表达式，例如 \"\\\"Daedalus\\\"\"、true、PackedStringArray(...)。",
			inputSchema: z.object({
				key: z.string().min(1).describe("完整项目设置 key，例如 debug/file_logging/log_path"),
				valueExpression: z.string().min(1).describe("project.godot 右侧原始表达式")
			})
		},
		async ({ key, valueExpression }) => asJsonTextResult(await proposeSetProjectSetting(key, valueExpression))
	);

server.registerTool(
		"set_project_setting",
		{
			title: "Set Godot Project Setting",
			description: "修改 project.godot 中的某个项目设置，会实际写入磁盘并需要用户审批。修改前应先读取当前值并调用 propose_set_project_setting 预览。",
			inputSchema: z.object({
				key: z.string().min(1).describe("完整项目设置 key，例如 debug/file_logging/log_path"),
				valueExpression: z.string().min(1).describe("project.godot 右侧原始表达式")
			})
		},
		async ({ key, valueExpression }) => asJsonTextResult(await setProjectSetting(key, valueExpression))
	);

server.registerTool(
		"propose_unset_project_setting",
		{
			title: "Propose Unset Godot Project Setting",
			description: "预览移除 project.godot 中的某个显式项目设置，不会写入磁盘。移除后 Godot 会回退到引擎默认值或平台默认值。",
			inputSchema: z.object({
				key: z.string().min(1).describe("完整项目设置 key，例如 debug/file_logging/log_path")
			})
		},
		async ({ key }) => asJsonTextResult(await proposeUnsetProjectSetting(key))
	);

server.registerTool(
		"unset_project_setting",
		{
			title: "Unset Godot Project Setting",
			description: "移除 project.godot 中的某个显式项目设置，会实际写入磁盘并需要用户审批。移除后 Godot 会回退到默认值。",
			inputSchema: z.object({
				key: z.string().min(1).describe("完整项目设置 key，例如 debug/file_logging/log_path")
			})
		},
		async ({ key }) => asJsonTextResult(await unsetProjectSetting(key))
	);

}
