import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

const MAX_TEXT_FILE_BYTES: number = 512 * 1024;
const MAX_NEW_FILE_BYTES: number = 64 * 1024;
const MAX_PROJECT_LOG_BYTES: number = 256 * 1024;
const DEFAULT_PROJECT_LOG_LINES: number = 200;
const MAX_PROJECT_LOG_LINES: number = 1000;
const MAX_PROJECT_SETTING_VALUE_CHARS: number = 16 * 1024;
const MAX_PROJECT_SETTING_VALUE_LINES: number = 240;
const MAX_PROJECT_SETTINGS_RESULT: number = 500;
const MAX_EDITOR_CONFIG_FILE_BYTES: number = 256 * 1024;
const MAX_EDITOR_CONFIG_FILES: number = 500;
const MAX_EDITOR_SETTINGS_RESULT: number = 500;
const MAX_RECENT_PROJECTS_RESULT: number = 100;

const PROJECT_CONFIG_FILE_NAME: string = "project.godot";
const DEFAULT_GODOT_LOG_PATH: string = "user://logs/godot.log";
const DEFAULT_GODOT_LOG_MAX_FILES: number = 5;
const GODOT_CONFIG_DIR_NAME: string = "Godot";

const WRITABLE_EXTENSIONS: Set<string> = new Set([
	".gd",
	".tres",
	".tscn",
	".json",
	".md",
	".txt"
]);

const MAX_TSCN_FILE_BYTES: number = 256 * 1024;

const DEFAULT_IGNORED_DIRECTORIES: Set<string> = new Set([
	".git",
	".godot",
	".vscode",
	".idea",
	"android",
	"node_modules"
]);

const TEXT_EXTENSIONS: Set<string> = new Set([
	".cfg",
	".cs",
	".gd",
	".gdshader",
	".godot",
	".json",
	".md",
	".res",
	".tres",
	".tscn",
	".txt",
	".uid"
]);

type ProjectSummary = {
	path: string;
	name: string;
	mainScene: string;
	features: string;
	addons: string[];
	sceneCount: number;
	scriptCount: number;
};

type ProjectSettingEntry = {
	section: string;
	name: string;
	fullKey: string;
	valueExpression: string;
	lineStart: number;
	lineEnd: number;
};

type ProjectSettingsDocument = {
	content: string;
	lines: string[];
	entries: ProjectSettingEntry[];
	sectionLineIndexes: Map<string, number>;
};

type ResolvedGodotPath = {
	originalPath: string;
	absolutePath: string;
	rootPath: string;
	kind: "user" | "res" | "absolute" | "relative_user";
};

type ProjectLogConfig = {
	projectName: string;
	userDataDir: string;
	logPath: string;
	logPathSource: "project" | "default";
	absolutePath: string;
	logDirectory: string;
	fileLoggingEnabled: boolean;
	fileLoggingEnabledSource: "project" | "default_pc";
	maxLogFiles: number;
	maxLogFilesSource: "project" | "default";
	pathKind: ResolvedGodotPath["kind"];
	resolutionNote: string;
};

type ProjectLogFile = {
	fileName: string;
	absolutePath: string;
	size: number;
	modifiedAt: string;
};

type EditorSettingsFile = {
	fileName: string;
	absolutePath: string;
	version: string;
	major: number;
	minor: number;
	size: number;
	modifiedAt: string;
};

type EditorConfigFileScope = "global_config" | "project_editor";

type EditorConfigFile = {
	fileId: string;
	scope: EditorConfigFileScope;
	relativePath: string;
	absolutePath: string;
	size: number;
	modifiedAt: string;
};

type EditorConfigPaths = {
	configDir: string;
	projectEditorDir: string;
	settingsFile: EditorSettingsFile | null;
	settingsFiles: EditorSettingsFile[];
};

type ScriptEditorState = {
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

const projectPathText: string | undefined = process.env.GODOT_PROJECT_PATH;

if (projectPathText === undefined || projectPathText.trim().length === 0) {
	console.error("GODOT_PROJECT_PATH environment variable is required");
	process.exit(1);
}

const projectRoot: string = path.resolve(projectPathText);

function toProjectRelativePath(absolutePath: string): string {
	return path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/");
}

function isPathInsideProject(absolutePath: string): boolean {
	const relativePath: string = path.relative(projectRoot, absolutePath);
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function resolveProjectPath(relativePath: string): Promise<string> {
	const cleanedPath: string = relativePath.trim();
	const resolvedPath: string = path.resolve(projectRoot, cleanedPath.length > 0 ? cleanedPath : ".");

	if (!isPathInsideProject(resolvedPath)) {
		throw new Error(`Path traversal denied: ${relativePath}`);
	}

	return resolvedPath;
}

function shouldSkipDirectory(name: string): boolean {
	return DEFAULT_IGNORED_DIRECTORIES.has(name);
}

async function assertProjectExists(): Promise<void> {
	const stat = await fs.stat(projectRoot);
	if (!stat.isDirectory()) {
		throw new Error(`GODOT_PROJECT_PATH is not a directory: ${projectRoot}`);
	}

	await fs.access(path.join(projectRoot, PROJECT_CONFIG_FILE_NAME));
}

async function walkProjectFiles(options?: {
	subdir?: string | undefined;
	extensions?: string[] | undefined;
	includeAddons?: boolean | undefined;
}): Promise<string[]> {
	const startPath: string = options?.subdir !== undefined
		? await resolveProjectPath(options.subdir)
		: projectRoot;
	const extensions: Set<string> | undefined = options?.extensions !== undefined && options.extensions.length > 0
		? new Set(options.extensions.map((extension: string): string => extension.startsWith(".") ? extension : `.${extension}`))
		: undefined;
	const results: string[] = [];

	async function walk(directoryPath: string): Promise<void> {
		const entries: Dirent[] = await fs.readdir(directoryPath, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.isDirectory() && shouldSkipDirectory(entry.name)) {
				continue;
			}

			if (entry.isDirectory() && entry.name === "addons" && options?.includeAddons !== true) {
				continue;
			}

			const fullPath: string = path.join(directoryPath, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			const extension: string = path.extname(entry.name);
			if (extensions !== undefined && !extensions.has(extension)) {
				continue;
			}

			results.push(toProjectRelativePath(fullPath));
		}
	}

	await walk(startPath);
	results.sort();
	return results;
}

function getProjectConfigPath(): string {
	return path.join(projectRoot, PROJECT_CONFIG_FILE_NAME);
}

function normalizeConfigContent(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function getExpressionBalance(text: string): number {
	let balance: number = 0;
	let quote: string = "";
	let escaped: boolean = false;

	for (const char of text) {
		if (quote.length > 0) {
			if (escaped) {
				escaped = false;
				continue;
			}

			if (char === "\\") {
				escaped = true;
				continue;
			}

			if (char === quote) {
				quote = "";
			}
			continue;
		}

		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}

		if (char === "{" || char === "[" || char === "(") {
			balance += 1;
		} else if (char === "}" || char === "]" || char === ")") {
			balance -= 1;
		}
	}

	return balance;
}

function makeProjectSettingFullKey(section: string, name: string): string {
	return section.length > 0 ? `${section}/${name}` : name;
}

function parseProjectSettings(content: string): ProjectSettingsDocument {
	const normalizedContent: string = normalizeConfigContent(content);
	const lines: string[] = normalizedContent.split("\n");
	const entries: ProjectSettingEntry[] = [];
	const sectionLineIndexes: Map<string, number> = new Map();
	let currentSection: string = "";
	let index: number = 0;

	while (index < lines.length) {
		const line: string = lines[index]!;
		const trimmedLine: string = line.trim();
		const sectionMatch: RegExpMatchArray | null = trimmedLine.match(/^\[([^\]]+)\]$/);

		if (sectionMatch !== null) {
			currentSection = sectionMatch[1]!.trim();
			sectionLineIndexes.set(currentSection, index);
			index += 1;
			continue;
		}

		if (trimmedLine.length === 0 || trimmedLine.startsWith(";")) {
			index += 1;
			continue;
		}

		const equalsIndex: number = line.indexOf("=");
		if (equalsIndex === -1) {
			index += 1;
			continue;
		}

		const name: string = line.slice(0, equalsIndex).trim();
		if (name.length === 0) {
			index += 1;
			continue;
		}

		const valueLines: string[] = [line.slice(equalsIndex + 1)];
		let balance: number = getExpressionBalance(valueLines[0]!);
		let lineEnd: number = index;

		while (balance > 0 && lineEnd + 1 < lines.length) {
			lineEnd += 1;
			const nextLine: string = lines[lineEnd]!;
			valueLines.push(nextLine);
			balance += getExpressionBalance(nextLine);
		}

		entries.push({
			section: currentSection,
			name,
			fullKey: makeProjectSettingFullKey(currentSection, name),
			valueExpression: valueLines.join("\n").trimEnd(),
			lineStart: index,
			lineEnd
		});

		index = lineEnd + 1;
	}

	return {
		content: normalizedContent,
		lines,
		entries,
		sectionLineIndexes
	};
}

async function readProjectSettingsDocument(): Promise<ProjectSettingsDocument> {
	const content: string = await fs.readFile(getProjectConfigPath(), "utf8");
	return parseProjectSettings(content);
}

async function readProjectConfig(): Promise<Record<string, string>> {
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const config: Record<string, string> = {};

	for (const entry of document.entries) {
		config[entry.fullKey] = entry.valueExpression;
	}

	return config;
}

function parseProjectSettingString(valueExpression: string | undefined): string | undefined {
	if (valueExpression === undefined) {
		return undefined;
	}

	const trimmedValue: string = valueExpression.trim();
	if (trimmedValue.startsWith("\"") && trimmedValue.endsWith("\"")) {
		try {
			return JSON.parse(trimmedValue) as string;
		} catch {
			return trimmedValue.slice(1, -1);
		}
	}

	return trimmedValue;
}

function parseProjectSettingBoolean(valueExpression: string | undefined, fallback: boolean): boolean {
	const trimmedValue: string | undefined = valueExpression?.trim();
	if (trimmedValue === "true") {
		return true;
	}

	if (trimmedValue === "false") {
		return false;
	}

	return fallback;
}

function parseProjectSettingInteger(valueExpression: string | undefined, fallback: number): number {
	const trimmedValue: string | undefined = valueExpression?.trim();
	if (trimmedValue === undefined || !/^-?\d+$/.test(trimmedValue)) {
		return fallback;
	}

	return Number.parseInt(trimmedValue, 10);
}

function parseProjectFeatureVersion(config: Record<string, string>): string | undefined {
	const featuresValue: string | undefined = config["application/config/features"] ?? config["config/features"];
	if (featuresValue === undefined) {
		return undefined;
	}

	const match: RegExpMatchArray | null = featuresValue.match(/"(\d+\.\d+)"/);
	return match?.[1];
}

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

async function listAddons(): Promise<string[]> {
	const addonsPath: string = path.join(projectRoot, "addons");
	try {
		const entries: Dirent[] = await fs.readdir(addonsPath, { withFileTypes: true });
		return entries
			.filter((entry: Dirent): boolean => entry.isDirectory())
			.map((entry: Dirent): string => entry.name)
			.sort();
	} catch {
		return [];
	}
}

async function getProjectSummary(): Promise<ProjectSummary> {
	const config: Record<string, string> = await readProjectConfig();
	const scenes: string[] = await walkProjectFiles({ extensions: [".tscn"] });
	const scripts: string[] = await walkProjectFiles({ extensions: [".gd"] });
	const addons: string[] = await listAddons();

	return {
		path: projectRoot,
		name: parseProjectSettingString(config["application/config/name"] ?? config["config/name"]) ?? "unknown",
		mainScene: parseProjectSettingString(config["application/run/main_scene"] ?? config["run/main_scene"]) ?? "",
		features: config["application/config/features"] ?? config["config/features"] ?? "",
		addons,
		sceneCount: scenes.length,
		scriptCount: scripts.length
	};
}

async function readTextFile(relativePath: string): Promise<string> {
	const fullPath: string = await resolveProjectPath(relativePath);
	const stat = await fs.stat(fullPath);

	if (!stat.isFile()) {
		throw new Error(`Not a file: ${relativePath}`);
	}

	if (stat.size > MAX_TEXT_FILE_BYTES) {
		throw new Error(`File too large: ${relativePath} (${stat.size} bytes)`);
	}

	const extension: string = path.extname(fullPath);
	const fileName: string = path.basename(fullPath);
	if (fileName !== "project.godot" && !TEXT_EXTENSIONS.has(extension)) {
		throw new Error(`Unsupported text file extension: ${extension || "(none)"}`);
	}

	return fs.readFile(fullPath, "utf8");
}

function isPathInsideRoot(absolutePath: string, rootPath: string): boolean {
	const relativePath: string = path.relative(rootPath, absolutePath);
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function getWindowsAppDataPath(): string {
	const appDataPath: string | undefined = process.env.APPDATA;
	if (appDataPath === undefined || appDataPath.trim().length === 0) {
		throw new Error("APPDATA is not configured; cannot resolve Godot user:// paths");
	}

	return appDataPath;
}

function getUserProfilePath(): string | undefined {
	const userProfilePath: string | undefined = process.env.USERPROFILE;
	return userProfilePath !== undefined && userProfilePath.trim().length > 0
		? path.resolve(userProfilePath)
		: undefined;
}

function getGodotConfigDir(): string {
	return path.join(getWindowsAppDataPath(), GODOT_CONFIG_DIR_NAME);
}

function getProjectEditorDir(): string {
	return path.join(projectRoot, ".godot", "editor");
}

function normalizeDisplayPath(value: string): string {
	return value.replaceAll("\\", "/");
}

function isWindowsAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value);
}

