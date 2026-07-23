import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs/promises";
import { z } from "zod";
import {
	applyProjectSettingSetToContent,
	applyProjectSettingUnsetToContent,
	findProjectSettingEntry,
	normalizeProjectSettingValueExpression,
	type ProjectSettingEntry,
	type ProjectSettingsDocument
} from "./project-settings-document.js";
import { asJsonTextResult, getProjectConfigPath, readProjectSettingsDocument, resolveGodotResourceProjectPath } from "../context.js";

const MAX_PREVIEW_CHARS: number = 1200;
const MAX_INPUT_EVENTS: number = 64;

export type InputActionSummary = {
	action: string;
	key: string;
	valueExpression: string;
	deadzone: number | null;
	eventsExpression: string | null;
	lineStart: number;
	lineEnd: number;
};

export type AutoloadSummary = {
	name: string;
	key: string;
	valueExpression: string;
	resourcePath: string | null;
	enabled: boolean | null;
	lineStart: number;
	lineEnd: number;
};

function previewContent(content: string): string {
	return content.slice(0, MAX_PREVIEW_CHARS) + (content.length > MAX_PREVIEW_CHARS ? "\n..." : "");
}

function validateProjectSettingName(kind: string, name: string): string {
	const normalizedName: string = name.trim();
	if (
		normalizedName.length === 0
		|| normalizedName.length > 128
		|| normalizedName.includes("/")
		|| normalizedName.includes("\\")
		|| /[\r\n[\]=]/u.test(normalizedName)
		|| !/^[A-Za-z0-9_.:-]+$/u.test(normalizedName)
	) {
		throw new Error(`Invalid ${kind} name: ${name}`);
	}
	return normalizedName;
}

function quoteGodotString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function parseDeadzone(valueExpression: string): number | null {
	const match: RegExpMatchArray | null = valueExpression.match(/"deadzone"\s*:\s*([-+]?\d+(?:\.\d+)?)/u);
	return match?.[1] === undefined ? null : Number(match[1]);
}

function parseEventsExpression(valueExpression: string): string | null {
	const match: RegExpMatchArray | null = valueExpression.match(/"events"\s*:\s*(\[[\s\S]*\])/u);
	return match?.[1]?.trim() ?? null;
}

function formatInputActionEntry(entry: ProjectSettingEntry): InputActionSummary {
	const prefix: string = "input/";
	return {
		action: entry.fullKey.slice(prefix.length),
		key: entry.fullKey,
		valueExpression: entry.valueExpression,
		deadzone: parseDeadzone(entry.valueExpression),
		eventsExpression: parseEventsExpression(entry.valueExpression),
		lineStart: entry.lineStart + 1,
		lineEnd: entry.lineEnd + 1
	};
}

function parseAutoloadPath(valueExpression: string): { resourcePath: string | null; enabled: boolean | null } {
	const trimmed: string = valueExpression.trim();
	const quotedMatch: RegExpMatchArray | null = trimmed.match(/^"((?:[^"\\]|\\.)*)"$/u);
	if (quotedMatch === null) {
		return { resourcePath: null, enabled: null };
	}

	const unescaped: string = quotedMatch[1]!.replace(/\\"/gu, "\"").replace(/\\\\/gu, "\\");
	const enabled: boolean = unescaped.startsWith("*");
	return {
		resourcePath: enabled ? unescaped.slice(1) : unescaped,
		enabled
	};
}

function formatAutoloadEntry(entry: ProjectSettingEntry): AutoloadSummary {
	const prefix: string = "autoload/";
	const parsed = parseAutoloadPath(entry.valueExpression);
	return {
		name: entry.fullKey.slice(prefix.length),
		key: entry.fullKey,
		valueExpression: entry.valueExpression,
		resourcePath: parsed.resourcePath,
		enabled: parsed.enabled,
		lineStart: entry.lineStart + 1,
		lineEnd: entry.lineEnd + 1
	};
}

