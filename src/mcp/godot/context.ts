import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseProjectSettings, type ProjectSettingsDocument } from "./tools/project-settings-document.js";
import { WRITABLE_EXTENSIONS } from "./tools/paths.js";

export type ProjectSummary = {
	path: string;
	name: string;
	mainScene: string;
	features: string;
	addons: string[];
	sceneCount: number;
	scriptCount: number;
};

export type ResolvedGodotPath = {
	originalPath: string;
	absolutePath: string;
	rootPath: string;
	kind: "user" | "res" | "absolute" | "relative_user";
};

export const PROJECT_CONFIG_FILE_NAME: string = "project.godot";

export const projectPathText: string | undefined = process.env.GODOT_PROJECT_PATH;

if (projectPathText === undefined || projectPathText.trim().length === 0) {
	console.error("GODOT_PROJECT_PATH environment variable is required");
	process.exit(1);
}

export const projectRoot: string = path.resolve(projectPathText);

export function toProjectRelativePath(absolutePath: string): string {
	return path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/");
}

export function isPathInsideProject(absolutePath: string): boolean {
	const relativePath: string = path.relative(projectRoot, absolutePath);
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export async function resolveProjectPath(relativePath: string): Promise<string> {
	const cleanedPath: string = relativePath.trim();
	const resolvedPath: string = path.resolve(projectRoot, cleanedPath.length > 0 ? cleanedPath : ".");

	if (!isPathInsideProject(resolvedPath)) {
		throw new Error(`Path traversal denied: ${relativePath}`);
	}

	return resolvedPath;
}

export async function resolveGodotResourceProjectPath(resourcePath: string): Promise<string> {
	const cleanedPath: string = resourcePath.trim();
	if (cleanedPath.startsWith("res://")) {
		return resolveProjectPath(cleanedPath.slice("res://".length));
	}

	return resolveProjectPath(cleanedPath);
}

export async function assertProjectExists(): Promise<void> {
	const stat = await fs.stat(projectRoot);
	if (!stat.isDirectory()) {
		throw new Error(`GODOT_PROJECT_PATH is not a directory: ${projectRoot}`);
	}

	await fs.access(path.join(projectRoot, PROJECT_CONFIG_FILE_NAME));
}

export function getProjectConfigPath(): string {
	return path.join(projectRoot, PROJECT_CONFIG_FILE_NAME);
}

export async function readProjectSettingsDocument(): Promise<ProjectSettingsDocument> {
	const content: string = await fs.readFile(getProjectConfigPath(), "utf8");
	return parseProjectSettings(content);
}

export async function readProjectConfig(): Promise<Record<string, string>> {
	const document: ProjectSettingsDocument = await readProjectSettingsDocument();
	const config: Record<string, string> = {};

	for (const entry of document.entries) {
		config[entry.fullKey] = entry.valueExpression;
	}

	return config;
}

export function parseProjectSettingString(valueExpression: string | undefined): string | undefined {
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

export function parseProjectSettingBoolean(valueExpression: string | undefined, fallback: boolean): boolean {
	const trimmedValue: string | undefined = valueExpression?.trim();
	if (trimmedValue === "true") {
		return true;
	}

	if (trimmedValue === "false") {
		return false;
	}

	return fallback;
}

export function parseProjectSettingInteger(valueExpression: string | undefined, fallback: number): number {
	const trimmedValue: string | undefined = valueExpression?.trim();
	if (trimmedValue === undefined || !/^-?\d+$/.test(trimmedValue)) {
		return fallback;
	}

	return Number.parseInt(trimmedValue, 10);
}

export function parseProjectFeatureVersion(config: Record<string, string>): string | undefined {
	const featuresValue: string | undefined = config["application/config/features"] ?? config["config/features"];
	if (featuresValue === undefined) {
		return undefined;
	}

	const match: RegExpMatchArray | null = featuresValue.match(/"(\d+\.\d+)"/);
	return match?.[1];
}

export function isPathInsideRoot(absolutePath: string, rootPath: string): boolean {
	const relativePath: string = path.relative(rootPath, absolutePath);
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function getWindowsAppDataPath(): string {
	const appDataPath: string | undefined = process.env.APPDATA;
	if (appDataPath === undefined || appDataPath.trim().length === 0) {
		throw new Error("APPDATA is not configured; cannot resolve Godot user:// paths");
	}

	return appDataPath;
}

export function getUserProfilePath(): string | undefined {
	const userProfilePath: string | undefined = process.env.USERPROFILE;
	return userProfilePath !== undefined && userProfilePath.trim().length > 0
		? path.resolve(userProfilePath)
		: undefined;
}

export function getGodotConfigDir(): string {
	return path.join(getWindowsAppDataPath(), GODOT_CONFIG_DIR_NAME);
}

export function getProjectEditorDir(): string {
	return path.join(projectRoot, ".godot", "editor");
}

export function normalizeDisplayPath(value: string): string {
	return value.replaceAll("\\", "/");
}

export function isWindowsAbsolutePath(value: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(value);
}

export function isCurrentProjectPath(value: string): boolean {
	if (!isWindowsAbsolutePath(value) && !path.isAbsolute(value)) {
		return false;
	}

	return isPathInsideRoot(path.resolve(value), projectRoot);
}

export function redactOnePath(value: string, raw: boolean): string {
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

export function redactSensitivePaths(text: string, raw: boolean): string {
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

export function sanitizeGodotUserDirName(value: string): string {
	const sanitized: string = value.trim()
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
		.replace(/[. ]+$/g, "")
		.trim();

	return sanitized.length > 0 ? sanitized : "[unnamed project]";
}

export function getProjectNameForUserData(config: Record<string, string>): string {
	const projectName: string | undefined = parseProjectSettingString(config["application/config/name"]);
	return sanitizeGodotUserDirName(projectName ?? "[unnamed project]");
}

export function getGodotUserDataDir(config: Record<string, string>): string {
	const appDataPath: string = getWindowsAppDataPath();
	const projectName: string = getProjectNameForUserData(config);
	const useCustomUserDir: boolean = parseProjectSettingBoolean(config["application/config/use_custom_user_dir"], false);

	if (useCustomUserDir) {
		const customUserDirName: string | undefined = parseProjectSettingString(config["application/config/custom_user_dir_name"]);
		return path.join(appDataPath, sanitizeGodotUserDirName(customUserDirName ?? projectName));
	}

	return path.join(appDataPath, "Godot", "app_userdata", projectName);
}

export function resolveGodotPath(resourcePath: string, config: Record<string, string>): ResolvedGodotPath {
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

export function asTextResult(text: string): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [{ type: "text", text }]
	};
}

export function asJsonTextResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return asTextResult(JSON.stringify(value, null, 2));
}

const PROHIBITED_PREFIXES: string[] = [".godot", "addons"];
const GODOT_CONFIG_DIR_NAME: string = "Godot";

export async function assertWritablePath(relativePath: string): Promise<string> {
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