function isCurrentProjectPath(value: string): boolean {
	if (!isWindowsAbsolutePath(value) && !path.isAbsolute(value)) {
		return false;
	}

	return isPathInsideRoot(path.resolve(value), projectRoot);
}

function redactOnePath(value: string, raw: boolean): string {
	if (raw || value.startsWith("res://") || value.startsWith("uid://") || value.startsWith("user://")) {
		return normalizeDisplayPath(value);
	}

	const normalizedValue: string = normalizeDisplayPath(value);
	const userProfilePath: string | undefined = getUserProfilePath();
	const appDataPath: string = path.resolve(getWindowsAppDataPath());
	const godotConfigDir: string = path.resolve(getGodotConfigDir());

	if (isCurrentProjectPath(normalizedValue)) {
		return normalizeDisplayPath(path.resolve(normalizedValue));
	}

	if (isPathInsideRoot(path.resolve(normalizedValue), godotConfigDir)) {
		const relativePath: string = path.relative(godotConfigDir, path.resolve(normalizedValue)).replaceAll(path.sep, "/");
		return `%APPDATA%/Godot/${relativePath}`;
	}

	if (isPathInsideRoot(path.resolve(normalizedValue), appDataPath)) {
		const relativePath: string = path.relative(appDataPath, path.resolve(normalizedValue)).replaceAll(path.sep, "/");
		return `%APPDATA%/${relativePath}`;
	}

	if (userProfilePath !== undefined && isPathInsideRoot(path.resolve(normalizedValue), userProfilePath)) {
		const relativePath: string = path.relative(userProfilePath, path.resolve(normalizedValue)).replaceAll(path.sep, "/");
		return `%USERPROFILE%/${relativePath}`;
	}

	if (isWindowsAbsolutePath(normalizedValue) || path.isAbsolute(normalizedValue)) {
		return `[redacted]/${path.basename(normalizedValue)}`;
	}

	return normalizedValue;
}

function redactSensitivePaths(text: string, raw: boolean): string {
	if (raw) {
		return normalizeDisplayPath(text);
	}

	let redactedText: string = normalizeDisplayPath(text);
	const userProfilePath: string | undefined = getUserProfilePath();
	const replacements: Array<[string, string]> = [
		[normalizeDisplayPath(getGodotConfigDir()), "%APPDATA%/Godot"],
		[normalizeDisplayPath(getWindowsAppDataPath()), "%APPDATA%"],
		[normalizeDisplayPath(projectRoot), normalizeDisplayPath(projectRoot)]
	];

	if (userProfilePath !== undefined) {
		replacements.push([normalizeDisplayPath(userProfilePath), "%USERPROFILE%"]);
	}

	for (const [fromText, toText] of replacements) {
		if (fromText.length > 0) {
			redactedText = redactedText.replaceAll(fromText, toText);
		}
	}

	redactedText = redactedText.replace(/[A-Za-z]:\/[^"\s,)]+/g, (matchedPath: string): string => {
		if (isCurrentProjectPath(matchedPath) || matchedPath.startsWith("%APPDATA%") || matchedPath.startsWith("%USERPROFILE%")) {
			return matchedPath;
		}

		return `[redacted]/${path.basename(matchedPath)}`;
	});

	return redactedText;
}

function sanitizeGodotUserDirName(value: string): string {
	const sanitized: string = value.trim()
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
		.replace(/[. ]+$/g, "")
		.trim();

	return sanitized.length > 0 ? sanitized : "[unnamed project]";
}

function getProjectNameForUserData(config: Record<string, string>): string {
	const projectName: string | undefined = parseProjectSettingString(config["application/config/name"]);
	return sanitizeGodotUserDirName(projectName ?? "[unnamed project]");
}

function getGodotUserDataDir(config: Record<string, string>): string {
	const appDataPath: string = getWindowsAppDataPath();
	const projectName: string = getProjectNameForUserData(config);
	const useCustomUserDir: boolean = parseProjectSettingBoolean(config["application/config/use_custom_user_dir"], false);

	if (useCustomUserDir) {
		const customUserDirName: string | undefined = parseProjectSettingString(config["application/config/custom_user_dir_name"]);
		return path.join(appDataPath, sanitizeGodotUserDirName(customUserDirName ?? projectName));
	}

	return path.join(appDataPath, "Godot", "app_userdata", projectName);
}

function resolveGodotPath(resourcePath: string, config: Record<string, string>): ResolvedGodotPath {
	const trimmedPath: string = resourcePath.trim();
	const userDataDir: string = getGodotUserDataDir(config);

	if (trimmedPath.startsWith("user://")) {
		const relativePath: string = trimmedPath.slice("user://".length).replace(/^[/\\]+/, "");
		const absolutePath: string = path.resolve(userDataDir, relativePath);
		if (!isPathInsideRoot(absolutePath, userDataDir)) {
			throw new Error(`user:// path traversal denied: ${resourcePath}`);
		}

		return {
			originalPath: resourcePath,
			absolutePath,
			rootPath: userDataDir,
			kind: "user"
		};
	}

	if (trimmedPath.startsWith("res://")) {
		const relativePath: string = trimmedPath.slice("res://".length).replace(/^[/\\]+/, "");
		const absolutePath: string = path.resolve(projectRoot, relativePath);
		if (!isPathInsideRoot(absolutePath, projectRoot)) {
			throw new Error(`res:// path traversal denied: ${resourcePath}`);
		}

		return {
			originalPath: resourcePath,
			absolutePath,
			rootPath: projectRoot,
			kind: "res"
		};
	}

	if (!path.isAbsolute(trimmedPath)) {
		const absolutePath: string = path.resolve(userDataDir, trimmedPath);
		if (!isPathInsideRoot(absolutePath, userDataDir)) {
			throw new Error(`Relative user data path traversal denied: ${resourcePath}`);
		}

		return {
			originalPath: resourcePath,
			absolutePath,
			rootPath: userDataDir,
			kind: "relative_user"
		};
	}

	const absolutePath: string = path.resolve(trimmedPath);
	if (!isPathInsideRoot(absolutePath, userDataDir) && !isPathInsideRoot(absolutePath, projectRoot)) {
		throw new Error(`Absolute path is outside allowed Godot project/user data roots: ${resourcePath}`);
	}

	return {
		originalPath: resourcePath,
		absolutePath,
		rootPath: isPathInsideRoot(absolutePath, userDataDir) ? userDataDir : projectRoot,
		kind: "absolute"
	};
}

async function getProjectLogConfig(): Promise<ProjectLogConfig> {
	const config: Record<string, string> = await readProjectConfig();
	const projectName: string = getProjectNameForUserData(config);
	const userDataDir: string = getGodotUserDataDir(config);
	const configuredLogPath: string | undefined = parseProjectSettingString(config["debug/file_logging/log_path"]);
	const logPath: string = configuredLogPath ?? DEFAULT_GODOT_LOG_PATH;
	const resolvedPath: ResolvedGodotPath = resolveGodotPath(logPath, config);
	const hasExplicitFileLogging: boolean = config["debug/file_logging/enable_file_logging"] !== undefined
		|| config["debug/file_logging/enable_file_logging.pc"] !== undefined;
	const fileLoggingEnabled: boolean = parseProjectSettingBoolean(
		config["debug/file_logging/enable_file_logging.pc"] ?? config["debug/file_logging/enable_file_logging"],
		true
	);
	const configuredMaxLogFiles: string | undefined = config["debug/file_logging/max_log_files"];
	const maxLogFiles: number = Math.max(0, parseProjectSettingInteger(configuredMaxLogFiles, DEFAULT_GODOT_LOG_MAX_FILES));

	return {
		projectName,
		userDataDir,
		logPath,
		logPathSource: configuredLogPath === undefined ? "default" : "project",
		absolutePath: resolvedPath.absolutePath,
		logDirectory: path.dirname(resolvedPath.absolutePath),
		fileLoggingEnabled,
		fileLoggingEnabledSource: hasExplicitFileLogging ? "project" : "default_pc",
		maxLogFiles,
		maxLogFilesSource: configuredMaxLogFiles === undefined ? "default" : "project",
		pathKind: resolvedPath.kind,
		resolutionNote: "Godot 的 user:// 会解析到 OS.get_user_data_dir()；当前 Windows 项目默认位于 %APPDATA%/Godot/app_userdata/<application/config/name>。"
	};
}