export function createInputActionValueExpression(events: string[], deadzone: number = 0.5): string {
	if (events.length > MAX_INPUT_EVENTS) {
		throw new Error(`Too many input events: ${events.length} (max ${MAX_INPUT_EVENTS})`);
	}

	const normalizedEvents: string[] = events.map((event: string): string => normalizeProjectSettingValueExpression(event));
	const eventLines: string[] = normalizedEvents.length === 0
		? []
		: normalizedEvents.map((event: string, index: number): string => `    ${event}${index + 1 < normalizedEvents.length ? "," : ""}`);
	const expression: string = [
		"{",
		`\"deadzone\": ${deadzone},`,
		"\"events\": [",
		...eventLines,
		"]",
		"}"
	].join("\n");

	return normalizeProjectSettingValueExpression(expression);
}

export async function normalizeAutoloadResourcePath(resourcePath: string): Promise<string> {
	const trimmedPath: string = resourcePath.trim().replaceAll("\\", "/");
	if (trimmedPath.length === 0) {
		throw new Error("resourcePath must not be empty");
	}

	const absolutePath: string = await resolveGodotResourceProjectPath(trimmedPath);
	void absolutePath;
	return trimmedPath.startsWith("res://") ? trimmedPath : `res://${trimmedPath.replace(/^\/+/u, "")}`;
}

export async function createAutoloadValueExpression(resourcePath: string, enabled: boolean = true): Promise<string> {
	const normalizedPath: string = await normalizeAutoloadResourcePath(resourcePath);
	const autoloadPath: string = enabled ? `*${normalizedPath}` : normalizedPath;
	return normalizeProjectSettingValueExpression(quoteGodotString(autoloadPath));
}

async function getInputActions(filter: string | undefined, includeBuiltin: boolean | undefined): Promise<Record<string, unknown>> {
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const normalizedFilter: string = filter?.trim().toLowerCase() ?? "";
	const actions: InputActionSummary[] = document.entries
		.filter((entry: ProjectSettingEntry): boolean => entry.fullKey.startsWith("input/"))
		.map(formatInputActionEntry)
		.filter((action: InputActionSummary): boolean => normalizedFilter.length === 0 || action.action.toLowerCase().includes(normalizedFilter));

	return {
		projectConfigPath: getProjectConfigPath(),
		actions,
		totalMatched: actions.length,
		includeBuiltinRequested: includeBuiltin === true,
		includeBuiltinSupported: false
	};
}

async function proposeSetInputAction(action: string, events: string[], deadzone: number | undefined): Promise<Record<string, unknown>> {
	const actionName: string = validateProjectSettingName("input action", action);
	const valueExpression: string = createInputActionValueExpression(events, deadzone);
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const result = applyProjectSettingSetToContent(document, `input/${actionName}`, valueExpression);

	return {
		valid: true,
		action: actionName,
		settingAction: result.action,
		oldValueExpression: result.oldValueExpression,
		newValueExpression: valueExpression,
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath(),
		preview: previewContent(result.content)
	};
}

async function setInputAction(action: string, events: string[], deadzone: number | undefined): Promise<Record<string, unknown>> {
	const actionName: string = validateProjectSettingName("input action", action);
	const valueExpression: string = createInputActionValueExpression(events, deadzone);
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const result = applyProjectSettingSetToContent(document, `input/${actionName}`, valueExpression);
	await fs.writeFile(getProjectConfigPath(), result.content, "utf8");

	return {
		modified: true,
		action: actionName,
		settingAction: result.action,
		oldValueExpression: result.oldValueExpression,
		newValueExpression: valueExpression,
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath()
	};
}

async function proposeUnsetInputAction(action: string): Promise<Record<string, unknown>> {
	const actionName: string = validateProjectSettingName("input action", action);
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const result = applyProjectSettingUnsetToContent(document, `input/${actionName}`);

	return {
		valid: true,
		action: actionName,
		settingAction: result.action,
		oldValueExpression: result.oldValueExpression,
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath(),
		preview: previewContent(result.content)
	};
}

async function unsetInputAction(action: string): Promise<Record<string, unknown>> {
	const actionName: string = validateProjectSettingName("input action", action);
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const result = applyProjectSettingUnsetToContent(document, `input/${actionName}`);
	if (result.action === "remove") {
		await fs.writeFile(getProjectConfigPath(), result.content, "utf8");
	}

	return {
		modified: result.action === "remove",
		action: actionName,
		settingAction: result.action,
		oldValueExpression: result.oldValueExpression,
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath()
	};
}

