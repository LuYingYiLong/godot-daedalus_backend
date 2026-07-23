import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
	getExtResourceIdFromScriptValue,
	getSceneRelativeNodePath,
	parseTscn,
	type TscnData,
	type TscnExtResource,
	type TscnNode
} from "./tscn-tools.js";
import { asJsonTextResult, projectRoot, resolveProjectPath, toProjectRelativePath } from "../context.js";

const MAX_SCAN_FILE_BYTES: number = 1024 * 1024;
const MAX_RESULTS: number = 500;

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
	".git",
	".godot",
	".idea",
	".vscode",
	"android",
	"node_modules"
]);

const ANALYZED_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	".gd",
	".gdshader",
	".godot",
	".tres",
	".tscn"
]);

const UNUSED_RESOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
	".aseprite",
	".bmp",
	".dae",
	".exr",
	".fbx",
	".glb",
	".gltf",
	".gdshader",
	".jpg",
	".jpeg",
	".json",
	".material",
	".mp3",
	".obj",
	".ogg",
	".otf",
	".png",
	".res",
	".scn",
	".shader",
	".svg",
	".tga",
	".tres",
	".tscn",
	".ttf",
	".wav",
	".webp"
]);

export type ResourceReference = {
	sourcePath: string;
	targetPath: string;
	rawReference: string;
};

export type SceneNodeSearchMatch = {
	scenePath: string;
	nodePath: string;
	name: string;
	type: string;
	parent: string | null;
	scriptPath: string | null;
	groups: string[];
	matchingSignals: string[];
};

function shouldSkipDirectory(name: string, includeAddons: boolean): boolean {
	return SKIPPED_DIRECTORIES.has(name) || (name === "addons" && !includeAddons);
}

function isObviousGeneratedFile(relativePath: string): boolean {
	const normalizedPath: string = relativePath.replaceAll("\\", "/");
	return normalizedPath.endsWith(".import")
		|| normalizedPath.endsWith(".uid")
		|| normalizedPath.includes("/.import/")
		|| normalizedPath.startsWith("imported/")
		|| normalizedPath.startsWith("exports/");
}

async function walkProjectFiles(options?: {
	includeAddons?: boolean | undefined;
	extensions?: ReadonlySet<string> | undefined;
}): Promise<string[]> {
	const includeAddons: boolean = options?.includeAddons === true;
	const results: string[] = [];

	async function walk(directoryPath: string): Promise<void> {
		const entries: Dirent[] = await fs.readdir(directoryPath, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() && shouldSkipDirectory(entry.name, includeAddons)) {
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

			const relativePath: string = toProjectRelativePath(fullPath);
			if (isObviousGeneratedFile(relativePath)) {
				continue;
			}
			const extension: string = path.extname(relativePath).toLowerCase();
			if (options?.extensions !== undefined && !options.extensions.has(extension)) {
				continue;
			}
			results.push(relativePath);
		}
	}

	await walk(projectRoot);
	results.sort();
	return results;
}

async function readSmallTextFile(relativePath: string): Promise<string | null> {
	const fullPath: string = await resolveProjectPath(relativePath);
	const stat = await fs.stat(fullPath);
	if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) {
		return null;
	}
	return fs.readFile(fullPath, "utf8");
}

function normalizeResourceReference(rawReference: string): string | null {
	const withoutScheme: string = rawReference.trim().replaceAll("\\", "/").replace(/^res:\/\//u, "");
	if (withoutScheme.length === 0 || withoutScheme.startsWith("/") || /^[A-Za-z]:/u.test(withoutScheme)) {
		return null;
	}

	const normalized: string = path.posix.normalize(withoutScheme);
	if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
		return null;
	}
	return normalized;
}

function addReference(references: ResourceReference[], sourcePath: string, rawReference: string): void {
	const normalizedTarget: string | null = normalizeResourceReference(rawReference);
	if (normalizedTarget === null) {
		return;
	}

	if (references.some((reference: ResourceReference): boolean => reference.sourcePath === sourcePath && reference.targetPath === normalizedTarget)) {
		return;
	}

	references.push({
		sourcePath,
		targetPath: normalizedTarget,
		rawReference
	});
}