async function listProjectLogFiles(): Promise<{ config: ProjectLogConfig; logs: ProjectLogFile[] }> {
	const config: ProjectLogConfig = await getProjectLogConfig();
	const baseName: string = path.basename(config.absolutePath);
	const extension: string = path.extname(baseName) || ".log";
	const stem: string = baseName.endsWith(extension) ? baseName.slice(0, -extension.length) : baseName;

	let entries: Dirent[];
	try {
		entries = await fs.readdir(config.logDirectory, { withFileTypes: true });
	} catch {
		return { config, logs: [] };
	}

	const logs: ProjectLogFile[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}

		const fileName: string = entry.name;
		if (fileName !== baseName && (!fileName.startsWith(stem) || !fileName.endsWith(extension))) {
			continue;
		}

		const absolutePath: string = path.resolve(config.logDirectory, fileName);
		if (!isPathInsideRoot(absolutePath, config.logDirectory)) {
			continue;
		}

		const stat = await fs.stat(absolutePath);
		logs.push({
			fileName,
			absolutePath,
			size: stat.size,
			modifiedAt: stat.mtime.toISOString()
		});
	}

	logs.sort((left: ProjectLogFile, right: ProjectLogFile): number =>
		Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt)
	);
	return { config, logs };
}

async function readFileTail(absolutePath: string, maxBytes: number): Promise<{ text: string; bytesRead: number; truncatedBytes: boolean }> {
	const stat = await fs.stat(absolutePath);
	const bytesToRead: number = Math.min(stat.size, maxBytes);
	const start: number = Math.max(0, stat.size - bytesToRead);
	const handle = await fs.open(absolutePath, "r");

	try {
		const buffer: Buffer = Buffer.alloc(bytesToRead);
		await handle.read(buffer, 0, bytesToRead, start);
		let text: string = buffer.toString("utf8");
		if (start > 0) {
			const firstNewlineIndex: number = text.indexOf("\n");
			if (firstNewlineIndex >= 0) {
				text = text.slice(firstNewlineIndex + 1);
			}
		}

		return {
			text,
			bytesRead: bytesToRead,
			truncatedBytes: stat.size > bytesToRead
		};
	} finally {
		await handle.close();
	}
}

async function readProjectLog(fileName: string | undefined, lines: number | undefined): Promise<Record<string, unknown>> {
	const { config, logs } = await listProjectLogFiles();
	const requestedLines: number = Math.max(1, Math.min(MAX_PROJECT_LOG_LINES, Math.floor(lines ?? DEFAULT_PROJECT_LOG_LINES)));
	const baseName: string = path.basename(config.absolutePath);
	let selectedLog: ProjectLogFile | undefined;

	if (fileName !== undefined && fileName.trim().length > 0) {
		const normalizedFileName: string = path.basename(fileName.trim());
		if (normalizedFileName !== fileName.trim() || normalizedFileName.includes("/") || normalizedFileName.includes("\\")) {
			throw new Error("fileName must be a plain log file name from mcp_godot_list_project_logs");
		}

		selectedLog = logs.find((log: ProjectLogFile): boolean => log.fileName === normalizedFileName);
	} else {
		selectedLog = logs.find((log: ProjectLogFile): boolean => log.fileName === baseName) ?? logs[0];
	}

	if (selectedLog === undefined) {
		return {
			ok: false,
			message: "No Godot project log file found.",
			config,
			logs
		};
	}

	const absolutePath: string = path.resolve(config.logDirectory, selectedLog.fileName);
	if (!isPathInsideRoot(absolutePath, config.logDirectory)) {
		throw new Error(`Log path traversal denied: ${selectedLog.fileName}`);
	}

	const tail = await readFileTail(absolutePath, MAX_PROJECT_LOG_BYTES);
	const allLines: string[] = tail.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const selectedLines: string[] = allLines.slice(-requestedLines);

	return {
		ok: true,
		fileName: selectedLog.fileName,
		absolutePath,
		logPath: config.logPath,
		lines: selectedLines,
		lineCount: selectedLines.length,
		requestedLines,
		bytesRead: tail.bytesRead,
		truncatedBytes: tail.truncatedBytes,
		config,
		resolutionNote: config.resolutionNote
	};
}

function splitProjectSettingKey(fullKey: string): { section: string; name: string } {
	const trimmedKey: string = fullKey.trim();
	const separatorIndex: number = trimmedKey.indexOf("/");
	if (
		trimmedKey.length === 0
		|| separatorIndex <= 0
		|| separatorIndex === trimmedKey.length - 1
		|| trimmedKey.includes("\n")
		|| trimmedKey.includes("\r")
		|| /[\[\]=]/.test(trimmedKey)
		|| !/^[A-Za-z0-9_./-]+$/.test(trimmedKey)
	) {
		throw new Error(`Invalid project setting key: ${fullKey}`);
	}

	return {
		section: trimmedKey.slice(0, separatorIndex),
		name: trimmedKey.slice(separatorIndex + 1)
	};
}

function normalizeProjectSettingValueExpression(valueExpression: string): string {
	const normalizedValue: string = normalizeConfigContent(valueExpression).trimEnd();
	const valueLines: string[] = normalizedValue.split("\n");

	if (normalizedValue.trim().length === 0) {
		throw new Error("valueExpression must not be empty");
	}

	if (normalizedValue.length > MAX_PROJECT_SETTING_VALUE_CHARS) {
		throw new Error(`valueExpression too large: ${normalizedValue.length} chars (max ${MAX_PROJECT_SETTING_VALUE_CHARS})`);
	}

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

function createProjectSettingAssignmentLines(name: string, valueExpression: string): string[] {
	const valueLines: string[] = valueExpression.split("\n");
	return [`${name}=${valueLines[0] ?? ""}`, ...valueLines.slice(1)];
}

function findProjectSettingEntry(document: ProjectSettingsDocument, fullKey: string): ProjectSettingEntry | undefined {
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

function finalizeProjectConfigContent(lines: string[]): string {
	return `${lines.join("\n").replace(/\n*$/g, "")}\n`;
}

function applyProjectSettingSetToContent(
	document: ProjectSettingsDocument,
	fullKey: string,
	valueExpression: string
): {
	content: string;
	action: "add" | "update";
	oldValueExpression: string | null;
	lineStart: number | null;
	lineEnd: number | null;
} {
	const { section, name } = splitProjectSettingKey(fullKey);
	const normalizedValue: string = normalizeProjectSettingValueExpression(valueExpression);
	const assignmentLines: string[] = createProjectSettingAssignmentLines(name, normalizedValue);
	const lines: string[] = [...document.lines];
	const existingEntry: ProjectSettingEntry | undefined = findProjectSettingEntry(document, fullKey);

	if (existingEntry !== undefined) {
		lines.splice(existingEntry.lineStart, existingEntry.lineEnd - existingEntry.lineStart + 1, ...assignmentLines);
		return {
			content: finalizeProjectConfigContent(lines),
			action: "update",
			oldValueExpression: existingEntry.valueExpression,
			lineStart: existingEntry.lineStart + 1,
			lineEnd: existingEntry.lineEnd + 1
		};
	}

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

function applyProjectSettingUnsetToContent(
	document: ProjectSettingsDocument,
	fullKey: string
): {
	content: string;
	action: "remove" | "noop";
	oldValueExpression: string | null;
	lineStart: number | null;
	lineEnd: number | null;
} {
	splitProjectSettingKey(fullKey);
	const lines: string[] = [...document.lines];
	const existingEntry: ProjectSettingEntry | undefined = findProjectSettingEntry(document, fullKey);

	if (existingEntry === undefined) {
		return {
			content: document.content,
			action: "noop",
			oldValueExpression: null,
			lineStart: null,
			lineEnd: null
		};
	}

	lines.splice(existingEntry.lineStart, existingEntry.lineEnd - existingEntry.lineStart + 1);
	return {
		content: finalizeProjectConfigContent(lines),
		action: "remove",
		oldValueExpression: existingEntry.valueExpression,
		lineStart: existingEntry.lineStart + 1,
		lineEnd: existingEntry.lineEnd + 1
	};
}

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

function asTextResult(text: string): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [{ type: "text", text }]
	};
}

function asJsonTextResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return asTextResult(JSON.stringify(value, null, 2));
}

const PROHIBITED_PREFIXES: string[] = [".godot", "addons"];

type TscnSection = {
	name: string;
	attrs: Record<string, string>;
};

type TscnExtResource = {
	id: string;
	type: string;
	path: string | undefined;
	uid: string | undefined;
};

type TscnSubResource = {
	id: string;
	type: string;
	properties: Record<string, string>;
};

type TscnNode = {
	name: string;
	type: string;
	parent: string | null;
	properties: Record<string, string>;
	script: string | null;
	instance: string | null;
};

type TscnConnection = {
	signal: string;
	from: string;
	to: string;
	method: string;
	flags: number | null;
	binds: string | null;
};

type TscnData = {
	format: number;
	loadSteps: number;
	uid: string | null;
	extResources: TscnExtResource[];
	subResources: TscnSubResource[];
	nodes: TscnNode[];
	connections: TscnConnection[];
};

type ScenePatchOperation =
	| {
		type: "add_node";
		parentPath: string;
		nodeType: string;
		nodeName: string;
		properties?: Record<string, string>;
	}
	| {
		type: "attach_script";
		nodePath: string;
		scriptPath: string;
	}
	| {
		type: "connect_signal";
		signal: string;
		fromNode: string;
		toNode: string;
		method: string;
		flags?: number;
		binds?: string;
	};

