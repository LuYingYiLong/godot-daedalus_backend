import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

const MAX_TEXT_FILE_BYTES: number = 512 * 1024;
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

	await fs.access(path.join(projectRoot, "project.godot"));
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

async function readProjectConfig(): Promise<Record<string, string>> {
	const configPath: string = path.join(projectRoot, "project.godot");
	const content: string = await fs.readFile(configPath, "utf8");
	const config: Record<string, string> = {};

	for (const line of content.split("\n")) {
		const trimmedLine: string = line.trim();
		if (trimmedLine.length === 0 || trimmedLine.startsWith(";") || trimmedLine.startsWith("[")) {
			continue;
		}

		const equalsIndex: number = trimmedLine.indexOf("=");
		if (equalsIndex === -1) {
			continue;
		}

		const key: string = trimmedLine.slice(0, equalsIndex).trim();
		const value: string = trimmedLine.slice(equalsIndex + 1).trim().replace(/^"|"$/g, "");
		config[key] = value;
	}

	return config;
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
		name: config["config/name"] ?? "unknown",
		mainScene: config["run/main_scene"] ?? "",
		features: config["config/features"] ?? "",
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

function asTextResult(text: string): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [{ type: "text", text }]
	};
}

function asJsonTextResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return asTextResult(JSON.stringify(value, null, 2));
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

	const transport: StdioServerTransport = new StdioServerTransport();
	await server.connect(transport);

	console.error(`Godot MCP Server started, project: ${projectRoot}`);
}

main().catch((error: unknown): void => {
	console.error("MCP server fatal error:", error);
	process.exit(1);
});