export function extractGodotResourceReferences(sourcePath: string, content: string): ResourceReference[] {
	const references: ResourceReference[] = [];
	const resReferenceRegex = /res:\/\/[^\s"'`\])},]+/gu;
	let match: RegExpExecArray | null;
	while ((match = resReferenceRegex.exec(content)) !== null) {
		addReference(references, sourcePath, match[0]!);
	}

	if (sourcePath.endsWith(".tscn")) {
		try {
			const scene: TscnData = parseTscn(content);
			for (const resource of scene.extResources) {
				if (resource.path !== undefined) {
					addReference(references, sourcePath, resource.path);
				}
			}
		} catch {
			return references;
		}
	}

	return references.sort((left: ResourceReference, right: ResourceReference): number => left.targetPath.localeCompare(right.targetPath));
}

function buildDependencyGraph(files: string[], references: ResourceReference[]): Map<string, string[]> {
	const existingFiles: Set<string> = new Set(files);
	const graph: Map<string, string[]> = new Map(files.map((filePath: string): [string, string[]] => [filePath, []]));
	for (const reference of references) {
		if (existingFiles.has(reference.targetPath)) {
			graph.get(reference.sourcePath)?.push(reference.targetPath);
		}
	}

	for (const [filePath, targets] of graph) {
		graph.set(filePath, [...new Set(targets)].sort());
	}
	return graph;
}

function detectCycles(graph: Map<string, string[]>): string[][] {
	const visiting: Set<string> = new Set();
	const visited: Set<string> = new Set();
	const stack: string[] = [];
	const cycles: string[][] = [];
	const seenCycles: Set<string> = new Set();

	function visit(node: string): void {
		if (visiting.has(node)) {
			const cycleStart: number = stack.indexOf(node);
			if (cycleStart >= 0) {
				const cycle: string[] = [...stack.slice(cycleStart), node];
				const key: string = cycle.join(" -> ");
				if (!seenCycles.has(key)) {
					seenCycles.add(key);
					cycles.push(cycle);
				}
			}
			return;
		}
		if (visited.has(node)) {
			return;
		}

		visiting.add(node);
		stack.push(node);
		for (const target of graph.get(node) ?? []) {
			visit(target);
		}
		stack.pop();
		visiting.delete(node);
		visited.add(node);
	}

	for (const node of graph.keys()) {
		visit(node);
	}
	return cycles;
}

async function collectDependencyData(includeAddons: boolean | undefined): Promise<{
	files: string[];
	analyzedFiles: string[];
	references: ResourceReference[];
	missingReferences: ResourceReference[];
	cycles: string[][];
	graph: Map<string, string[]>;
}> {
	const files: string[] = await walkProjectFiles({ includeAddons });
	const fileSet: Set<string> = new Set(files);
	const analyzedFiles: string[] = files.filter((filePath: string): boolean => ANALYZED_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
	const references: ResourceReference[] = [];

	for (const filePath of analyzedFiles) {
		const content: string | null = await readSmallTextFile(filePath);
		if (content === null) {
			continue;
		}
		references.push(...extractGodotResourceReferences(filePath, content));
	}

	const missingReferences: ResourceReference[] = references.filter((reference: ResourceReference): boolean => !fileSet.has(reference.targetPath));
	const graph: Map<string, string[]> = buildDependencyGraph(analyzedFiles, references);
	const cycles: string[][] = detectCycles(graph);

	return { files, analyzedFiles, references, missingReferences, cycles, graph };
}

async function analyzeProjectDependencies(includeAddons: boolean | undefined): Promise<Record<string, unknown>> {
	const data = await collectDependencyData(includeAddons);
	return {
		projectRoot,
		includeAddons: includeAddons === true,
		analyzedFileCount: data.analyzedFiles.length,
		referenceCount: data.references.length,
		references: data.references.slice(0, MAX_RESULTS),
		missingReferences: data.missingReferences.slice(0, MAX_RESULTS),
		cycles: data.cycles.slice(0, MAX_RESULTS),
		truncated: data.references.length > MAX_RESULTS || data.missingReferences.length > MAX_RESULTS || data.cycles.length > MAX_RESULTS
	};
}

async function findUnusedResources(includeAddons: boolean | undefined): Promise<Record<string, unknown>> {
	const data = await collectDependencyData(includeAddons);
	const used: Set<string> = new Set(data.references.map((reference: ResourceReference): string => reference.targetPath));
	const candidates: string[] = data.files.filter((filePath: string): boolean => {
		if (filePath === "project.godot" || isObviousGeneratedFile(filePath)) {
			return false;
		}
		const extension: string = path.extname(filePath).toLowerCase();
		return UNUSED_RESOURCE_EXTENSIONS.has(extension);
	});
	const unused: string[] = candidates.filter((filePath: string): boolean => !used.has(filePath));

	return {
		projectRoot,
		includeAddons: includeAddons === true,
		candidateCount: candidates.length,
		unusedCount: unused.length,
		unused: unused.slice(0, MAX_RESULTS),
		truncated: unused.length > MAX_RESULTS
	};
}

function extractQuotedArrayStrings(valueExpression: string | undefined): string[] {
	if (valueExpression === undefined) {
		return [];
	}

	const quotedValues: string[] = [];
	const regex = /"((?:[^"\\]|\\.)*)"/gu;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(valueExpression)) !== null) {
		quotedValues.push(match[1]!.replace(/\\"/gu, "\"").replace(/\\\\/gu, "\\"));
	}
	return quotedValues;
}

