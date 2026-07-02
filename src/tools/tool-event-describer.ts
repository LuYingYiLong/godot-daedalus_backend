export type ToolEventCategory =
	| "read"
	| "write"
	| "search"
	| "terminal"
	| "scene"
	| "approval"
	| "propose"
	| "docs"
	| "unknown";

export type ToolEventTarget = {
	kind: "file" | "scene" | "command" | "query" | "approval" | "unknown";
	path?: string;
	line?: number;
	label?: string;
};

export type ToolEventDisplay = {
	serverId: string;
	serverName: string;
	category: ToolEventCategory;
	title: string;
	summary: string;
	target: ToolEventTarget;
};

function getStringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value: unknown = args[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOperationJson(args: Record<string, unknown>): Record<string, unknown> {
	const operationJson: string | undefined = getStringArg(args, "operationJson");
	if (operationJson === undefined) {
		return {};
	}

	try {
		const parsed: unknown = JSON.parse(operationJson);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
}

function createDisplay(
	serverId: string,
	serverName: string,
	category: ToolEventCategory,
	title: string,
	summary: string,
	target: ToolEventTarget
): ToolEventDisplay {
	return { serverId, serverName, category, title, summary, target };
}

export function describeToolEvent(toolName: string, args: Record<string, unknown>): ToolEventDisplay {
	if (toolName.startsWith("mcp_godot_")) {
		const relativePath: string | undefined = getStringArg(args, "relativePath") ?? getStringArg(args, "scenePath");

		if (toolName.includes("read_text_file")) {
			const filePath: string = relativePath ?? "unknown file";
			return createDisplay("godot", "Godot", "read", "读取文件", `读取 ${filePath}`, {
				kind: "file",
				path: filePath,
				label: filePath
			});
		}

		if (toolName.includes("search_text")) {
			const query: string = getStringArg(args, "query") ?? "";
			return createDisplay("godot", "Godot", "search", "搜索文本", `搜索 ${query}`, {
				kind: "query",
				label: query
			});
		}

		if (toolName.includes("propose_")) {
			const targetKind: ToolEventTarget["kind"] = toolName.includes("scene") || toolName.includes("scene_patch") || relativePath?.endsWith(".tscn")
				? "scene"
				: "file";
			const targetLabel: string = relativePath ?? (targetKind === "scene" ? "unknown scene" : "unknown file");
			const title: string = targetKind === "scene" ? "预览场景修改" : "预览文件修改";
			return createDisplay("godot", "Godot", "propose", title, `${title} ${targetLabel}`, {
				kind: targetKind,
				path: targetLabel,
				label: targetLabel
			});
		}

		if (toolName.includes("scene")) {
			const scenePath: string = relativePath ?? "unknown scene";
			const category: ToolEventCategory = toolName.includes("inspect") ? "read" : "scene";
			const title: string = toolName.includes("inspect") ? "查看场景" : "编辑场景";
			return createDisplay("godot", "Godot", category, title, `${title} ${scenePath}`, {
				kind: "scene",
				path: scenePath,
				label: scenePath
			});
		}

		if (toolName.includes("create_text_file") || toolName.includes("overwrite_text_file") || toolName.includes("replace_text_in_file") || toolName.includes("delete_file")) {
			const filePath: string = relativePath ?? "unknown file";
			return createDisplay("godot", "Godot", "write", "写入文件", `写入 ${filePath}`, {
				kind: "file",
				path: filePath,
				label: filePath
			});
		}

		return createDisplay("godot", "Godot", "unknown", "Godot 工具", toolName, {
			kind: "unknown",
			label: toolName
		});
	}

	if (toolName === "mcp_terminal_run_godot_scene_script") {
		const operation: Record<string, unknown> = parseOperationJson(args);
		const scenePath: string = typeof operation.scene_path === "string"
			? operation.scene_path
			: typeof operation.path === "string"
				? operation.path
				: "scene operation";
		return createDisplay("terminal", "Terminal", "scene", "执行 Godot 场景脚本", `场景操作 ${scenePath}`, {
			kind: "scene",
			path: scenePath,
			label: scenePath
		});
	}

	if (toolName.startsWith("mcp_terminal_")) {
		const presetName: string = getStringArg(args, "presetName") ?? toolName;
		return createDisplay("terminal", "Terminal", "terminal", "运行终端命令", presetName, {
			kind: "command",
			label: presetName
		});
	}

	if (toolName.includes("context7") || toolName.includes("library") || toolName.includes("docs")) {
		return createDisplay("context7", "Context7", "docs", "查询文档", toolName, {
			kind: "query",
			label: toolName
		});
	}

	return createDisplay("unknown", "MCP", "unknown", "MCP 工具", toolName, {
		kind: "unknown",
		label: toolName
	});
}