async function getAutoloads(filter: string | undefined): Promise<Record<string, unknown>> {
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const normalizedFilter: string = filter?.trim().toLowerCase() ?? "";
	const autoloads: AutoloadSummary[] = document.entries
		.filter((entry: ProjectSettingEntry): boolean => entry.fullKey.startsWith("autoload/"))
		.map(formatAutoloadEntry)
		.filter((autoload: AutoloadSummary): boolean => normalizedFilter.length === 0 || autoload.name.toLowerCase().includes(normalizedFilter));

	return {
		projectConfigPath: getProjectConfigPath(),
		autoloads,
		totalMatched: autoloads.length
	};
}

async function proposeSetAutoload(name: string, resourcePath: string, enabled: boolean | undefined): Promise<Record<string, unknown>> {
	const autoloadName: string = validateProjectSettingName("autoload", name);
	const valueExpression: string = await createAutoloadValueExpression(resourcePath, enabled);
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const result = applyProjectSettingSetToContent(document, `autoload/${autoloadName}`, valueExpression);

	return {
		valid: true,
		name: autoloadName,
		resourcePath: parseAutoloadPath(valueExpression).resourcePath,
		enabled: parseAutoloadPath(valueExpression).enabled,
		settingAction: result.action,
		oldValueExpression: result.oldValueExpression,
		newValueExpression: valueExpression,
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath(),
		preview: previewContent(result.content)
	};
}

async function setAutoload(name: string, resourcePath: string, enabled: boolean | undefined): Promise<Record<string, unknown>> {
	const autoloadName: string = validateProjectSettingName("autoload", name);
	const valueExpression: string = await createAutoloadValueExpression(resourcePath, enabled);
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const result = applyProjectSettingSetToContent(document, `autoload/${autoloadName}`, valueExpression);
	await fs.writeFile(getProjectConfigPath(), result.content, "utf8");

	return {
		modified: true,
		name: autoloadName,
		resourcePath: parseAutoloadPath(valueExpression).resourcePath,
		enabled: parseAutoloadPath(valueExpression).enabled,
		settingAction: result.action,
		oldValueExpression: result.oldValueExpression,
		newValueExpression: valueExpression,
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath()
	};
}

async function proposeUnsetAutoload(name: string): Promise<Record<string, unknown>> {
	const autoloadName: string = validateProjectSettingName("autoload", name);
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const entry: ProjectSettingEntry | undefined = findProjectSettingEntry(document, `autoload/${autoloadName}`);
	const result = applyProjectSettingUnsetToContent(document, `autoload/${autoloadName}`);

	return {
		valid: true,
		name: autoloadName,
		resourcePath: entry === undefined ? null : parseAutoloadPath(entry.valueExpression).resourcePath,
		settingAction: result.action,
		oldValueExpression: result.oldValueExpression,
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath(),
		preview: previewContent(result.content)
	};
}

async function unsetAutoload(name: string): Promise<Record<string, unknown>> {
	const autoloadName: string = validateProjectSettingName("autoload", name);
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const entry: ProjectSettingEntry | undefined = findProjectSettingEntry(document, `autoload/${autoloadName}`);
	const result = applyProjectSettingUnsetToContent(document, `autoload/${autoloadName}`);
	if (result.action === "remove") {
		await fs.writeFile(getProjectConfigPath(), result.content, "utf8");
	}

	return {
		modified: result.action === "remove",
		name: autoloadName,
		resourcePath: entry === undefined ? null : parseAutoloadPath(entry.valueExpression).resourcePath,
		settingAction: result.action,
		oldValueExpression: result.oldValueExpression,
		lineStart: result.lineStart,
		lineEnd: result.lineEnd,
		projectConfigPath: getProjectConfigPath()
	};
}