function getNodeScriptPath(scene: TscnData, node: TscnNode): string | null {
	const extResourceId: string | null = getExtResourceIdFromScriptValue(node.script);
	if (extResourceId === null) {
		return null;
	}

	const resource: TscnExtResource | undefined = scene.extResources.find((item: TscnExtResource): boolean => item.id === extResourceId);
	return resource?.path === undefined ? null : normalizeResourceReference(resource.path);
}

function normalizeOptionalFilter(value: string | undefined): string | null {
	const trimmed: string | undefined = value?.trim();
	return trimmed === undefined || trimmed.length === 0 ? null : trimmed.toLowerCase();
}

async function findSceneNodes(args: {
	scenePath?: string | undefined;
	nodeType?: string | undefined;
	name?: string | undefined;
	scriptPath?: string | undefined;
	group?: string | undefined;
	signal?: string | undefined;
	includeAddons?: boolean | undefined;
	limit?: number | undefined;
}): Promise<Record<string, unknown>> {
	const scenePaths: string[] = args.scenePath !== undefined
		? [toProjectRelativePath(await resolveProjectPath(args.scenePath))]
		: await walkProjectFiles({ includeAddons: args.includeAddons, extensions: new Set([".tscn"]) });
	const nodeTypeFilter: string | null = normalizeOptionalFilter(args.nodeType);
	const nameFilter: string | null = normalizeOptionalFilter(args.name);
	const scriptPathFilter: string | null = args.scriptPath === undefined ? null : normalizeResourceReference(args.scriptPath)?.toLowerCase() ?? args.scriptPath.toLowerCase();
	const groupFilter: string | null = normalizeOptionalFilter(args.group);
	const signalFilter: string | null = normalizeOptionalFilter(args.signal);
	const limit: number = Math.min(Math.max(args.limit ?? MAX_RESULTS, 1), MAX_RESULTS);
	const matches: SceneNodeSearchMatch[] = [];

	for (const scenePath of scenePaths) {
		const content: string | null = await readSmallTextFile(scenePath);
		if (content === null) {
			continue;
		}

		const scene: TscnData = parseTscn(content);
		for (const node of scene.nodes) {
			const nodePath: string = getSceneRelativeNodePath(node);
			const scriptPath: string | null = getNodeScriptPath(scene, node);
			const groups: string[] = extractQuotedArrayStrings(node.properties["groups"]);
			const matchingSignals: string[] = scene.connections
				.filter((connection): boolean => connection.from === nodePath || connection.to === nodePath)
				.map((connection): string => connection.signal);

			if (nodeTypeFilter !== null && node.type.toLowerCase() !== nodeTypeFilter) {
				continue;
			}
			if (nameFilter !== null && !node.name.toLowerCase().includes(nameFilter)) {
				continue;
			}
			if (scriptPathFilter !== null && scriptPath?.toLowerCase() !== scriptPathFilter) {
				continue;
			}
			if (groupFilter !== null && !groups.some((group: string): boolean => group.toLowerCase() === groupFilter)) {
				continue;
			}
			if (signalFilter !== null && !matchingSignals.some((signal: string): boolean => signal.toLowerCase() === signalFilter)) {
				continue;
			}

			matches.push({
				scenePath,
				nodePath,
				name: node.name,
				type: node.type,
				parent: node.parent,
				scriptPath,
				groups,
				matchingSignals
			});
			if (matches.length >= limit) {
				return { matches, totalMatched: matches.length, truncated: true };
			}
		}
	}

	return { matches, totalMatched: matches.length, truncated: false };
}

