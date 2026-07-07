import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
	addNodeToSceneTscn,
	applyScenePatchToTscn,
	attachScriptToSceneTscn,
	connectSignalInSceneTscn,
	findNodeInTscn,
	generateSceneTscn,
	getExtResourceIdFromScriptValue,
	getSceneRelativeNodePath,
	parseTscn,
	quoteTscnString,
	validateSceneScriptReferences,
	validateTscnContent,
	type ScenePatchOperation,
	type TscnData,
	type TscnExtResource
} from "../tscn-tools.js";
import { asJsonTextResult, resolveGodotResourceProjectPath, resolveProjectPath } from "./context.js";
import { createTextFile, validateNewTextFile } from "./project-files.js";

async function collectSceneScriptContents(data: TscnData): Promise<Record<string, string>> {
	const scriptContents: Record<string, string> = {};
	for (const node of data.nodes) {
		const extResourceId: string | null = getExtResourceIdFromScriptValue(node.script);
		if (extResourceId === null) {
			continue;
		}

		const resource: TscnExtResource | undefined = data.extResources.find((item: TscnExtResource): boolean => item.id === extResourceId);
		if (resource?.path === undefined || !resource.path.endsWith(".gd")) {
			continue;
		}

		const scriptPath: string = await resolveGodotResourceProjectPath(resource.path);
		scriptContents[getSceneRelativeNodePath(node)] = await fs.readFile(scriptPath, "utf8");
	}

	return scriptContents;
}

export function registerSceneTools(server: McpServer): void {
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
		"validate_scene_script_references",
		{
			title: "Validate Scene Script References",
			description: "检查 .tscn 场景附加脚本中的 %UniqueName、$NodePath 和信号连接目标方法是否能被当前场景结构满足。只读验证工具。",
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
				const scriptContents = await collectSceneScriptContents(data);
				const validation = validateSceneScriptReferences(content, scriptContents);
				return asJsonTextResult({
					valid: validation.ok,
					ok: validation.ok,
					path: relativePath,
					scriptNodeCount: Object.keys(scriptContents).length,
					errors: validation.errors,
					missingUniqueNames: validation.missingUniqueNames,
					missingNodePaths: validation.missingNodePaths,
					missingSignalTargets: validation.missingSignalTargets,
					missingSignalMethods: validation.missingSignalMethods
				});
			} catch (error: unknown) {
				return asJsonTextResult({
					valid: false,
					ok: false,
					path: relativePath,
					errors: [error instanceof Error ? error.message : "Failed to validate scene script references"]
				});
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

}