export function registerProjectSemanticTools(server: McpServer): void {
	server.registerTool(
		"get_input_actions",
		{
			title: "Get Godot Input Actions",
			description: "Read explicit input actions from project.godot [input]. Returns raw Godot value expressions for fidelity.",
			inputSchema: z.object({
				filter: z.string().optional().describe("Optional case-insensitive action name filter."),
				includeBuiltin: z.boolean().optional().describe("Accepted for compatibility; built-in engine actions are not synthesized.")
			})
		},
		async ({ filter, includeBuiltin }) => asJsonTextResult(await getInputActions(filter, includeBuiltin))
	);

	server.registerTool(
		"propose_set_input_action",
		{
			title: "Propose Set Godot Input Action",
			description: "Preview creating or replacing an input action in project.godot without writing to disk.",
			inputSchema: z.object({
				action: z.string().min(1),
				events: z.array(z.string().min(1)).max(MAX_INPUT_EVENTS).describe("Raw Godot InputEvent expressions, such as Object(InputEventKey,...)."),
				deadzone: z.number().min(0).max(1).optional()
			})
		},
		async ({ action, events, deadzone }) => asJsonTextResult(await proposeSetInputAction(action, events, deadzone))
	);

	server.registerTool(
		"set_input_action",
		{
			title: "Set Godot Input Action",
			description: "Create or replace an input action in project.godot. This writes to disk and requires approval.",
			inputSchema: z.object({
				action: z.string().min(1),
				events: z.array(z.string().min(1)).max(MAX_INPUT_EVENTS),
				deadzone: z.number().min(0).max(1).optional()
			})
		},
		async ({ action, events, deadzone }) => asJsonTextResult(await setInputAction(action, events, deadzone))
	);

	server.registerTool(
		"propose_unset_input_action",
		{
			title: "Propose Unset Godot Input Action",
			description: "Preview removing an explicit input action from project.godot without writing to disk.",
			inputSchema: z.object({
				action: z.string().min(1)
			})
		},
		async ({ action }) => asJsonTextResult(await proposeUnsetInputAction(action))
	);

	server.registerTool(
		"unset_input_action",
		{
			title: "Unset Godot Input Action",
			description: "Remove an explicit input action from project.godot. This writes to disk and requires approval.",
			inputSchema: z.object({
				action: z.string().min(1)
			})
		},
		async ({ action }) => asJsonTextResult(await unsetInputAction(action))
	);

	server.registerTool(
		"get_autoloads",
		{
			title: "Get Godot Autoloads",
			description: "Read autoload singletons from project.godot [autoload].",
			inputSchema: z.object({
				filter: z.string().optional().describe("Optional case-insensitive autoload name filter.")
			})
		},
		async ({ filter }) => asJsonTextResult(await getAutoloads(filter))
	);

	server.registerTool(
		"propose_set_autoload",
		{
			title: "Propose Set Godot Autoload",
			description: "Preview creating or replacing an autoload singleton in project.godot without writing to disk.",
			inputSchema: z.object({
				name: z.string().min(1),
				resourcePath: z.string().min(1).describe("Script or scene path, for example res://scripts/game_state.gd."),
				enabled: z.boolean().optional().describe("Defaults to true. Godot stores enabled autoloads with a leading *.")
			})
		},
		async ({ name, resourcePath, enabled }) => asJsonTextResult(await proposeSetAutoload(name, resourcePath, enabled))
	);

	server.registerTool(
		"set_autoload",
		{
			title: "Set Godot Autoload",
			description: "Create or replace an autoload singleton in project.godot. This writes to disk and requires approval.",
			inputSchema: z.object({
				name: z.string().min(1),
				resourcePath: z.string().min(1),
				enabled: z.boolean().optional()
			})
		},
		async ({ name, resourcePath, enabled }) => asJsonTextResult(await setAutoload(name, resourcePath, enabled))
	);

	server.registerTool(
		"propose_unset_autoload",
		{
			title: "Propose Unset Godot Autoload",
			description: "Preview removing an autoload singleton from project.godot without writing to disk.",
			inputSchema: z.object({
				name: z.string().min(1)
			})
		},
		async ({ name }) => asJsonTextResult(await proposeUnsetAutoload(name))
	);

	server.registerTool(
		"unset_autoload",
		{
			title: "Unset Godot Autoload",
			description: "Remove an autoload singleton from project.godot. This writes to disk and requires approval.",
			inputSchema: z.object({
				name: z.string().min(1)
			})
		},
		async ({ name }) => asJsonTextResult(await unsetAutoload(name))
	);
}