async function findScriptReferences(scriptPath: string, includeAddons: boolean | undefined): Promise<Record<string, unknown>> {
	const normalizedScriptPath: string | null = normalizeResourceReference(scriptPath);
	if (normalizedScriptPath === null) {
		throw new Error(`Invalid scriptPath: ${scriptPath}`);
	}

	const data = await collectDependencyData(includeAddons);
	const references: ResourceReference[] = data.references.filter((reference: ResourceReference): boolean => reference.targetPath === normalizedScriptPath);

	return {
		scriptPath: normalizedScriptPath,
		includeAddons: includeAddons === true,
		references: references.slice(0, MAX_RESULTS),
		totalMatched: references.length,
		truncated: references.length > MAX_RESULTS
	};
}

export function registerProjectAnalysisTools(server: McpServer): void {
	server.registerTool(
		"analyze_project_dependencies",
		{
			title: "Analyze Godot Project Dependencies",
			description: "Read-only scan of Godot text resources for res:// dependencies, missing references, and circular dependencies.",
			inputSchema: z.object({
				includeAddons: z.boolean().optional().describe("Defaults to false.")
			})
		},
		async ({ includeAddons }) => asJsonTextResult(await analyzeProjectDependencies(includeAddons))
	);

	server.registerTool(
		"find_unused_resources",
		{
			title: "Find Unused Godot Resources",
			description: "Read-only best-effort unused resource scan based on res:// references in project text resources.",
			inputSchema: z.object({
				includeAddons: z.boolean().optional().describe("Defaults to false.")
			})
		},
		async ({ includeAddons }) => asJsonTextResult(await findUnusedResources(includeAddons))
	);

	server.registerTool(
		"find_scene_nodes",
		{
			title: "Find Godot Scene Nodes",
			description: "Read-only cross-scene node search by type, name, attached script, group, or signal.",
			inputSchema: z.object({
				scenePath: z.string().optional(),
				nodeType: z.string().optional(),
				name: z.string().optional(),
				scriptPath: z.string().optional(),
				group: z.string().optional(),
				signal: z.string().optional(),
				includeAddons: z.boolean().optional(),
				limit: z.number().int().min(1).max(MAX_RESULTS).optional()
			})
		},
		async (args) => asJsonTextResult(await findSceneNodes(args))
	);

	server.registerTool(
		"find_script_references",
		{
			title: "Find Godot Script References",
			description: "Read-only scan for all res:// references to a script path.",
			inputSchema: z.object({
				scriptPath: z.string().min(1).describe("Script path, for example res://scripts/player.gd."),
				includeAddons: z.boolean().optional()
			})
		},
		async ({ scriptPath, includeAddons }) => asJsonTextResult(await findScriptReferences(scriptPath, includeAddons))
	);
}