function parseSectionHeader(line: string): TscnSection | null {
	const match = line.match(/^\[([^\]]+)\](.*)$/);
	if (match === null) return null;
	const sectionContent: string = match[1]!.trim();
	const firstWhitespaceIndex: number = sectionContent.search(/\s/);
	const name: string = firstWhitespaceIndex === -1
		? sectionContent
		: sectionContent.slice(0, firstWhitespaceIndex);
	const attrs: Record<string, string> = {};
	const attrStr: string = firstWhitespaceIndex === -1
		? match[2]!.trim()
		: sectionContent.slice(firstWhitespaceIndex + 1).trim();
	if (attrStr.length > 0) {
		const attrRegex = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;
		let attrMatch;
		while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
			let value = attrMatch[2]!;
			if (value.startsWith('"') && value.endsWith('"')) {
				value = value.slice(1, -1);
			}
			attrs[attrMatch[1]!] = value;
		}
	}
	return { name, attrs };
}

function parseTscn(content: string): TscnData {
	const lines = content.split("\n");
	const data: TscnData = {
		format: 0,
		loadSteps: 0,
		uid: null,
		extResources: [],
		subResources: [],
		nodes: [],
		connections: []
	};

	let currentSection: string | null = null;
	let currentSubResourceProps: Record<string, string> = {};
	let currentSubResourceId = "";
	let currentSubResourceType = "";

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (line.length === 0 || line.startsWith(";")) continue;

		const section = parseSectionHeader(line);
		if (section !== null) {
			// Flush any pending sub-resource
			if (currentSection === "sub_resource" && currentSubResourceId.length > 0) {
				data.subResources.push({
					id: currentSubResourceId,
					type: currentSubResourceType,
					properties: { ...currentSubResourceProps }
				});
				currentSubResourceProps = {};
				currentSubResourceId = "";
				currentSubResourceType = "";
			}

			currentSection = section.name;

			if (section.name === "gd_scene") {
				data.format = parseInt(section.attrs["format"] ?? "0", 10);
				data.loadSteps = parseInt(section.attrs["load_steps"] ?? "0", 10);
				data.uid = section.attrs["uid"] ?? null;
			} else if (section.name === "ext_resource") {
				data.extResources.push({
					id: section.attrs["id"] ?? "",
					type: section.attrs["type"] ?? "",
					path: section.attrs["path"],
					uid: section.attrs["uid"]
				});
			} else if (section.name === "sub_resource") {
				currentSubResourceId = section.attrs["id"] ?? "";
				currentSubResourceType = section.attrs["type"] ?? "";
				currentSubResourceProps = {};
			} else if (section.name === "node") {
				data.nodes.push({
					name: section.attrs["name"] ?? "",
					type: section.attrs["type"] ?? "",
					parent: section.attrs["parent"] ?? null,
					properties: {},
					script: null,
					instance: section.attrs["instance"] ?? null
				});
			} else if (section.name === "connection") {
				data.connections.push({
					signal: section.attrs["signal"] ?? "",
					from: section.attrs["from"] ?? "",
					to: section.attrs["to"] ?? "",
					method: section.attrs["method"] ?? "",
					flags: section.attrs["flags"] !== undefined ? parseInt(section.attrs["flags"], 10) : null,
					binds: section.attrs["binds"] ?? null
				});
			}
			continue;
		}

		// Property line
		const eqIdx = line.indexOf("=");
		if (eqIdx === -1) continue;

		const key = line.slice(0, eqIdx).trim();
		const value = line.slice(eqIdx + 1).trim();

		if (currentSection === "node" && data.nodes.length > 0) {
			const lastNode = data.nodes[data.nodes.length - 1]!;
			if (key === "script" && value.startsWith('ExtResource(')) {
				lastNode.script = value;
			} else {
				lastNode.properties[key] = value;
			}
		} else if (currentSection === "sub_resource") {
			currentSubResourceProps[key] = value;
		}
	}

	// Flush final sub-resource
	if (currentSection === "sub_resource" && currentSubResourceId.length > 0) {
		data.subResources.push({
			id: currentSubResourceId,
			type: currentSubResourceType,
			properties: { ...currentSubResourceProps }
		});
	}

	return data;
}

function quoteTscnString(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("\"", "\\\"");
}

function createNodePathMap(nodes: TscnNode[]): Map<string, TscnNode> {
	const pathMap: Map<string, TscnNode> = new Map();
	const rootNode: TscnNode | undefined = nodes.find((node: TscnNode): boolean => node.parent === null);
	const rootName: string | undefined = rootNode?.name;

	if (rootNode !== undefined) {
		pathMap.set(".", rootNode);
		pathMap.set(rootNode.name, rootNode);
	}

	for (const node of nodes) {
		if (node.parent === null) {
			continue;
		}

		const parentPath: string = node.parent === "." ? (rootName ?? ".") : node.parent;
		const fullPath: string = parentPath.length > 0 ? `${parentPath}/${node.name}` : node.name;
		pathMap.set(fullPath, node);

		if (node.parent === ".") {
			pathMap.set(node.name, node);
		}

		if (rootName !== undefined && !fullPath.startsWith(`${rootName}/`) && fullPath !== rootName) {
			pathMap.set(`${rootName}/${fullPath}`, node);
		}
	}

	return pathMap;
}

function toSceneRelativeNodePath(data: TscnData, nodePath: string): string {
	const normalizedPath: string = nodePath.trim().replace(/^\//, "");
	const rootNode: TscnNode | undefined = data.nodes.find((node: TscnNode): boolean => node.parent === null);
	const rootName: string | undefined = rootNode?.name;

	if (normalizedPath.length === 0 || normalizedPath === ".") {
		return ".";
	}

	if (rootName !== undefined) {
		if (normalizedPath === rootName) {
			return ".";
		}

		if (normalizedPath.startsWith(`${rootName}/`)) {
			return normalizedPath.slice(rootName.length + 1);
		}
	}

	return normalizedPath;
}

function getNodeSectionIndex(lines: string[], targetNode: TscnNode): number {
	for (let index: number = 0; index < lines.length; index += 1) {
		const section: TscnSection | null = parseSectionHeader(lines[index]!);
		if (section === null || section.name !== "node") {
			continue;
		}

		const name: string = section.attrs["name"] ?? "";
		const type: string = section.attrs["type"] ?? "";
		const parent: string | null = section.attrs["parent"] ?? null;

		if (name === targetNode.name && type === targetNode.type && parent === targetNode.parent) {
			return index;
		}
	}

	return -1;
}

function getNextSectionIndex(lines: string[], startIndex: number): number {
	let index: number = startIndex + 1;
	while (index < lines.length) {
		const line: string = lines[index]!.trim();
		if (line.startsWith("[")) {
			break;
		}
		index += 1;
	}

	return index;
}

function generateSceneTscn(rootNodeType: string, rootNodeName: string): string {
	return `[gd_scene load_steps=2 format=3]

[node name="${quoteTscnString(rootNodeName)}" type="${quoteTscnString(rootNodeType)}"]
`;
}

function findNodeInTscn(data: TscnData, targetPath: string): TscnNode | null {
	const normalizedTargetPath: string = targetPath.trim().replace(/^\//, "");
	if (normalizedTargetPath.length === 0 || normalizedTargetPath === ".") {
		return data.nodes.find(n => n.parent === null) ?? null;
	}

	return createNodePathMap(data.nodes).get(normalizedTargetPath) ?? null;
}

function getNodeFullPath(node: TscnNode, allNodes: TscnNode[]): string {
	if (node.parent === null || node.parent === ".") return node.name;

	// Find parent
	const parent = allNodes.find(n => {
		const parentPath = n.parent === "." || n.parent === null ? "" : n.parent;
		const nodePath = parentPath.length > 0 ? `${parentPath}/${n.name}` : n.name;
		return nodePath === node.parent;
	});

	if (parent === undefined) return node.name;
	return `${getNodeFullPath(parent, allNodes)}/${node.name}`;
}

function addNodeToSceneTscn(content: string, parentPath: string, nodeType: string, nodeName: string, properties: Record<string, string>): string {
	const data: TscnData = parseTscn(content);
	const parentNode: TscnNode | null = findNodeInTscn(data, parentPath);

	if (parentNode === null) {
		throw new Error(`Parent node not found in scene: ${parentPath}`);
	}

	const resolvedParent: string = toSceneRelativeNodePath(data, parentPath);
	const rootNode: TscnNode | undefined = data.nodes.find((node: TscnNode): boolean => node.parent === null);
	const candidateScenePath: string = resolvedParent === "." ? nodeName : `${resolvedParent}/${nodeName}`;
	const candidateFullPath: string = rootNode === undefined ? candidateScenePath : `${rootNode.name}/${candidateScenePath}`;
	const nodePathMap: Map<string, TscnNode> = createNodePathMap(data.nodes);

	if (nodePathMap.has(candidateScenePath) || nodePathMap.has(candidateFullPath)) {
		throw new Error(`Node already exists in scene: ${candidateScenePath}`);
	}

	let nodeLine = `[node name="${quoteTscnString(nodeName)}" type="${quoteTscnString(nodeType)}" parent="${quoteTscnString(resolvedParent)}"]`;
	if (Object.keys(properties).length > 0) {
		for (const [key, value] of Object.entries(properties)) {
			nodeLine += `\n${key} = ${value}`;
		}
	}
	nodeLine += "\n";

	// Insert before the last section (connections or end of file)
	const lines = content.split("\n");
	const insertIdx = findLastNodeInsertIndex(lines);
	lines.splice(insertIdx, 0, nodeLine);
	return lines.join("\n");
}

function findLastNodeInsertIndex(lines: string[]): number {
	// Find where to insert a new node: after the last [node ...] section's properties
	let lastNodeLine = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith("[node ")) {
			lastNodeLine = i;
		}
	}

	if (lastNodeLine === -1) {
		// No nodes yet, find where [gd_scene] header ends
		for (let i = 0; i < lines.length; i++) {
			if (lines[i]!.startsWith("[gd_scene ")) {
				// Find next non-empty, non-property line after header
				let j = i + 1;
				while (j < lines.length && lines[j]!.trim().length === 0) j++;
				return j;
			}
		}
		return lines.length;
	}

	// Skip the [node ...] line and its properties
	let i = lastNodeLine + 1;
	while (i < lines.length) {
		const line = lines[i]!.trim();
		if (line.length === 0 || line.startsWith(";")) {
			i++;
			continue;
		}
		if (line.startsWith("[")) break;
		i++;
	}
	return i;
}

