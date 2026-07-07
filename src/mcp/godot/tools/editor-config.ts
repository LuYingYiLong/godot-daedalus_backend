import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { findProjectSettingEntry, parseProjectSettings, type ProjectSettingEntry, type ProjectSettingsDocument } from "./project-settings-document.js";
import { asJsonTextResult, getGodotConfigDir, getProjectEditorDir, isCurrentProjectPath, isPathInsideRoot, normalizeDisplayPath, parseProjectFeatureVersion, parseProjectSettingBoolean, parseProjectSettingString, projectRoot, readProjectConfig, redactOnePath, redactSensitivePaths, resolveProjectPath } from "../context.js";

const MAX_EDITOR_CONFIG_FILE_BYTES: number = 256 * 1024;
const MAX_EDITOR_CONFIG_FILES: number = 500;
const MAX_EDITOR_SETTINGS_RESULT: number = 500;
const MAX_RECENT_PROJECTS_RESULT: number = 100;

export type EditorSettingsFile = {
	fileName: string;
	absolutePath: string;
	version: string;
	major: number;
	minor: number;
	size: number;
	modifiedAt: string;
};

export type EditorConfigFileScope = "global_config" | "project_editor";

export type EditorConfigFile = {
	fileId: string;
	scope: EditorConfigFileScope;
	relativePath: string;
	absolutePath: string;
	size: number;
	modifiedAt: string;
};

export type EditorConfigPaths = {
	configDir: string;
	projectEditorDir: string;
	settingsFile: EditorSettingsFile | null;
	settingsFiles: EditorSettingsFile[];
};

export type ScriptEditorState = {
	resourcePath: string;
	line: number | null;
	column: number | null;
	row: number | null;
	storedColumn: number | null;
	breakpoints: number[];
	bookmarks: number[];
	selection: boolean | null;
	syntaxHighlighter: string | null;
};

function parseEditorSettingsFileName(fileName: string): { version: string; major: number; minor: number } | null {
	const match: RegExpMatchArray | null = fileName.match(/^editor_settings-(\d+)(?:\.(\d+))?\.tres$/);
	if (match === null) {
		return null;
	}

	const major: number = Number.parseInt(match[1]!, 10);
	const minor: number = match[2] === undefined ? -1 : Number.parseInt(match[2], 10);
	return {
		version: minor < 0 ? `${major}` : `${major}.${minor}`,
		major,
		minor
	};
}

