import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

const MAX_TEXT_FILE_BYTES: number = 512 * 1024;
const MAX_NEW_FILE_BYTES: number = 64 * 1024;

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

	const transport: StdioServerTransport = new StdioServerTransport();
	await server.connect(transport);

	console.error(`Godot MCP Server started, project: ${projectRoot}`);
}

main().catch((error: unknown): void => {
	console.error("MCP server fatal error:", error);
	process.exit(1);
});