function attachScriptToSceneTscn(content: string, nodePath: string, scriptPath: string): string {
	const data = parseTscn(content);
	const targetNode = findNodeInTscn(data, nodePath);

	if (targetNode === null) {
		throw new Error(`Node not found in scene: ${nodePath}`);
	}

	const extResMatch = scriptPath.match(/^ExtResource\("([^"]+)"\)$/);
	const lines = content.split("\n");
	const nodeSectionIndex: number = getNodeSectionIndex(lines, targetNode);

	if (nodeSectionIndex === -1) {
		throw new Error(`Node section not found in scene: ${nodePath}`);
	}

	const nodeSectionEndIndex: number = getNextSectionIndex(lines, nodeSectionIndex);
	for (let index: number = nodeSectionIndex + 1; index < nodeSectionEndIndex; index += 1) {
		if (lines[index]!.trim().startsWith("script =")) {
			throw new Error(`Node already has a script: ${nodePath}`);
		}
	}

	let scriptValue: string;
	if (extResMatch !== null) {
		scriptValue = scriptPath;
	} else {
		if (!scriptPath.startsWith("res://") || !scriptPath.endsWith(".gd")) {
			throw new Error("scriptPath must be a res:// path ending with .gd or an ExtResource(\"id\") reference");
		}

		const existingResource: TscnExtResource | undefined = data.extResources.find(
			(resource: TscnExtResource): boolean => resource.path === scriptPath
		);
		let resourceId: string;

		if (existingResource !== undefined) {
			resourceId = existingResource.id;
		} else {
			const usedIds: Set<string> = new Set(data.extResources.map((resource: TscnExtResource): string => resource.id));
			let nextIndex: number = data.extResources.length + 1;
			do {
				resourceId = `${nextIndex}_script`;
				nextIndex += 1;
			} while (usedIds.has(resourceId));

			const gdSceneIndex: number = lines.findIndex((line: string): boolean => line.startsWith("[gd_scene "));
			if (gdSceneIndex === -1) {
				throw new Error("Missing [gd_scene ...] header");
			}

			lines[gdSceneIndex] = lines[gdSceneIndex]!.replace(
				/load_steps=(\d+)/,
				(_match: string, value: string): string => `load_steps=${Number.parseInt(value, 10) + 1}`
			);
			lines.splice(gdSceneIndex + 1, 0, `[ext_resource type="Script" path="${quoteTscnString(scriptPath)}" id="${resourceId}"]`);
		}

		scriptValue = `ExtResource("${resourceId}")`;
	}

	const refreshedData: TscnData = parseTscn(lines.join("\n"));
	const refreshedNode: TscnNode | null = findNodeInTscn(refreshedData, nodePath);
	if (refreshedNode === null) {
		throw new Error(`Node not found after script resource update: ${nodePath}`);
	}

	const refreshedNodeSectionIndex: number = getNodeSectionIndex(lines, refreshedNode);
	lines.splice(refreshedNodeSectionIndex + 1, 0, `script = ${scriptValue}`);
	return lines.join("\n");
}

function connectSignalInSceneTscn(content: string, signal: string, fromNode: string, toNode: string, method: string, flags?: number, binds?: string): string {
	const data: TscnData = parseTscn(content);

	if (findNodeInTscn(data, fromNode) === null) {
		throw new Error(`Signal source node not found in scene: ${fromNode}`);
	}

	if (findNodeInTscn(data, toNode) === null) {
		throw new Error(`Signal target node not found in scene: ${toNode}`);
	}

	const resolvedFromNode: string = toSceneRelativeNodePath(data, fromNode);
	const resolvedToNode: string = toSceneRelativeNodePath(data, toNode);
	const connExists: boolean = data.connections.some(
		(connection: TscnConnection): boolean =>
			connection.signal === signal
			&& toSceneRelativeNodePath(data, connection.from) === resolvedFromNode
			&& toSceneRelativeNodePath(data, connection.to) === resolvedToNode
			&& connection.method === method
	);

	if (connExists) {
		throw new Error("This signal connection already exists in the scene");
	}

	let connLine = `[connection signal="${quoteTscnString(signal)}" from="${quoteTscnString(resolvedFromNode)}" to="${quoteTscnString(resolvedToNode)}" method="${quoteTscnString(method)}"`;
	if (flags !== undefined) {
		connLine += ` flags=${flags}`;
	}
	if (binds !== undefined && binds.length > 0) {
		connLine += ` binds= ${binds}`;
	}
	connLine += "]\n";

	// Find the last [connection ...] line or the end
	const lines = content.split("\n");
	let lastConnIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith("[connection ")) {
			lastConnIdx = i;
		}
	}

	if (lastConnIdx >= 0) {
		lines.splice(lastConnIdx + 1, 0, connLine);
	} else {
		lines.push(connLine);
	}

	return lines.join("\n").replace(/\n\n+$/, "\n");
}

function applyScenePatchToTscn(content: string, operations: ScenePatchOperation[]): {
	content: string;
	applied: Array<Record<string, unknown>>;
} {
	let nextContent: string = content;
	const applied: Array<Record<string, unknown>> = [];

	for (const operation of operations) {
		if (operation.type === "add_node") {
			nextContent = addNodeToSceneTscn(
				nextContent,
				operation.parentPath,
				operation.nodeType,
				operation.nodeName,
				operation.properties ?? {}
			);
			applied.push({
				type: operation.type,
				parentPath: operation.parentPath,
				nodeType: operation.nodeType,
				nodeName: operation.nodeName
			});
		} else if (operation.type === "attach_script") {
			nextContent = attachScriptToSceneTscn(nextContent, operation.nodePath, operation.scriptPath);
			applied.push({
				type: operation.type,
				nodePath: operation.nodePath,
				scriptPath: operation.scriptPath
			});
		} else if (operation.type === "connect_signal") {
			nextContent = connectSignalInSceneTscn(
				nextContent,
				operation.signal,
				operation.fromNode,
				operation.toNode,
				operation.method,
				operation.flags,
				operation.binds
			);
			applied.push({
				type: operation.type,
				signal: operation.signal,
				fromNode: operation.fromNode,
				toNode: operation.toNode,
				method: operation.method
			});
		} else {
			const unreachable: never = operation;
			throw new Error(`Unsupported scene patch operation: ${JSON.stringify(unreachable)}`);
		}
	}

	return { content: nextContent, applied };
}

async function assertWritablePath(relativePath: string): Promise<string> {
	const cleanedPath: string = relativePath.trim().replaceAll("\\", "/");
	const resolvedPath: string = await resolveProjectPath(cleanedPath);
	const normalized: string = path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/");

	const segments: string[] = normalized.split("/");

	for (const segment of segments) {
		if (segment.startsWith(".") && segment !== "..") {
			throw new Error(`Path contains hidden directory: ${segment}`);
		}
	}

	for (const prefix of PROHIBITED_PREFIXES) {
		if (normalized.startsWith(prefix + "/") || normalized === prefix) {
			throw new Error(`Writing to ${prefix}/ is not allowed`);
		}
	}

	const extension: string = path.extname(resolvedPath);
	if (!WRITABLE_EXTENSIONS.has(extension)) {
		throw new Error(`Unsupported writable extension: ${extension || "(none)"}. Allowed: ${Array.from(WRITABLE_EXTENSIONS).join(", ")}`);
	}

	return resolvedPath;
}