async function listEditorSettingsFiles(): Promise<EditorSettingsFile[]> {
	const configDir: string = getGodotConfigDir();
	let entries: Dirent[];
	try {
		entries = await fs.readdir(configDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: EditorSettingsFile[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}

		const versionInfo = parseEditorSettingsFileName(entry.name);
		if (versionInfo === null) {
			continue;
		}

		const absolutePath: string = path.join(configDir, entry.name);
		const stat = await fs.stat(absolutePath);
		files.push({
			fileName: entry.name,
			absolutePath,
			version: versionInfo.version,
			major: versionInfo.major,
			minor: versionInfo.minor,
			size: stat.size,
			modifiedAt: stat.mtime.toISOString()
		});
	}

	files.sort((left: EditorSettingsFile, right: EditorSettingsFile): number => {
		if (right.major !== left.major) {
			return right.major - left.major;
		}

		return right.minor - left.minor;
	});
	return files;
}

async function getEditorConfigPaths(): Promise<EditorConfigPaths> {
	const config: Record<string, string> = await readProjectConfig();
	const preferredVersion: string | undefined = parseProjectFeatureVersion(config);
	const settingsFiles: EditorSettingsFile[] = await listEditorSettingsFiles();
	const settingsFile: EditorSettingsFile | null = settingsFiles.find((file: EditorSettingsFile): boolean => file.version === preferredVersion)
		?? settingsFiles[0]
		?? null;

	return {
		configDir: getGodotConfigDir(),
		projectEditorDir: getProjectEditorDir(),
		settingsFile,
		settingsFiles
	};
}

async function readEditorSettingsDocument(): Promise<{ paths: EditorConfigPaths; document: ProjectSettingsDocument | null }> {
	const paths: EditorConfigPaths = await getEditorConfigPaths();
	if (paths.settingsFile === null) {
		return { paths, document: null };
	}

	const content: string = await fs.readFile(paths.settingsFile.absolutePath, "utf8");
	return {
		paths,
		document: parseProjectSettings(content)
	};
}

function getEditorSettingKey(entry: ProjectSettingEntry): string {
	return entry.section === "resource" ? entry.name : entry.fullKey;
}

function findEditorSettingEntry(document: ProjectSettingsDocument, fullKey: string): ProjectSettingEntry | undefined {
	return document.entries.find((entry: ProjectSettingEntry): boolean => getEditorSettingKey(entry) === fullKey);
}

function formatEditorSettingEntry(entry: ProjectSettingEntry, raw: boolean): Record<string, unknown> {
	return {
		key: getEditorSettingKey(entry),
		section: entry.section,
		name: entry.name,
		valueExpression: redactSensitivePaths(entry.valueExpression, raw),
		lineStart: entry.lineStart + 1,
		lineEnd: entry.lineEnd + 1
	};
}

function decodeGodotQuotedString(quotedText: string): string {
	try {
		return JSON.parse(quotedText) as string;
	} catch {
		return quotedText.slice(1, -1);
	}
}

function parseGodotStringList(valueExpression: string | undefined): string[] {
	if (valueExpression === undefined) {
		return [];
	}

	const values: string[] = [];
	const stringPattern: RegExp = /"((?:[^"\\]|\\.)*)"/g;
	let match: RegExpExecArray | null;
	while ((match = stringPattern.exec(valueExpression)) !== null) {
		values.push(decodeGodotQuotedString(`"${match[1] ?? ""}"`));
	}

	return values;
}

function parseGodotIntArray(valueExpression: string | undefined): number[] {
	if (valueExpression === undefined) {
		return [];
	}

	const values: number[] = [];
	const match: RegExpMatchArray | null = valueExpression.match(/PackedInt32Array\(([^)]*)\)/);
	if (match === null || match[1] === undefined) {
		return values;
	}

	for (const rawValue of match[1].split(",")) {
		const trimmedValue: string = rawValue.trim();
		if (/^-?\d+$/.test(trimmedValue)) {
			values.push(Number.parseInt(trimmedValue, 10));
		}
	}

	return values;
}

function parseStateDictionaryNumber(valueExpression: string, key: string): number | null {
	const match: RegExpMatchArray | null = valueExpression.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
	return match === null ? null : Number(match[1]);
}

