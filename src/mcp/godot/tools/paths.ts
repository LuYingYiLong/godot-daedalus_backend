import * as path from "node:path";

export const WRITABLE_EXTENSIONS: ReadonlySet<string> = new Set([
	".gd",
	".tres",
	".tscn",
	".json",
	".md",
	".txt"
]);

export type ResolvedGodotPath = {
	originalPath: string;
	absolutePath: string;
	rootPath: string;
	kind: "user" | "res" | "absolute" | "relative_user";
};

export type GodotPathContext = {
	projectRoot: string;
	appDataPath: string;
	userProfilePath?: string | undefined;
	projectName: string;
};

export function isPathInsideRoot(absolutePath: string, rootPath: string): boolean {
	const relativePath: string = path.relative(path.resolve(rootPath), path.resolve(absolutePath));
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function normalizeDisplayPath(value: string): string {
	return value.replaceAll("\\", "/");
}

export function sanitizeGodotUserDirName(value: string): string {
	return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim() || "GodotProject";
}

export function getGodotUserDataDir(context: GodotPathContext): string {
	return path.join(context.appDataPath, "Godot", "app_userdata", sanitizeGodotUserDirName(context.projectName));
}

export function resolveProjectPath(projectRoot: string, relativePath: string): string {
	const cleanedPath: string = relativePath.trim();
	const resolvedPath: string = path.resolve(projectRoot, cleanedPath.length > 0 ? cleanedPath : ".");

	if (!isPathInsideRoot(resolvedPath, projectRoot)) {
		throw new Error(`Path traversal denied: ${relativePath}`);
	}

	return resolvedPath;
}

export function resolveGodotPath(resourcePath: string, context: GodotPathContext): ResolvedGodotPath {
	const trimmedPath: string = resourcePath.trim();
	const userDataDir: string = getGodotUserDataDir(context);

	if (trimmedPath.startsWith("user://")) {
		const relativeUserPath: string = trimmedPath.slice("user://".length);
		const absolutePath: string = path.resolve(userDataDir, relativeUserPath);
		if (!isPathInsideRoot(absolutePath, userDataDir)) {
			throw new Error(`user:// path traversal denied: ${resourcePath}`);
		}
		return { originalPath: resourcePath, absolutePath, rootPath: userDataDir, kind: "user" };
	}

	if (trimmedPath.startsWith("res://")) {
		const relativeResPath: string = trimmedPath.slice("res://".length);
		const absolutePath: string = path.resolve(context.projectRoot, relativeResPath);
		if (!isPathInsideRoot(absolutePath, context.projectRoot)) {
			throw new Error(`res:// path traversal denied: ${resourcePath}`);
		}
		return { originalPath: resourcePath, absolutePath, rootPath: context.projectRoot, kind: "res" };
	}

	if (path.isAbsolute(trimmedPath)) {
		const absolutePath: string = path.resolve(trimmedPath);
		if (isPathInsideRoot(absolutePath, context.projectRoot)) {
			return { originalPath: resourcePath, absolutePath, rootPath: context.projectRoot, kind: "absolute" };
		}
		if (isPathInsideRoot(absolutePath, userDataDir)) {
			return { originalPath: resourcePath, absolutePath, rootPath: userDataDir, kind: "absolute" };
		}
		throw new Error(`Absolute path is outside allowed Godot project/user data roots: ${resourcePath}`);
	}

	const absolutePath: string = path.resolve(userDataDir, trimmedPath);
	if (!isPathInsideRoot(absolutePath, userDataDir)) {
		throw new Error(`Relative user data path traversal denied: ${resourcePath}`);
	}
	return { originalPath: resourcePath, absolutePath, rootPath: userDataDir, kind: "relative_user" };
}

export function redactOnePath(value: string, context: GodotPathContext, raw: boolean): string {
	if (raw) {
		return normalizeDisplayPath(value);
	}

	const normalizedValue: string = normalizeDisplayPath(path.resolve(value));
	const normalizedProjectRoot: string = normalizeDisplayPath(path.resolve(context.projectRoot));
	if (normalizedValue === normalizedProjectRoot || normalizedValue.startsWith(`${normalizedProjectRoot}/`)) {
		return normalizedValue;
	}

	if (context.userProfilePath !== undefined) {
		const normalizedUserProfile: string = normalizeDisplayPath(path.resolve(context.userProfilePath));
		if (normalizedValue === normalizedUserProfile || normalizedValue.startsWith(`${normalizedUserProfile}/`)) {
			return normalizedValue.replace(normalizedUserProfile, "[user]");
		}
	}

	return `[redacted]/${path.basename(normalizedValue)}`;
}

export function redactSensitivePaths(text: string, context: GodotPathContext, raw: boolean): string {
	if (raw) {
		return normalizeDisplayPath(text);
	}

	let redactedText: string = normalizeDisplayPath(text);
	if (context.userProfilePath !== undefined) {
		redactedText = redactedText.replaceAll(normalizeDisplayPath(context.userProfilePath), "[user]");
	}
	return redactedText.replace(/[A-Za-z]:\/[^"\s,)]+/g, (matchedPath: string): string => redactOnePath(matchedPath, context, false));
}

export function assertWritableProjectPath(projectRoot: string, relativePath: string): string {
	const cleanedPath: string = relativePath.trim().replaceAll("\\", "/");
	const resolvedPath: string = resolveProjectPath(projectRoot, cleanedPath);
	const normalizedPath: string = path.relative(projectRoot, resolvedPath).replaceAll(path.sep, "/");
	const segments: string[] = normalizedPath.split("/");

	for (const segment of segments) {
		if (segment.startsWith(".") && segment !== ".") {
			throw new Error(`Path contains hidden directory: ${segment}`);
		}
	}

	for (const prefix of [".godot", "addons"]) {
		if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
			throw new Error(`Writing to ${prefix}/ is not allowed`);
		}
	}

	const extension: string = path.extname(resolvedPath);
	if (!WRITABLE_EXTENSIONS.has(extension)) {
		throw new Error(`Unsupported writable extension: ${extension || "(none)"}`);
	}

	return resolvedPath;
}
