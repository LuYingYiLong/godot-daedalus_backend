export type TscnSection = {
	type: string;
	attributes: Record<string, string>;
	lineIndex: number;
};

export type TscnNode = {
	name: string;
	type: string;
	parent: string | null;
	instance: string | null;
	script: string | null;
	properties: Record<string, string>;
	lineStart: number;
	lineEnd: number;
};

export type TscnConnection = {
	signal: string;
	from: string;
	to: string;
	method: string;
	flags?: string | undefined;
	binds?: string | undefined;
	lineIndex: number;
};

export type TscnData = {
	header: TscnSection | null;
	nodes: TscnNode[];
	connections: TscnConnection[];
};

export type SceneScriptReferenceValidationResult = {
	ok: boolean;
	errors: string[];
	missingUniqueNames: string[];
	missingNodePaths: string[];
	missingSignalTargets: string[];
	missingSignalMethods: string[];
};

export type ScenePatchOperation =
	| { type: "add_node"; parentPath: string; nodeType: string; nodeName: string; properties?: Record<string, string> | undefined }
	| { type: "attach_script"; nodePath: string; scriptPath: string }
	| { type: "connect_signal"; signal: string; fromNode: string; toNode: string; method: string; flags?: number | undefined; binds?: string | undefined };

export function parseSectionHeader(line: string, lineIndex: number = 0): TscnSection | null {
	const match: RegExpMatchArray | null = line.match(/^\[([a-zA-Z_][a-zA-Z0-9_]*)\s*(.*)\]$/);
	if (match === null) {
		return null;
	}

	const attributes: Record<string, string> = {};
	const rest: string = match[2] ?? "";
	for (const attrMatch of rest.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)=("[^"]*"|[^\s]+)/g)) {
		attributes[attrMatch[1] as string] = attrMatch[2] as string;
	}

	return {
		type: match[1] as string,
		attributes,
		lineIndex
	};
}

function unquoteTscnString(value: string | undefined): string {
	if (value === undefined) {
		return "";
	}
	if (value.startsWith("\"") && value.endsWith("\"")) {
		return value.slice(1, -1);
	}
	return value;
}

export function quoteTscnString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

export function parseTscn(content: string): TscnData {
	const lines: string[] = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const data: TscnData = {
		header: null,
		nodes: [],
		connections: []
	};
	let currentNode: TscnNode | null = null;

	function finishNode(endLine: number): void {
		if (currentNode !== null) {
			currentNode.lineEnd = endLine;
			data.nodes.push(currentNode);
			currentNode = null;
		}
	}

	for (let index = 0; index < lines.length; index += 1) {
		const line: string = lines[index] ?? "";
		const section: TscnSection | null = parseSectionHeader(line, index);
		if (section === null) {
			if (currentNode !== null) {
				const equalsIndex: number = line.indexOf("=");
				if (equalsIndex > 0) {
					const key: string = line.slice(0, equalsIndex).trim();
					currentNode.properties[key] = line.slice(equalsIndex + 1).trim();
					if (key === "script") {
						currentNode.script = currentNode.properties[key] ?? null;
					}
				}
			}
			continue;
		}

		finishNode(index - 1);
		if (section.type === "gd_scene") {
			data.header = section;
		} else if (section.type === "node") {
			currentNode = {
				name: unquoteTscnString(section.attributes.name),
				type: unquoteTscnString(section.attributes.type),
				parent: section.attributes.parent !== undefined ? unquoteTscnString(section.attributes.parent) : null,
				instance: section.attributes.instance ?? null,
				script: null,
				properties: {},
				lineStart: index,
				lineEnd: index
			};
		} else if (section.type === "connection") {
			data.connections.push({
				signal: unquoteTscnString(section.attributes.signal),
				from: unquoteTscnString(section.attributes.from),
				to: unquoteTscnString(section.attributes.to),
				method: unquoteTscnString(section.attributes.method),
				flags: section.attributes.flags,
				binds: section.attributes.binds,
				lineIndex: index
			});
		}
	}
	finishNode(lines.length - 1);

	return data;
}