function parseStateDictionaryBoolean(valueExpression: string, key: string): boolean | null {
	const match: RegExpMatchArray | null = valueExpression.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`));
	return match === null ? null : match[1] === "true";
}

function parseStateDictionaryString(valueExpression: string, key: string): string | null {
	const match: RegExpMatchArray | null = valueExpression.match(new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
	return match === null || match[1] === undefined ? null : decodeGodotQuotedString(match[1]);
}

function createScriptEditorState(resourcePath: string, valueExpression: string): ScriptEditorState {
	const row: number | null = parseStateDictionaryNumber(valueExpression, "row");
	const storedColumn: number | null = parseStateDictionaryNumber(valueExpression, "column");
	return {
		resourcePath,
		line: row === null ? null : row + 1,
		column: storedColumn === null ? null : storedColumn + 1,
		row,
		storedColumn,
		breakpoints: parseGodotIntArray(valueExpression.match(/"breakpoints"\s*:\s*(PackedInt32Array\([^)]*\))/)?.[1]),
		bookmarks: parseGodotIntArray(valueExpression.match(/"bookmarks"\s*:\s*(PackedInt32Array\([^)]*\))/)?.[1]),
		selection: parseStateDictionaryBoolean(valueExpression, "selection"),
		syntaxHighlighter: parseStateDictionaryString(valueExpression, "syntax_highlighter")
	};
}

function sanitizePathList(values: readonly string[], raw: boolean): string[] {
	return values.map((value: string): string => redactOnePath(value, raw));
}

async function readConfigDocumentIfExists(absolutePath: string): Promise<ProjectSettingsDocument | null> {
	try {
		const content: string = await fs.readFile(absolutePath, "utf8");
		return parseProjectSettings(content);
	} catch {
		return null;
	}
}

function getDocumentValue(document: ProjectSettingsDocument | null, key: string): string | undefined {
	if (document === null) {
		return undefined;
	}

	return findProjectSettingEntry(document, key)?.valueExpression;
}

async function getEditorSettings(keys: string[] | undefined, prefix: string | undefined, raw: boolean | undefined): Promise<Record<string, unknown>> {
	const includeRaw: boolean = raw === true;
	const { paths, document } = await readEditorSettingsDocument();
	if (document === null) {
		return {
			ok: false,
			message: "No Godot editor_settings-*.tres file found.",
			configDir: redactOnePath(paths.configDir, includeRaw)
		};
	}

	const trimmedKeys: string[] = (keys ?? []).map((key: string): string => key.trim()).filter((key: string): boolean => key.length > 0);
	const trimmedPrefix: string | undefined = prefix?.trim();
	let entries: ProjectSettingEntry[];

	if (trimmedKeys.length > 0) {
		entries = trimmedKeys
			.map((key: string): ProjectSettingEntry | undefined => findEditorSettingEntry(document, key))
			.filter((entry: ProjectSettingEntry | undefined): entry is ProjectSettingEntry => entry !== undefined);
	} else if (trimmedPrefix !== undefined && trimmedPrefix.length > 0) {
		entries = document.entries.filter((entry: ProjectSettingEntry): boolean => getEditorSettingKey(entry).startsWith(trimmedPrefix));
	} else {
		entries = document.entries;
	}

	const clippedEntries: ProjectSettingEntry[] = entries.slice(0, MAX_EDITOR_SETTINGS_RESULT);
	const missingKeys: string[] = trimmedKeys.filter((key: string): boolean => findEditorSettingEntry(document, key) === undefined);
	const settingsFile: EditorSettingsFile | null = paths.settingsFile;
	if (settingsFile === null) {
		return {
			ok: false,
			message: "No Godot editor_settings-*.tres file found.",
			configDir: redactOnePath(paths.configDir, includeRaw)
		};
	}

	return {
		settingsFile: settingsFile.fileName,
		settingsPath: redactOnePath(settingsFile.absolutePath, includeRaw),
		settings: clippedEntries.map((entry: ProjectSettingEntry): Record<string, unknown> => formatEditorSettingEntry(entry, includeRaw)),
		missingKeys,
		totalMatched: entries.length,
		truncated: entries.length > clippedEntries.length
	};
}

async function maybeAddEditorConfigFile(files: EditorConfigFile[], scope: EditorConfigFileScope, rootPath: string, relativePath: string): Promise<void> {
	if (files.length >= MAX_EDITOR_CONFIG_FILES) {
		return;
	}

	const normalizedRelativePath: string = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
	const absolutePath: string = path.resolve(rootPath, normalizedRelativePath);
	if (!isPathInsideRoot(absolutePath, rootPath)) {
		return;
	}

	try {
		const stat = await fs.stat(absolutePath);
		if (!stat.isFile()) {
			return;
		}

		files.push({
			fileId: `${scope}:${normalizedRelativePath}`,
			scope,
			relativePath: normalizedRelativePath,
			absolutePath,
			size: stat.size,
			modifiedAt: stat.mtime.toISOString()
		});
	} catch {
		// Missing optional editor file.
	}
}

async function walkAllowedEditorSubdir(files: EditorConfigFile[], scope: EditorConfigFileScope, rootPath: string, subdir: string, allowedExtensions: ReadonlySet<string>): Promise<void> {
	const startPath: string = path.resolve(rootPath, subdir);
	if (!isPathInsideRoot(startPath, rootPath)) {
		return;
	}

	let entries: Dirent[];
	try {
		entries = await fs.readdir(startPath, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (files.length >= MAX_EDITOR_CONFIG_FILES) {
			return;
		}

		const relativePath: string = `${subdir}/${entry.name}`.replaceAll("\\", "/");
		const absolutePath: string = path.resolve(rootPath, relativePath);
		if (entry.isDirectory()) {
			await walkAllowedEditorSubdir(files, scope, rootPath, relativePath, allowedExtensions);
			continue;
		}

		if (!entry.isFile() || !allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
			continue;
		}

		await maybeAddEditorConfigFile(files, scope, rootPath, relativePath);
	}
}

async function listEditorConfigFiles(raw: boolean | undefined): Promise<Record<string, unknown>> {
	const includeRaw: boolean = raw === true;
	const paths: EditorConfigPaths = await getEditorConfigPaths();
	const files: EditorConfigFile[] = [];

	for (const settingsFile of paths.settingsFiles) {
		await maybeAddEditorConfigFile(files, "global_config", paths.configDir, settingsFile.fileName);
	}

	for (const fileName of ["projects.cfg", "recent_dirs", "favorite_dirs", "favorite_properties"]) {
		await maybeAddEditorConfigFile(files, "global_config", paths.configDir, fileName);
	}

	await walkAllowedEditorSubdir(files, "global_config", paths.configDir, "text_editor_themes", new Set([".tet"]));
	await walkAllowedEditorSubdir(files, "global_config", paths.configDir, "script_templates", new Set([".gd", ".cs", ".txt", ".md", ".cfg", ".json"]));

	let projectEditorEntries: Dirent[] = [];
	try {
		projectEditorEntries = await fs.readdir(paths.projectEditorDir, { withFileTypes: true });
	} catch {
		projectEditorEntries = [];
	}

	for (const entry of projectEditorEntries) {
		if (files.length >= MAX_EDITOR_CONFIG_FILES) {
			break;
		}

		if (!entry.isFile()) {
			continue;
		}

		const extension: string = path.extname(entry.name).toLowerCase();
		const allowed: boolean = extension === ".cfg"
			|| entry.name.startsWith("favorites")
			|| entry.name.startsWith("create_recent.");
		if (!allowed) {
			continue;
		}

		await maybeAddEditorConfigFile(files, "project_editor", paths.projectEditorDir, entry.name);
	}

	const visibleFiles: EditorConfigFile[] = files.slice(0, MAX_EDITOR_CONFIG_FILES);
	return {
		configDir: redactOnePath(paths.configDir, includeRaw),
		projectEditorDir: redactOnePath(paths.projectEditorDir, includeRaw),
		files: visibleFiles.map((file: EditorConfigFile): Record<string, unknown> => ({
			fileId: file.fileId,
			scope: file.scope,
			relativePath: file.relativePath,
			displayPath: file.scope === "global_config"
				? `Godot/${file.relativePath}`
				: `.godot/editor/${file.relativePath}`,
			absolutePath: includeRaw ? normalizeDisplayPath(file.absolutePath) : undefined,
			size: file.size,
			modifiedAt: file.modifiedAt
		})),
		totalMatched: files.length,
		truncated: files.length >= MAX_EDITOR_CONFIG_FILES
	};
}

function resolveEditorConfigFileIdentifier(fileId: string | undefined, filePath: string | undefined): { scope: EditorConfigFileScope; relativePath: string } {
	const value: string | undefined = fileId?.trim().length ? fileId.trim() : filePath?.trim();
	if (value === undefined || value.length === 0) {
		throw new Error("fileId or filePath is required");
	}

	const separatorIndex: number = value.indexOf(":");
	if (separatorIndex > 0) {
		const scopeText: string = value.slice(0, separatorIndex);
		if (scopeText === "global_config" || scopeText === "project_editor") {
			return {
				scope: scopeText,
				relativePath: value.slice(separatorIndex + 1).replaceAll("\\", "/").replace(/^\/+/, "")
			};
		}
	}

	if (value.startsWith(".godot/editor/")) {
		return {
			scope: "project_editor",
			relativePath: value.slice(".godot/editor/".length)
		};
	}

	if (value.startsWith("Godot/")) {
		return {
			scope: "global_config",
			relativePath: value.slice("Godot/".length)
		};
	}

	return {
		scope: "global_config",
		relativePath: value.replaceAll("\\", "/").replace(/^\/+/, "")
	};
}

function isAllowedGlobalEditorConfigPath(relativePath: string): boolean {
	const normalizedRelativePath: string = relativePath.replaceAll("\\", "/");
	const fileName: string = path.basename(normalizedRelativePath);
	if (/^editor_settings-\d+(?:\.\d+)?\.tres$/.test(fileName) && !normalizedRelativePath.includes("/")) {
		return true;
	}

	if (["projects.cfg", "recent_dirs", "favorite_dirs", "favorite_properties"].includes(normalizedRelativePath)) {
		return true;
	}

	if (normalizedRelativePath.startsWith("text_editor_themes/") && path.extname(normalizedRelativePath).toLowerCase() === ".tet") {
		return true;
	}

	if (normalizedRelativePath.startsWith("script_templates/")) {
		return [".gd", ".cs", ".txt", ".md", ".cfg", ".json"].includes(path.extname(normalizedRelativePath).toLowerCase());
	}

	return false;
}

function isAllowedProjectEditorConfigPath(relativePath: string): boolean {
	const normalizedRelativePath: string = relativePath.replaceAll("\\", "/");
	if (normalizedRelativePath.includes("/")) {
		return false;
	}

	const fileName: string = path.basename(normalizedRelativePath);
	return path.extname(fileName).toLowerCase() === ".cfg"
		|| fileName.startsWith("favorites")
		|| fileName.startsWith("create_recent.");
}

async function readEditorConfigFile(fileId: string | undefined, filePath: string | undefined, raw: boolean | undefined): Promise<Record<string, unknown>> {
	const includeRaw: boolean = raw === true;
	const paths: EditorConfigPaths = await getEditorConfigPaths();
	const identifier = resolveEditorConfigFileIdentifier(fileId, filePath);
	const rootPath: string = identifier.scope === "global_config" ? paths.configDir : paths.projectEditorDir;
	const relativePath: string = identifier.relativePath;

	if (relativePath.length === 0 || relativePath.includes("..")) {
		throw new Error(`Invalid editor config file path: ${relativePath}`);
	}

	const allowed: boolean = identifier.scope === "global_config"
		? isAllowedGlobalEditorConfigPath(relativePath)
		: isAllowedProjectEditorConfigPath(relativePath);
	if (!allowed) {
		throw new Error(`Editor config file is outside the read-only whitelist: ${identifier.scope}:${relativePath}`);
	}

	const absolutePath: string = path.resolve(rootPath, relativePath);
	if (!isPathInsideRoot(absolutePath, rootPath)) {
		throw new Error(`Editor config path traversal denied: ${relativePath}`);
	}

	const stat = await fs.stat(absolutePath);
	if (!stat.isFile()) {
		throw new Error(`Not an editor config file: ${relativePath}`);
	}

	if (stat.size > MAX_EDITOR_CONFIG_FILE_BYTES) {
		throw new Error(`Editor config file too large: ${relativePath} (${stat.size} bytes)`);
	}

	const content: string = await fs.readFile(absolutePath, "utf8");
	return {
		fileId: `${identifier.scope}:${relativePath}`,
		scope: identifier.scope,
		relativePath,
		displayPath: identifier.scope === "global_config"
			? `Godot/${relativePath}`
			: `.godot/editor/${relativePath}`,
		absolutePath: includeRaw ? normalizeDisplayPath(absolutePath) : undefined,
		size: stat.size,
		modifiedAt: stat.mtime.toISOString(),
		raw: includeRaw,
		content: redactSensitivePaths(content, includeRaw)
	};
}

function createRecentProjectSummary(sectionPath: string, favoriteValue: string | undefined, raw: boolean): Record<string, unknown> {
	const favorite: boolean = parseProjectSettingBoolean(favoriteValue, false);
	return {
		name: path.basename(sectionPath),
		path: redactOnePath(sectionPath, raw),
		absolutePath: raw ? normalizeDisplayPath(sectionPath) : undefined,
		isCurrentProject: isCurrentProjectPath(sectionPath),
		favorite
	};
}

async function getRecentProjects(raw: boolean | undefined): Promise<Record<string, unknown>> {
	const includeRaw: boolean = raw === true;
	const configDir: string = getGodotConfigDir();
	const projectsPath: string = path.join(configDir, "projects.cfg");
	const recentDirsPath: string = path.join(configDir, "recent_dirs");
	const projectsDocument: ProjectSettingsDocument | null = await readConfigDocumentIfExists(projectsPath);
	let recentProjects: Array<Record<string, unknown>> = [];

	if (projectsDocument !== null) {
		const sections: string[] = Array.from(new Set(projectsDocument.entries.map((entry: ProjectSettingEntry): string => entry.section)));
		recentProjects = sections.slice(0, MAX_RECENT_PROJECTS_RESULT).map((section: string): Record<string, unknown> =>
			createRecentProjectSummary(section, findProjectSettingEntry(projectsDocument, `${section}/favorite`)?.valueExpression, includeRaw)
		);
	}

	let recentDirs: string[] = [];
	try {
		const recentDirsContent: string = await fs.readFile(recentDirsPath, "utf8");
		recentDirs = recentDirsContent
			.split(/\r?\n/)
			.map((line: string): string => line.trim())
			.filter((line: string): boolean => line.length > 0)
			.slice(0, MAX_RECENT_PROJECTS_RESULT)
			.map((line: string): string => redactOnePath(line, includeRaw));
	} catch {
		recentDirs = [];
	}

	return {
		configDir: redactOnePath(configDir, includeRaw),
		projectsFile: redactOnePath(projectsPath, includeRaw),
		recentDirsFile: redactOnePath(recentDirsPath, includeRaw),
		projects: recentProjects,
		recentDirs,
		raw: includeRaw
	};
}

async function getEditorProjectState(raw: boolean | undefined): Promise<Record<string, unknown>> {
	const includeRaw: boolean = raw === true;
	const projectEditorDir: string = getProjectEditorDir();
	const layoutDocument: ProjectSettingsDocument | null = await readConfigDocumentIfExists(path.join(projectEditorDir, "editor_layout.cfg"));
	const scriptCacheDocument: ProjectSettingsDocument | null = await readConfigDocumentIfExists(path.join(projectEditorDir, "script_editor_cache.cfg"));
	const openScenes: string[] = parseGodotStringList(getDocumentValue(layoutDocument, "EditorNode/open_scenes"));
	const currentScene: string | undefined = parseProjectSettingString(getDocumentValue(layoutDocument, "EditorNode/current_scene"));
	const fileSystemSelectedPaths: string[] = parseGodotStringList(getDocumentValue(layoutDocument, "docks/FileSystem/selected_paths"));
	const fileSystemUncollapsedPaths: string[] = parseGodotStringList(getDocumentValue(layoutDocument, "docks/FileSystem/uncollapsed_paths"));
	const openScripts: string[] = parseGodotStringList(getDocumentValue(layoutDocument, "ScriptEditor/open_scripts"));
	const selectedScript: string | undefined = parseProjectSettingString(getDocumentValue(layoutDocument, "ScriptEditor/selected_script"));
	const openHelp: string[] = parseGodotStringList(getDocumentValue(layoutDocument, "ScriptEditor/open_help"));
	const scriptStates: ScriptEditorState[] = scriptCacheDocument === null
		? []
		: scriptCacheDocument.entries
			.filter((entry: ProjectSettingEntry): boolean => entry.name === "state")
			.map((entry: ProjectSettingEntry): ScriptEditorState => createScriptEditorState(entry.section, entry.valueExpression));
	const selectedScriptState: ScriptEditorState | undefined = selectedScript === undefined
		? undefined
		: scriptStates.find((state: ScriptEditorState): boolean => state.resourcePath === selectedScript);

	return {
		projectEditorDir: redactOnePath(projectEditorDir, includeRaw),
		layoutFileExists: layoutDocument !== null,
		scriptCacheFileExists: scriptCacheDocument !== null,
		openScenes: sanitizePathList(openScenes, includeRaw),
		currentScene: currentScene === undefined ? null : redactOnePath(currentScene, includeRaw),
		fileSystemSelectedPaths: sanitizePathList(fileSystemSelectedPaths, includeRaw),
		fileSystemUncollapsedPathCount: fileSystemUncollapsedPaths.length,
		openScripts: sanitizePathList(openScripts, includeRaw),
		selectedScript: selectedScript === undefined ? null : redactOnePath(selectedScript, includeRaw),
		selectedScriptState: selectedScriptState === undefined ? null : {
			...selectedScriptState,
			resourcePath: redactOnePath(selectedScriptState.resourcePath, includeRaw)
		},
		openHelp,
		scriptStates: scriptStates.slice(0, 50).map((state: ScriptEditorState): ScriptEditorState => ({
			...state,
			resourcePath: redactOnePath(state.resourcePath, includeRaw)
		})),
		scriptStateCount: scriptStates.length,
		raw: includeRaw
	};
}

async function getEditorConfigSummary(raw: boolean | undefined): Promise<Record<string, unknown>> {
	const includeRaw: boolean = raw === true;
	const { paths, document } = await readEditorSettingsDocument();
	const recentProjects: Record<string, unknown> = await getRecentProjects(includeRaw);
	const projectState: Record<string, unknown> = await getEditorProjectState(includeRaw);
	const settingValue = (key: string): string | undefined => document === null ? undefined : findEditorSettingEntry(document, key)?.valueExpression;
	const openScenes: unknown = projectState["openScenes"];
	const openScripts: unknown = projectState["openScripts"];
	const recentProjectsValue: unknown = recentProjects["projects"];

	return {
		configDir: redactOnePath(paths.configDir, includeRaw),
		projectEditorDir: redactOnePath(paths.projectEditorDir, includeRaw),
		settingsFile: paths.settingsFile === null ? null : {
			fileName: paths.settingsFile.fileName,
			version: paths.settingsFile.version,
			path: redactOnePath(paths.settingsFile.absolutePath, includeRaw),
			size: paths.settingsFile.size,
			modifiedAt: paths.settingsFile.modifiedAt
		},
		availableSettingsFiles: paths.settingsFiles.map((file: EditorSettingsFile): Record<string, unknown> => ({
			fileName: file.fileName,
			version: file.version,
			path: redactOnePath(file.absolutePath, includeRaw),
			modifiedAt: file.modifiedAt
		})),
		interface: {
			language: parseProjectSettingString(settingValue("interface/editor/localization/editor_language")) ?? null,
			displayScale: settingValue("interface/editor/appearance/display_scale") ?? null,
			customDisplayScale: settingValue("interface/editor/appearance/custom_display_scale") ?? null,
			mainFontSize: settingValue("interface/editor/fonts/main_font_size") ?? null,
			codeFontSize: settingValue("interface/editor/fonts/code_font_size") ?? null,
			mainFont: redactSensitivePaths(parseProjectSettingString(settingValue("interface/editor/fonts/main_font")) ?? "", includeRaw),
			codeFont: redactSensitivePaths(parseProjectSettingString(settingValue("interface/editor/fonts/code_font")) ?? "", includeRaw)
		},
		theme: {
			style: parseProjectSettingString(settingValue("interface/theme/style")) ?? null,
			colorPreset: parseProjectSettingString(settingValue("interface/theme/color_preset")) ?? null,
			baseColor: settingValue("interface/theme/base_color") ?? null,
			accentColor: settingValue("interface/theme/accent_color") ?? null,
			cornerRadius: settingValue("interface/theme/corner_radius") ?? null
		},
		recentProjectCount: Array.isArray(recentProjectsValue) ? recentProjectsValue.length : 0,
		projectState: {
			currentScene: projectState["currentScene"],
			openSceneCount: Array.isArray(openScenes) ? openScenes.length : 0,
			selectedScript: projectState["selectedScript"],
			openScriptCount: Array.isArray(openScripts) ? openScripts.length : 0,
			fileSystemSelectedPaths: projectState["fileSystemSelectedPaths"]
		},
		raw: includeRaw,
		privacyNote: includeRaw
			? "raw=true：工具结果包含原始本机路径。"
			: "默认已脱敏：非当前项目绝对路径会被隐藏，Godot 配置目录会显示为 %APPDATA%/Godot。"
	};
}

export function registerEditorConfigTools(server: McpServer): void {
server.registerTool(
		"get_editor_config_summary",
		{
			title: "Get Godot Editor Config Summary",
			description: "读取 Godot 编辑器全局设置和当前项目 .godot/editor 状态摘要。默认脱敏本机路径；只有 raw=true 时返回原始路径。",
			inputSchema: z.object({
				raw: z.boolean().optional().describe("是否返回原始本机路径。默认 false，会脱敏用户名和非当前项目绝对路径。")
			})
		},
		async ({ raw }) => asJsonTextResult(await getEditorConfigSummary(raw))
	);

server.registerTool(
		"get_editor_settings",
		{
			title: "Get Godot Editor Settings",
			description: "按 key 或 prefix 读取 editor_settings-*.tres 中的编辑器设置，例如 interface/theme/ 或 text_editor/。默认脱敏路径值。",
			inputSchema: z.object({
				keys: z.array(z.string().min(1)).max(64).optional().describe("可选，按完整 EditorSettings key 精确读取"),
				prefix: z.string().optional().describe("可选，按 key 前缀过滤，例如 interface/theme/"),
				raw: z.boolean().optional().describe("是否返回原始路径值。默认 false。")
			})
		},
		async ({ keys, prefix, raw }) => asJsonTextResult(await getEditorSettings(keys, prefix, raw))
	);

server.registerTool(
		"list_editor_config_files",
		{
			title: "List Godot Editor Config Files",
			description: "列出只读白名单中的 Godot 编辑器配置文件，包括 editor_settings、projects.cfg、recent_dirs、text_editor_themes、script_templates 和当前项目 .godot/editor/*.cfg。",
			inputSchema: z.object({
				raw: z.boolean().optional().describe("是否返回原始绝对路径。默认 false。")
			})
		},
		async ({ raw }) => asJsonTextResult(await listEditorConfigFiles(raw))
	);

server.registerTool(
		"read_editor_config_file",
		{
			title: "Read Godot Editor Config File",
			description: "读取 list_editor_config_files 返回的白名单编辑器配置文件。默认脱敏内容中的本机路径；只有 raw=true 时返回原文。",
			inputSchema: z.object({
				fileId: z.string().optional().describe("来自 list_editor_config_files 的 fileId，例如 global_config:editor_settings-4.7.tres"),
				filePath: z.string().optional().describe("可选路径写法；推荐优先使用 fileId"),
				raw: z.boolean().optional().describe("是否返回原始内容。默认 false。")
			})
		},
		async ({ fileId, filePath, raw }) => asJsonTextResult(await readEditorConfigFile(fileId, filePath, raw))
	);

server.registerTool(
		"get_editor_project_state",
		{
			title: "Get Godot Editor Project State",
			description: "结构化读取当前项目 .godot/editor/editor_layout.cfg 与 script_editor_cache.cfg，返回打开场景、脚本、FileSystem 选中项和光标状态。默认脱敏路径。",
			inputSchema: z.object({
				raw: z.boolean().optional().describe("是否返回原始路径。默认 false。")
			})
		},
		async ({ raw }) => asJsonTextResult(await getEditorProjectState(raw))
	);

server.registerTool(
		"get_recent_projects",
		{
			title: "Get Godot Recent Projects",
			description: "读取 Godot projects.cfg 和 recent_dirs，返回最近项目与最近目录。默认脱敏非当前项目路径；raw=true 时返回原始路径。",
			inputSchema: z.object({
				raw: z.boolean().optional().describe("是否返回原始路径。默认 false。")
			})
		},
		async ({ raw }) => asJsonTextResult(await getRecentProjects(raw))
	);

}