function validateTscnContent(content: string): string[] {
	const errors: string[] = [];
	const trimmedContent: string = content.trimStart();

	if (!/^\[gd_scene\s/.test(trimmedContent)) {
		errors.push("TSCN file must start with [gd_scene ...] header");
	}

	const nodeMatches: RegExpMatchArray | null = trimmedContent.match(/^\[node\s/gm);
	if (nodeMatches === null || nodeMatches.length === 0) {
		errors.push("TSCN file must contain at least one [node ...] section (root node)");
	}

	return errors;
}

async function validateNewTextFile(relativePath: string, content: string): Promise<{
	valid: boolean;
	resolvedPath?: string;
	normalizedPath: string;
	errors: string[];
}> {
	const errors: string[] = [];
	let resolvedPath: string;

	if (content.length === 0) {
		errors.push("File content is empty");
	}

	if (relativePath.endsWith(".tscn")) {
		if (content.length > MAX_TSCN_FILE_BYTES) {
			errors.push(`Content too large: ${content.length} bytes (max ${MAX_TSCN_FILE_BYTES})`);
		}
	} else if (content.length > MAX_NEW_FILE_BYTES) {
		errors.push(`Content too large: ${content.length} bytes (max ${MAX_NEW_FILE_BYTES})`);
	}

	if (relativePath.endsWith(".tscn") && content.length > 0) {
		errors.push(...validateTscnContent(content));
	}

	try {
		resolvedPath = await assertWritablePath(relativePath);
	} catch (error: unknown) {
		return {
			valid: false,
			normalizedPath: relativePath,
			errors: [error instanceof Error ? error.message : "Path validation failed"]
		};
	}

	const normalizedPath: string = path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/");

	try {
		await fs.access(resolvedPath);
		errors.push(`File already exists: ${normalizedPath}`);
	} catch {
		// File does not exist — this is required for create.
	}

	return {
		valid: errors.length === 0,
		resolvedPath,
		normalizedPath,
		errors
	};
}

async function createTextFile(relativePath: string, content: string): Promise<{
	created: true;
	path: string;
	size: number;
}> {
	const validation = await validateNewTextFile(relativePath, content);

	if (!validation.valid || validation.resolvedPath === undefined) {
		throw new Error(validation.errors.join("; "));
	}

	await fs.mkdir(path.dirname(validation.resolvedPath), { recursive: true });
	await fs.writeFile(validation.resolvedPath, content, "utf8");

	return {
		created: true,
		path: validation.normalizedPath,
		size: content.length
	};
}

async function overwriteTextFile(relativePath: string, content: string): Promise<{
	overwritten: true;
	path: string;
	size: number;
	oldSize: number;
}> {
	if (content.length === 0) {
		throw new Error("File content is empty");
	}

	const maxBytes: number = relativePath.endsWith(".tscn") ? MAX_TSCN_FILE_BYTES : MAX_TEXT_FILE_BYTES;
	if (content.length > maxBytes) {
		throw new Error(`Content too large: ${content.length} bytes (max ${maxBytes})`);
	}

	if (relativePath.endsWith(".tscn")) {
		const tscnErrors: string[] = validateTscnContent(content);
		if (tscnErrors.length > 0) {
			throw new Error(`TSCN validation failed: ${tscnErrors.join("; ")}`);
		}
	}

	const resolvedPath: string = await assertWritablePath(relativePath);
	const oldContent: string = await fs.readFile(resolvedPath, "utf8");
	await fs.writeFile(resolvedPath, content, "utf8");

	return {
		overwritten: true,
		path: path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/"),
		size: content.length,
		oldSize: oldContent.length
	};
}

async function replaceTextInFile(relativePath: string, oldText: string, newText: string): Promise<{
	replaced: true;
	path: string;
	occurrences: number;
	size: number;
	oldSize: number;
}> {
	if (oldText.length === 0) {
		throw new Error("oldText must not be empty");
	}

	const resolvedPath: string = await assertWritablePath(relativePath);
	const oldContent: string = await fs.readFile(resolvedPath, "utf8");

	if (!oldContent.includes(oldText)) {
		throw new Error("oldText was not found in file");
	}

	const occurrenceCount: number = oldContent.split(oldText).length - 1;
	const newContent: string = oldContent.replace(oldText, newText);

	if (newContent.length > MAX_TEXT_FILE_BYTES) {
		throw new Error(`Content too large after replacement: ${newContent.length} bytes (max ${MAX_TEXT_FILE_BYTES})`);
	}

	await fs.writeFile(resolvedPath, newContent, "utf8");

	return {
		replaced: true,
		path: path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/"),
		occurrences: occurrenceCount,
		size: newContent.length,
		oldSize: oldContent.length
	};
}

async function main(): Promise<void> {
	await assertProjectExists();

	const server: McpServer = new McpServer({
		name: "godot-project-server",
		version: "1.0.0"
	});

	server.registerTool(
		"get_project_summary",
		{
			title: "Get Godot Project Summary",
			description: "返回当前 Godot 项目的名称、主场景、插件列表和文件数量",
			inputSchema: z.object({})
		},
		async () => asJsonTextResult(await getProjectSummary())
	);

	server.registerTool(
		"list_project_files",
		{
			title: "List Godot Project Files",
			description: "递归列出 Godot 项目文件，可按子目录和扩展名过滤",
			inputSchema: z.object({
				subdir: z.string().optional().describe("相对于项目根目录的子目录"),
				extensions: z.array(z.string()).optional().describe("扩展名过滤，例如 ['.gd', '.tscn']"),
				includeAddons: z.boolean().optional().describe("是否包含 addons 目录")
			})
		},
		async ({ subdir, extensions, includeAddons }) => {
			const files: string[] = await walkProjectFiles({ subdir, extensions, includeAddons });
			return asJsonTextResult({ files });
		}
	);

	server.registerTool(
		"list_scenes",
		{
			title: "List Godot Scenes",
			description: "列出 Godot 项目中所有 .tscn 场景文件",
			inputSchema: z.object({
				includeAddons: z.boolean().optional().describe("是否包含 addons 目录")
			})
		},
		async ({ includeAddons }) => {
			const scenes: string[] = await walkProjectFiles({ extensions: [".tscn"], includeAddons });
			return asJsonTextResult({ scenes });
		}
	);

	server.registerTool(
		"list_scripts",
		{
			title: "List GDScript Files",
			description: "列出 Godot 项目中所有 .gd 脚本文件",
			inputSchema: z.object({
				includeAddons: z.boolean().optional().describe("是否包含 addons 目录")
			})
		},
		async ({ includeAddons }) => {
			const scripts: string[] = await walkProjectFiles({ extensions: [".gd"], includeAddons });
			return asJsonTextResult({ scripts });
		}
	);

	server.registerTool(
		"read_text_file",
		{
			title: "Read Text File",
			description: "读取 Godot 项目中的文本文件，带路径越界和大小限制",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的文件路径")
			})
		},
		async ({ relativePath }) => asTextResult(await readTextFile(relativePath))
	);

	server.registerTool(
		"search_text",
		{
			title: "Search Text",
			description: "在项目文本文件中搜索关键词，返回匹配文件和行号",
			inputSchema: z.object({
				query: z.string().min(1).describe("要搜索的文本"),
				extensions: z.array(z.string()).optional().describe("扩展名过滤，例如 ['.gd']"),
				limit: z.number().int().positive().max(200).optional().describe("最多返回多少条匹配")
			})
		},
		async ({ query, extensions, limit }) => {
			const maxMatches: number = limit ?? 50;
			const files: string[] = await walkProjectFiles({
				extensions: extensions ?? Array.from(TEXT_EXTENSIONS)
			});
			const matches: Array<{ file: string; line: number; text: string }> = [];

			for (const file of files) {
				if (matches.length >= maxMatches) {
					break;
				}

				let content: string;
				try {
					content = await readTextFile(file);
				} catch {
					continue;
				}

				const lines: string[] = content.split("\n");
				for (let index: number = 0; index < lines.length; index += 1) {
					const lineText: string | undefined = lines[index];
					if (lineText === undefined || !lineText.includes(query)) {
						continue;
					}

					matches.push({
						file,
						line: index + 1,
						text: lineText.trim()
					});

					if (matches.length >= maxMatches) {
						break;
					}
				}
			}

			return asJsonTextResult({ matches });
		}
	);

	server.registerTool(
		"get_project_log_config",
		{
			title: "Get Godot Project Log Config",
			description: "读取 Godot 项目日志配置，解析 debug/file_logging/log_path。缺省为 user://logs/godot.log，并返回 user:// 对应的真实系统路径。",
			inputSchema: z.object({})
		},
		async () => asJsonTextResult(await getProjectLogConfig())
	);

	server.registerTool(
		"list_project_logs",
		{
			title: "List Godot Project Logs",
			description: "列出当前 Godot 项目日志目录中的 godot.log 和轮转日志。遇到 user:// 路径时会先按 Godot 规则解析到真实系统路径。",
			inputSchema: z.object({})
		},
		async () => asJsonTextResult(await listProjectLogFiles())
	);

	server.registerTool(
		"read_project_log",
		{
			title: "Read Godot Project Log",
			description: "读取当前 Godot 项目日志尾部。默认读取 godot.log；如果不存在则读取最新轮转日志。只允许读取日志目录内的 .log 文件。",
			inputSchema: z.object({
				fileName: z.string().optional().describe("可选，来自 list_project_logs 的纯文件名，例如 godot.log"),
				lines: z.number().int().positive().max(MAX_PROJECT_LOG_LINES).optional().describe(`读取尾部行数，默认 ${DEFAULT_PROJECT_LOG_LINES}，最多 ${MAX_PROJECT_LOG_LINES}`)
			})
		},
		async ({ fileName, lines }) => asJsonTextResult(await readProjectLog(fileName, lines))
	);

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

	server.registerTool(
		"propose_create_text_file",
		{
			title: "Propose Create Text File",
			description: "提出新建一个文本文件的提案。不会实际写入磁盘，仅返回校验结果和预览。支持 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。不允许覆盖已有文件，不允许写入 .godot/ 或 addons/ 目录。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的新文件路径"),
				content: z.string().describe("文件内容")
			})
		},
		async ({ relativePath, content }) => {
			const validation = await validateNewTextFile(relativePath, content);

			if (!validation.valid) {
				return asJsonTextResult({
					valid: false,
					path: validation.normalizedPath,
					errors: validation.errors
				});
			}

			const previewLength: number = Math.min(content.length, 500);
			const preview: string = content.slice(0, previewLength) + (content.length > previewLength ? "\n..." : "");

			return asJsonTextResult({
				valid: true,
				path: validation.normalizedPath,
				size: content.length,
				preview
			});
		}
	);

	server.registerTool(
		"create_text_file",
		{
			title: "Create Text File",
			description: "创建一个新的文本文件，会实际写入磁盘。支持 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。不允许覆盖已有文件，不允许写入 .godot/ 或 addons/ 目录。写入后建议运行 godot.check_only 验证。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的新文件路径"),
				content: z.string().describe("文件内容")
			})
		},
		async ({ relativePath, content }) => asJsonTextResult(await createTextFile(relativePath, content))
	);

	server.registerTool(
		"propose_overwrite_text_file",
		{
			title: "Propose Overwrite Text File",
			description: "提出覆盖已有文件的提案。不会实际写入，仅校验并返回新旧内容对比。支持 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。文件必须已存在，不允许写入 .godot/。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的已有文件路径"),
				content: z.string().describe("新的完整文件内容")
			})
		},
		async ({ relativePath, content }) => {
			const errors: string[] = [];
			let resolvedPath: string;

			try {
				resolvedPath = await assertWritablePath(relativePath);
			} catch (error: unknown) {
				return asJsonTextResult({
					valid: false,
					path: relativePath,
					errors: [error instanceof Error ? error.message : "Path validation failed"]
				});
			}

			if (content.length === 0) {
				errors.push("File content is empty");
			}

			const overwriteMaxBytes: number = relativePath.endsWith(".tscn") ? MAX_TSCN_FILE_BYTES : MAX_TEXT_FILE_BYTES;
			if (content.length > overwriteMaxBytes) {
				errors.push(`Content too large: ${content.length} bytes (max ${overwriteMaxBytes})`);
			}

			if (relativePath.endsWith(".tscn") && content.length > 0) {
				errors.push(...validateTscnContent(content));
			}
			let oldContent: string;
			try {
				oldContent = await fs.readFile(resolvedPath, "utf8");
			} catch {
				errors.push(`File does not exist: ${relativePath}`);
				return asJsonTextResult({ valid: false, path: relativePath, errors });
			}

			if (errors.length > 0) {
				return asJsonTextResult({ valid: false, path: relativePath, errors });
			}

			const previewLength: number = Math.min(content.length, 500);
			const normalizedPath: string = path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/");

			return asJsonTextResult({
				valid: true,
				path: normalizedPath,
				size: content.length,
				oldSize: oldContent.length,
				preview: content.slice(0, previewLength) + (content.length > previewLength ? "\n..." : "")
			});
		}
	);

	server.registerTool(
		"overwrite_text_file",
		{
			title: "Overwrite Text File",
			description: "覆盖已有文本文件，会实际写入磁盘。支持 .gd/.tres/.tscn/.json/.md/.txt 文件。.tscn 文件必须包含 [gd_scene ...] 头部和至少一个 [node ...] 根节点。不允许写入 .godot/、addons/ 或隐藏目录。写入后建议运行 godot.check_only 验证。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的已有文件路径"),
				content: z.string().describe("新的完整文件内容")
			})
		},
		async ({ relativePath, content }) => asJsonTextResult(await overwriteTextFile(relativePath, content))
	);

	server.registerTool(
		"propose_replace_text_in_file",
		{
			title: "Propose Replace Text In File",
			description: "提出替换文件中指定文本的提案。不会实际写入，仅校验并返回 diff 预览。文件必须已存在。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的已有文件路径"),
				oldText: z.string().min(1).describe("要被替换的原文本（必须精确匹配）"),
				newText: z.string().describe("替换后的新文本")
			})
		},
		async ({ relativePath, oldText, newText }) => {
			const errors: string[] = [];
			let resolvedPath: string;

			try {
				resolvedPath = await assertWritablePath(relativePath);
			} catch (error: unknown) {
				return asJsonTextResult({
					valid: false,
					path: relativePath,
					errors: [error instanceof Error ? error.message : "Path validation failed"]
				});
			}

			let oldContent: string;
			try {
				oldContent = await fs.readFile(resolvedPath, "utf8");
			} catch {
				errors.push(`File does not exist: ${relativePath}`);
				return asJsonTextResult({ valid: false, path: relativePath, errors });
			}

			if (!oldContent.includes(oldText)) {
				errors.push("oldText not found in file. Ensure exact match including whitespace and indentation.");
				return asJsonTextResult({ valid: false, path: relativePath, errors });
			}

			const newContent: string = oldContent.replace(oldText, newText);
			const occurrenceCount: number = oldContent.split(oldText).length - 1;
			const normalizedPath: string = path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/");

			return asJsonTextResult({
				valid: true,
				path: normalizedPath,
				occurrences: occurrenceCount,
				oldLength: oldContent.length,
				newLength: newContent.length,
				preview: newContent.slice(0, 500) + (newContent.length > 500 ? "\n..." : "")
			});
		}
	);

	server.registerTool(
		"replace_text_in_file",
		{
			title: "Replace Text In File",
			description: "替换已有文件中首次出现的指定文本，会实际写入磁盘。oldText 必须精确匹配。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的已有文件路径"),
				oldText: z.string().min(1).describe("要被替换的原文本（必须精确匹配）"),
				newText: z.string().describe("替换后的新文本")
			})
		},
		async ({ relativePath, oldText, newText }) => asJsonTextResult(await replaceTextInFile(relativePath, oldText, newText))
	);

	server.registerTool(
		"delete_file",
		{
			title: "Delete File",
			description: "删除项目中的文件。文件必须存在，不允许删除 .godot/ 中的文件。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("相对于项目根目录的已有文件路径")
			})
		},
		async ({ relativePath }) => {
			const errors: string[] = [];
			let resolvedPath: string;

			try {
				resolvedPath = await assertWritablePath(relativePath);
			} catch (error: unknown) {
				return asJsonTextResult({
					valid: false,
					path: relativePath,
					errors: [error instanceof Error ? error.message : "Path validation failed"]
				});
			}

			const normalizedPath: string = path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/");

			if (normalizedPath.startsWith(".godot/") || normalizedPath === ".godot") {
				return asJsonTextResult({
					valid: false,
					path: normalizedPath,
					errors: ["Cannot delete files in .godot/"]
				});
			}

			try {
				const stat = await fs.stat(resolvedPath);
				if (!stat.isFile()) {
					errors.push(`Not a file: ${normalizedPath}`);
				}
			} catch {
				errors.push(`File does not exist: ${normalizedPath}`);
			}

			if (errors.length > 0) {
				return asJsonTextResult({ valid: false, path: normalizedPath, errors });
			}

			try {
				await fs.unlink(resolvedPath);
				return asJsonTextResult({ deleted: true, path: normalizedPath });
			} catch (error: unknown) {
				return asJsonTextResult({
					valid: false,
					path: normalizedPath,
					errors: [error instanceof Error ? error.message : "Failed to delete file"]
				});
			}
		}
	);

	server.registerResource(
		"project",
		"godot://project",
		{
			title: "Godot Project Summary",
			description: "当前 Godot 项目的摘要信息",
			mimeType: "application/json"
		},
		async (uri: URL) => ({
			contents: [{
				uri: uri.href,
				mimeType: "application/json",
				text: JSON.stringify(await getProjectSummary(), null, 2)
			}]
		})
	);

	server.registerResource(
		"scenes",
		"godot://scenes",
		{
			title: "Godot Scenes",
			description: "当前 Godot 项目的场景文件列表",
			mimeType: "application/json"
		},
		async (uri: URL) => ({
			contents: [{
				uri: uri.href,
				mimeType: "application/json",
				text: JSON.stringify({ scenes: await walkProjectFiles({ extensions: [".tscn"] }) }, null, 2)
			}]
		})
	);

	server.registerResource(
		"scripts",
		"godot://scripts",
		{
			title: "GDScript Files",
			description: "当前 Godot 项目的 GDScript 文件列表",
			mimeType: "application/json"
		},
		async (uri: URL) => ({
			contents: [{
				uri: uri.href,
				mimeType: "application/json",
				text: JSON.stringify({ scripts: await walkProjectFiles({ extensions: [".gd"] }) }, null, 2)
			}]
		})
	);

	// Scene semantic tools
	server.registerTool(
		"inspect_scene_tree",
		{
			title: "Inspect Scene Tree",
			description: "解析 .tscn 场景文件，返回节点树、脚本引用和信号连接的完整结构化信息。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("场景文件的相对路径，例如 'scenes/main.tscn'")
			})
		},
		async ({ relativePath }) => {
			try {
				const fullPath = await resolveProjectPath(relativePath);
				const ext = path.extname(fullPath);
				if (ext !== ".tscn") {
					return asJsonTextResult({ valid: false, path: relativePath, errors: ["File is not a .tscn scene file"] });
				}
				const content = await fs.readFile(fullPath, "utf8");
				const data = parseTscn(content);
				return asJsonTextResult({ valid: true, path: relativePath, data });
			} catch (error: unknown) {
				return asJsonTextResult({ valid: false, path: relativePath, errors: [error instanceof Error ? error.message : "Failed to inspect scene"] });
			}
		}
	);

	server.registerTool(
		"propose_create_scene",
		{
			title: "Propose Create Scene",
			description: "提出创建一个新的 Godot 场景文件（.tscn）的提案。不会实际写入磁盘，仅返回校验结果和预览。参数包含相对路径、根节点类型和根节点名称。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("新场景文件的相对路径，必须以 .tscn 结尾"),
				rootNodeType: z.string().min(1).describe("根节点类型，例如 Node2D、Node3D、Control"),
				rootNodeName: z.string().min(1).describe("根节点名称，例如 Main、Game")
			})
		},
		async ({ relativePath, rootNodeType, rootNodeName }) => {
			const content = generateSceneTscn(rootNodeType, rootNodeName);
			const validation = await validateNewTextFile(relativePath, content);
			if (!validation.valid) {
				return asJsonTextResult({ valid: false, path: validation.normalizedPath, errors: validation.errors });
			}
			return asJsonTextResult({
				valid: true,
				path: validation.normalizedPath,
				rootNodeType,
				rootNodeName,
				size: content.length,
				preview: content
			});
		}
	);

	server.registerTool(
		"create_scene",
		{
			title: "Create Scene",
			description: "创建一个新的 Godot 场景 .tscn 文件，会实际写入磁盘。需要用户审批。参数包含相对路径、根节点类型和根节点名称。写入后建议运行 godot.check_only 验证。",
			inputSchema: z.object({
				relativePath: z.string().min(1).describe("新场景文件的相对路径，必须以 .tscn 结尾"),
				rootNodeType: z.string().min(1).describe("根节点类型，例如 Node2D、Node3D、Control"),
				rootNodeName: z.string().min(1).describe("根节点名称，例如 Main、Game")
			})
		},
		async ({ relativePath, rootNodeType, rootNodeName }) => {
			const content = generateSceneTscn(rootNodeType, rootNodeName);
			const result = await createTextFile(relativePath, content);
			return asJsonTextResult({ ...result, rootNodeType, rootNodeName });
		}
	);

	server.registerTool(
		"propose_add_node_to_scene",
		{
			title: "Propose Add Node To Scene",
			description: "提出向场景添加节点的提案。不会实际写入磁盘，仅校验并返回修改后的场景预览。参数包含场景路径、父节点路径、节点类型、节点名称和属性。",
			inputSchema: z.object({
				scenePath: z.string().min(1).describe("已有场景文件的相对路径"),
				parentPath: z.string().min(1).describe("父节点的路径，根节点用 . 表示"),
				nodeType: z.string().min(1).describe("节点类型，例如 Label、Button、CollisionShape2D"),
				nodeName: z.string().min(1).describe("节点名称，例如 HealthLabel"),
				properties: z.record(z.string(), z.string()).optional().describe("节点属性，例如 { text: 'Hello', position: 'Vector2(100, 200)' }")
			})
		},
		async ({ scenePath, parentPath, nodeType, nodeName, properties }) => {
			try {
				const fullPath = await resolveProjectPath(scenePath);
				const oldContent = await fs.readFile(fullPath, "utf8");
				const data = parseTscn(oldContent);
				const targetParent = findNodeInTscn(data, parentPath);
				if (targetParent === null) {
					return asJsonTextResult({ valid: false, scenePath, errors: [`Parent node not found: ${parentPath}`] });
				}
				const newContent = addNodeToSceneTscn(oldContent, parentPath, nodeType, nodeName, properties ?? {});
				const previewStart = newContent.indexOf(`[node name="${quoteTscnString(nodeName)}"`);
				const preview = previewStart >= 0 ? newContent.slice(Math.max(0, previewStart - 50), previewStart + 200) : newContent.slice(0, 500);
				return asJsonTextResult({
					valid: true,
					scenePath,
					nodeType,
					nodeName,
					parentPath,
					preview: preview + (newContent.length > preview.length ? "\n..." : "")
				});
			} catch (error: unknown) {
				return asJsonTextResult({ valid: false, scenePath, errors: [error instanceof Error ? error.message : "Failed to preview node addition"] });
			}
		}
	);

	server.registerTool(
		"add_node_to_scene",
		{
			title: "Add Node To Scene",
			description: "向已有场景添加一个节点，会实际写入磁盘。需要用户审批。参数包含场景路径、父节点路径、节点类型、节点名称和属性。",
			inputSchema: z.object({
				scenePath: z.string().min(1).describe("已有场景文件的相对路径"),
				parentPath: z.string().min(1).describe("父节点的路径，根节点用 . 表示"),
				nodeType: z.string().min(1).describe("节点类型"),
				nodeName: z.string().min(1).describe("节点名称"),
				properties: z.record(z.string(), z.string()).optional().describe("节点属性")
			})
		},
		async ({ scenePath, parentPath, nodeType, nodeName, properties }) => {
			const fullPath = await resolveProjectPath(scenePath);
			const oldContent = await fs.readFile(fullPath, "utf8");
			const newContent = addNodeToSceneTscn(oldContent, parentPath, nodeType, nodeName, properties ?? {});
			await fs.writeFile(fullPath, newContent, "utf8");
			return asJsonTextResult({ modified: true, scenePath, nodeType, nodeName, parentPath });
		}
	);

	server.registerTool(
		"propose_attach_script_to_node",
		{
			title: "Propose Attach Script To Node",
			description: "提出给场景中的节点挂载脚本的提案。不会实际写入，仅校验并返回预览。参数包含场景路径、节点路径和脚本路径。",
			inputSchema: z.object({
				scenePath: z.string().min(1).describe("场景文件的相对路径"),
				nodePath: z.string().min(1).describe("目标节点的路径，例如 Main/Player"),
				scriptPath: z.string().min(1).describe("脚本资源路径，例如 res://scripts/player.gd 或 ExtResource('1_abc')")
			})
		},
		async ({ scenePath, nodePath, scriptPath }) => {
			try {
				const fullPath = await resolveProjectPath(scenePath);
				const oldContent = await fs.readFile(fullPath, "utf8");
				const data = parseTscn(oldContent);
				const targetNode = findNodeInTscn(data, nodePath);
				if (targetNode === null) {
					return asJsonTextResult({ valid: false, scenePath, errors: [`Node not found: ${nodePath}`] });
				}
				if (targetNode.script !== null) {
					return asJsonTextResult({ valid: false, scenePath, errors: [`Node already has a script: ${targetNode.script}`] });
				}
				const newContent = attachScriptToSceneTscn(oldContent, nodePath, scriptPath);
				const nodeIdx = newContent.indexOf(`[node name="${quoteTscnString(targetNode.name)}"`);
				const preview = nodeIdx >= 0 ? newContent.slice(nodeIdx, nodeIdx + 300) : newContent.slice(0, 500);
				return asJsonTextResult({ valid: true, scenePath, nodePath, scriptPath, preview: preview + "\n..." });
			} catch (error: unknown) {
				return asJsonTextResult({ valid: false, scenePath, errors: [error instanceof Error ? error.message : "Failed to preview script attachment"] });
			}
		}
	);

	server.registerTool(
		"attach_script_to_node",
		{
			title: "Attach Script To Node",
			description: "给场景中的节点挂载脚本，会实际写入磁盘。需要用户审批。参数包含场景路径、节点路径和脚本路径。",
			inputSchema: z.object({
				scenePath: z.string().min(1).describe("场景文件的相对路径"),
				nodePath: z.string().min(1).describe("目标节点的路径"),
				scriptPath: z.string().min(1).describe("脚本资源路径")
			})
		},
		async ({ scenePath, nodePath, scriptPath }) => {
			const fullPath = await resolveProjectPath(scenePath);
			const oldContent = await fs.readFile(fullPath, "utf8");
			const newContent = attachScriptToSceneTscn(oldContent, nodePath, scriptPath);
			await fs.writeFile(fullPath, newContent, "utf8");
			return asJsonTextResult({ modified: true, scenePath, nodePath, scriptPath });
		}
	);

	server.registerTool(
		"propose_connect_signal_in_scene",
		{
			title: "Propose Connect Signal In Scene",
			description: "提出在场景中连接信号的提案。不会实际写入，仅校验并返回预览。参数包含场景路径、信号名、发送节点、接收节点和方法名。",
			inputSchema: z.object({
				scenePath: z.string().min(1).describe("场景文件的相对路径"),
				signal: z.string().min(1).describe("信号名称，例如 pressed、body_entered"),
				fromNode: z.string().min(1).describe("发送信号的节点路径"),
				toNode: z.string().min(1).describe("接收信号的节点路径，方法所在节点用 . 表示"),
				method: z.string().min(1).describe("回调方法名称，例如 _on_button_pressed"),
				flags: z.number().int().optional().describe("连接标志，默认 0"),
				binds: z.string().optional().describe("绑定的参数，例如 [] 或 [1, 2]")
			})
		},
		async ({ scenePath, signal, fromNode, toNode, method, flags, binds }) => {
			try {
				const fullPath = await resolveProjectPath(scenePath);
				const oldContent = await fs.readFile(fullPath, "utf8");
				const data = parseTscn(oldContent);
				const connExists = data.connections.some(c => c.signal === signal && c.from === fromNode && c.to === toNode && c.method === method);
				if (connExists) {
					return asJsonTextResult({ valid: false, scenePath, errors: ["This signal connection already exists in the scene"] });
				}
				const newContent = connectSignalInSceneTscn(oldContent, signal, fromNode, toNode, method, flags, binds);
				const connLine = newContent.lastIndexOf("[connection ");
				const preview = connLine >= 0 ? newContent.slice(connLine, connLine + 200) : newContent.slice(-500);
				return asJsonTextResult({ valid: true, scenePath, signal, fromNode, toNode, method, preview });
			} catch (error: unknown) {
				return asJsonTextResult({ valid: false, scenePath, errors: [error instanceof Error ? error.message : "Failed to preview signal connection"] });
			}
		}
	);

	server.registerTool(
		"connect_signal_in_scene",
		{
			title: "Connect Signal In Scene",
			description: "在场景中连接一个信号，会实际写入磁盘。需要用户审批。参数包含场景路径、信号名、发送节点、接收节点和方法名。",
			inputSchema: z.object({
				scenePath: z.string().min(1).describe("场景文件的相对路径"),
				signal: z.string().min(1).describe("信号名称"),
				fromNode: z.string().min(1).describe("发送信号的节点路径"),
				toNode: z.string().min(1).describe("接收信号的节点路径"),
				method: z.string().min(1).describe("回调方法名称"),
				flags: z.number().int().optional().describe("连接标志"),
				binds: z.string().optional().describe("绑定的参数")
			})
		},
		async ({ scenePath, signal, fromNode, toNode, method, flags, binds }) => {
			const fullPath = await resolveProjectPath(scenePath);
			const oldContent = await fs.readFile(fullPath, "utf8");
			const newContent = connectSignalInSceneTscn(oldContent, signal, fromNode, toNode, method, flags, binds);
			await fs.writeFile(fullPath, newContent, "utf8");
			return asJsonTextResult({ modified: true, scenePath, signal, fromNode, toNode, method });
		}
	);

	const scenePatchOperationSchema = z.discriminatedUnion("type", [
		z.object({
			type: z.literal("add_node"),
			parentPath: z.string().min(1).describe("父节点路径，根节点用 . 表示"),
			nodeType: z.string().min(1).describe("节点类型，例如 VBoxContainer、Label、Button"),
			nodeName: z.string().min(1).describe("节点名称"),
			properties: z.record(z.string(), z.string()).optional().describe("节点属性，值必须是 .tscn 表达式字符串，例如 text 用 '\"Hello\"'")
		}),
		z.object({
			type: z.literal("attach_script"),
			nodePath: z.string().min(1).describe("目标节点路径"),
			scriptPath: z.string().min(1).describe("脚本资源路径，例如 res://scripts/main.gd")
		}),
		z.object({
			type: z.literal("connect_signal"),
			signal: z.string().min(1).describe("信号名称，例如 pressed"),
			fromNode: z.string().min(1).describe("发送信号的节点路径"),
			toNode: z.string().min(1).describe("接收信号的节点路径"),
			method: z.string().min(1).describe("回调方法名称"),
			flags: z.number().int().optional().describe("连接标志"),
			binds: z.string().optional().describe("绑定参数表达式")
		})
	]);

	server.registerTool(
		"propose_apply_scene_patch",
		{
			title: "Propose Apply Scene Patch",
			description: "提出批量修改已有 Godot .tscn 场景的提案。不会写入磁盘。支持一次性添加多个节点、挂载脚本、连接信号，适合减少碎片化工具调用。",
			inputSchema: z.object({
				scenePath: z.string().min(1).describe("已有场景文件的相对路径"),
				operations: z.array(scenePatchOperationSchema).min(1).max(50).describe("按顺序执行的场景操作列表")
			})
		},
		async ({ scenePath, operations }) => {
			try {
				const fullPath = await resolveProjectPath(scenePath);
				if (path.extname(fullPath) !== ".tscn") {
					return asJsonTextResult({ valid: false, scenePath, errors: ["File is not a .tscn scene file"] });
				}

				const oldContent = await fs.readFile(fullPath, "utf8");
				const patchResult = applyScenePatchToTscn(oldContent, operations as ScenePatchOperation[]);
				const validationErrors: string[] = validateTscnContent(patchResult.content);
				if (validationErrors.length > 0) {
					return asJsonTextResult({ valid: false, scenePath, errors: validationErrors });
				}

				return asJsonTextResult({
					valid: true,
					scenePath,
					operationCount: patchResult.applied.length,
					applied: patchResult.applied,
					oldSize: oldContent.length,
					newSize: patchResult.content.length,
					preview: patchResult.content.slice(0, 1200) + (patchResult.content.length > 1200 ? "\n..." : "")
				});
			} catch (error: unknown) {
				return asJsonTextResult({ valid: false, scenePath, errors: [error instanceof Error ? error.message : "Failed to preview scene patch"] });
			}
		}
	);

	server.registerTool(
		"apply_scene_patch",
		{
			title: "Apply Scene Patch",
			description: "批量修改已有 Godot .tscn 场景，会实际写入磁盘并需要用户审批。支持一次性添加多个节点、挂载脚本、连接信号，适合创建复杂 UI/小游戏场景。",
			inputSchema: z.object({
				scenePath: z.string().min(1).describe("已有场景文件的相对路径"),
				operations: z.array(scenePatchOperationSchema).min(1).max(50).describe("按顺序执行的场景操作列表")
			})
		},
		async ({ scenePath, operations }) => {
			const fullPath = await resolveProjectPath(scenePath);
			if (path.extname(fullPath) !== ".tscn") {
				throw new Error("File is not a .tscn scene file");
			}

			const oldContent = await fs.readFile(fullPath, "utf8");
			const patchResult = applyScenePatchToTscn(oldContent, operations as ScenePatchOperation[]);
			const validationErrors: string[] = validateTscnContent(patchResult.content);
			if (validationErrors.length > 0) {
				throw new Error(`TSCN validation failed: ${validationErrors.join("; ")}`);
			}

			await fs.writeFile(fullPath, patchResult.content, "utf8");
			return asJsonTextResult({
				modified: true,
				scenePath,
				operationCount: patchResult.applied.length,
				applied: patchResult.applied
			});
		}
	);

	const transport: StdioServerTransport = new StdioServerTransport();
	await server.connect(transport);

	console.error(`Godot MCP Server started, project: ${projectRoot}`);
}

main().catch((error: unknown): void => {
	console.error("MCP server fatal error:", error);
	process.exit(1);
});