export function validateTscnContent(content: string): string[] {
	const errors: string[] = [];
	const trimmedContent: string = content.trimStart();
	if (!/^\[gd_scene\s/.test(trimmedContent)) {
		errors.push("TSCN file must start with [gd_scene ...] header");
	}
	if (!/^\[node\s/m.test(trimmedContent)) {
		errors.push("TSCN file must contain at least one [node ...] section (root node)");
	}
	return errors;
}

export function generateSceneTscn(rootNodeType: string, rootNodeName: string): string {
	return [
		"[gd_scene format=3]",
		"",
		`[node name="${quoteTscnString(rootNodeName)}" type="${quoteTscnString(rootNodeType)}"]`,
		""
	].join("\n");
}

export function getNodeFullPath(node: TscnNode, allNodes: TscnNode[]): string {
	if (node.parent === null) {
		return ".";
	}
	if (node.parent === ".") {
		return node.name;
	}
	return `${node.parent}/${node.name}`;
}

export function findNodeInTscn(data: TscnData, targetPath: string): TscnNode | null {
	const normalizedTarget: string = targetPath.trim() || ".";
	for (const node of data.nodes) {
		if (getNodeFullPath(node, data.nodes) === normalizedTarget || node.name === normalizedTarget && node.parent === null) {
			return node;
		}
	}
	return null;
}

function getNextSectionIndex(lines: string[], startIndex: number): number {
	for (let index = startIndex; index < lines.length; index += 1) {
		if (/^\[[a-zA-Z_]/.test(lines[index] ?? "")) {
			return index;
		}
	}
	return lines.length;
}

function findLastNodeInsertIndex(lines: string[]): number {
	let insertIndex: number = lines.length;
	for (let index = 0; index < lines.length; index += 1) {
		if ((lines[index] ?? "").startsWith("[connection ")) {
			return index;
		}
		if ((lines[index] ?? "").startsWith("[node ")) {
			insertIndex = getNextSectionIndex(lines, index + 1);
		}
	}
	return insertIndex;
}

function nodePathForChild(parentPath: string, nodeName: string): string {
	return parentPath === "." ? nodeName : `${parentPath}/${nodeName}`;
}

export function addNodeToSceneTscn(content: string, parentPath: string, nodeType: string, nodeName: string, properties: Record<string, string>): string {
	const data: TscnData = parseTscn(content);
	const parentNode: TscnNode | null = findNodeInTscn(data, parentPath);
	if (parentNode === null) {
		throw new Error(`Parent node not found in scene: ${parentPath}`);
	}
	const candidatePath: string = nodePathForChild(parentPath, nodeName);
	if (findNodeInTscn(data, candidatePath) !== null) {
		throw new Error(`Node already exists in scene: ${candidatePath}`);
	}

	const lines: string[] = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const nodeLines: string[] = [
		"",
		`[node name="${quoteTscnString(nodeName)}" type="${quoteTscnString(nodeType)}" parent="${quoteTscnString(parentPath)}"]`
	];
	for (const [key, value] of Object.entries(properties)) {
		nodeLines.push(`${key} = ${value}`);
	}
	lines.splice(findLastNodeInsertIndex(lines), 0, ...nodeLines);
	return lines.join("\n");
}

export function attachScriptToSceneTscn(content: string, nodePath: string, scriptPath: string): string {
	const data: TscnData = parseTscn(content);
	const targetNode: TscnNode | null = findNodeInTscn(data, nodePath);
	if (targetNode === null) {
		throw new Error(`Node not found in scene: ${nodePath}`);
	}
	if (targetNode.script !== null) {
		throw new Error(`Node already has a script: ${nodePath}`);
	}
	if (!scriptPath.startsWith("res://") && !scriptPath.startsWith("ExtResource(")) {
		throw new Error("scriptPath must be a res:// path or an ExtResource reference");
	}

	const lines: string[] = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	lines.splice(targetNode.lineEnd + 1, 0, `script = ${scriptPath.startsWith("ExtResource(") ? scriptPath : `ExtResource("${quoteTscnString(scriptPath)}")`}`);
	return lines.join("\n");
}

export function connectSignalInSceneTscn(content: string, signal: string, fromNode: string, toNode: string, method: string, flags?: number, binds?: string): string {
	const data: TscnData = parseTscn(content);
	if (findNodeInTscn(data, fromNode) === null) {
		throw new Error(`Signal source node not found in scene: ${fromNode}`);
	}
	if (findNodeInTscn(data, toNode) === null) {
		throw new Error(`Signal target node not found in scene: ${toNode}`);
	}
	if (data.connections.some((connection: TscnConnection): boolean => connection.signal === signal && connection.from === fromNode && connection.to === toNode && connection.method === method)) {
		throw new Error("This signal connection already exists in the scene");
	}

	const attrs: string[] = [
		`signal="${quoteTscnString(signal)}"`,
		`from="${quoteTscnString(fromNode)}"`,
		`to="${quoteTscnString(toNode)}"`,
		`method="${quoteTscnString(method)}"`
	];
	if (flags !== undefined) {
		attrs.push(`flags=${flags}`);
	}
	if (binds !== undefined) {
		attrs.push(`binds=${binds}`);
	}

	const lines: string[] = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (lines.length > 0 && (lines[lines.length - 1] ?? "").trim().length > 0) {
		lines.push("");
	}
	lines.push(`[connection ${attrs.join(" ")}]`);
	return lines.join("\n");
}

function collectUniqueNodeNames(data: TscnData): Set<string> {
	const names: Set<string> = new Set();
	for (const node of data.nodes) {
		if (node.properties.unique_name_in_owner === "true") {
			names.add(node.name);
		}
	}
	return names;
}

function collectRegexMatches(text: string, pattern: RegExp): string[] {
	const values: string[] = [];
	for (const match of text.matchAll(pattern)) {
		const value: string | undefined = match[1];
		if (value !== undefined && value.length > 0) {
			values.push(value);
		}
	}
	return [...new Set(values)];
}

function hasGdscriptFunction(scriptContent: string, method: string): boolean {
	const escapedMethod: string = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|\\n)\\s*func\\s+${escapedMethod}\\s*\\(`).test(scriptContent);
}

function formatSignalMethodReference(nodePath: string, method: string): string {
	return nodePath === "." ? `.${method}` : `${nodePath}.${method}`;
}

export function validateSceneScriptReferences(
	sceneContent: string,
	scriptContentByNodePath: Record<string, string> = {}
): SceneScriptReferenceValidationResult {
	const data: TscnData = parseTscn(sceneContent);
	const uniqueNodeNames: Set<string> = collectUniqueNodeNames(data);
	const missingUniqueNames: string[] = [];
	const missingNodePaths: string[] = [];
	const missingSignalTargets: string[] = [];
	const missingSignalMethods: string[] = [];

	for (const [nodePath, scriptContent] of Object.entries(scriptContentByNodePath)) {
		for (const nodeName of collectRegexMatches(scriptContent, /%([A-Za-z_][A-Za-z0-9_]*)/g)) {
			if (!uniqueNodeNames.has(nodeName)) {
				missingUniqueNames.push(`${nodePath}: %${nodeName}`);
			}
		}

		for (const referencedPath of collectRegexMatches(scriptContent, /\$([A-Za-z_][A-Za-z0-9_\/]*)/g)) {
			if (findNodeInTscn(data, referencedPath) === null) {
				missingNodePaths.push(`${nodePath}: $${referencedPath}`);
			}
		}
	}

	for (const connection of data.connections) {
		if (findNodeInTscn(data, connection.from) === null) {
			missingSignalTargets.push(`${connection.signal}: from ${connection.from}`);
		}
		if (findNodeInTscn(data, connection.to) === null) {
			missingSignalTargets.push(`${connection.signal}: to ${connection.to}`);
			continue;
		}
		const targetScript: string | undefined = scriptContentByNodePath[connection.to];
		if (targetScript !== undefined && !hasGdscriptFunction(targetScript, connection.method)) {
			missingSignalMethods.push(formatSignalMethodReference(connection.to, connection.method));
		}
	}

	const errors: string[] = [
		...missingUniqueNames.map((item: string): string => `Missing unique_name_in_owner for script reference ${item}`),
		...missingNodePaths.map((item: string): string => `Missing node path for script reference ${item}`),
		...missingSignalTargets.map((item: string): string => `Missing signal connection node ${item}`),
		...missingSignalMethods.map((item: string): string => `Missing signal target method ${item}`)
	];

	return {
		ok: errors.length === 0,
		errors,
		missingUniqueNames: [...new Set(missingUniqueNames)],
		missingNodePaths: [...new Set(missingNodePaths)],
		missingSignalTargets: [...new Set(missingSignalTargets)],
		missingSignalMethods: [...new Set(missingSignalMethods)]
	};
}

export function applyScenePatchToTscn(content: string, operations: ScenePatchOperation[]): {
	content: string;
	applied: Array<{ type: string; target: string }>;
} {
	let nextContent: string = content;
	const applied: Array<{ type: string; target: string }> = [];

	for (const operation of operations) {
		if (operation.type === "add_node") {
			nextContent = addNodeToSceneTscn(nextContent, operation.parentPath, operation.nodeType, operation.nodeName, operation.properties ?? {});
			applied.push({ type: operation.type, target: nodePathForChild(operation.parentPath, operation.nodeName) });
		} else if (operation.type === "attach_script") {
			nextContent = attachScriptToSceneTscn(nextContent, operation.nodePath, operation.scriptPath);
			applied.push({ type: operation.type, target: operation.nodePath });
		} else if (operation.type === "connect_signal") {
			nextContent = connectSignalInSceneTscn(nextContent, operation.signal, operation.fromNode, operation.toNode, operation.method, operation.flags, operation.binds);
			applied.push({ type: operation.type, target: `${operation.fromNode}.${operation.signal}` });
		} else {
			const unreachable: never = operation;
			throw new Error(`Unsupported scene patch operation: ${JSON.stringify(unreachable)}`);
		}
	}

	return { content: nextContent, applied };
}
