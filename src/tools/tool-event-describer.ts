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
	if (toolName.startsWith("mcp_godot_editor_")) {
		const scenePath: string | undefined = getStringArg(args, "scenePath");
		const nodePath: string | undefined = getStringArg(args, "nodePath");
		const targetLabel: string = nodePath ?? scenePath ?? "Godot Editor";

		if (toolName.includes("get_context")) {
			return createDisplay("godot_editor", "Godot Editor", "read", "读取编辑器上下文", "读取当前编辑器在线状态与场景上下文", {
				kind: "unknown",
				label: "Godot Editor"
			});
		}

		if (toolName.includes("get_selected_nodes")) {
			return createDisplay("godot_editor", "Godot Editor", "read", "读取选中节点", "读取当前编辑器选中的节点", {
				kind: "scene",
				label: "selected nodes"
			});
		}

		if (toolName.includes("inspect_node")) {
			const target: ToolEventTarget = scenePath === undefined ? {
				kind: "scene",
				label: targetLabel
			} : {
				kind: "scene",
				path: scenePath,
				label: targetLabel
			};
			return createDisplay("godot_editor", "Godot Editor", "read", "查看在线节点", `查看 ${targetLabel}`, {
				...target
			});
		}

		if (toolName.includes("apply_scene_patch")) {
			const target: ToolEventTarget = scenePath === undefined ? {
				kind: "scene",
				label: "当前场景"
			} : {
				kind: "scene",
				path: scenePath,
				label: scenePath
			};
			return createDisplay("godot_editor", "Godot Editor", "scene", "编辑在线场景", `编辑 ${scenePath ?? "当前场景"}`, {
				...target
			});
		}
	}

	if (toolName.startsWith("mcp_godot_")) {
		const relativePath: string | undefined = getStringArg(args, "relativePath") ?? getStringArg(args, "scenePath");
		const settingKey: string | undefined = getStringArg(args, "key");

		if (toolName.includes("get_project_log_config")) {
			return createDisplay("godot", "Godot", "read", "读取日志配置", "解析 Godot 项目日志路径", {
				kind: "unknown",
				label: "project log config"
			});
		}

		if (toolName.includes("list_project_logs")) {
			return createDisplay("godot", "Godot", "read", "列出项目日志", "列出 Godot 项目日志文件", {
				kind: "file",
				label: "project logs"
			});
		}

		if (toolName.includes("read_project_log")) {
			const fileName: string = getStringArg(args, "fileName") ?? "godot.log";
			return createDisplay("godot", "Godot", "read", "读取项目日志", `读取 ${fileName}`, {
				kind: "file",
				label: fileName
			});
		}

		if (toolName.includes("get_project_settings")) {
			return createDisplay("godot", "Godot", "read", "读取项目设置", "读取 project.godot 设置", {
				kind: "file",
				path: "project.godot",
				label: "project.godot"
			});
		}

		if (toolName.includes("get_editor_config_summary")) {
			return createDisplay("godot", "Godot", "read", "读取编辑器摘要", "读取 Godot 编辑器设置与项目编辑状态摘要", {
				kind: "unknown",
				label: "Godot editor config"
			});
		}

		if (toolName.includes("get_editor_settings")) {
			return createDisplay("godot", "Godot", "read", "读取编辑器设置", "读取 editor_settings 配置", {
				kind: "file",
				label: "editor_settings"
			});
		}

		if (toolName.includes("list_editor_config_files")) {
			return createDisplay("godot", "Godot", "read", "列出编辑器配置", "列出可读的 Godot 编辑器配置文件", {
				kind: "file",
				label: "editor config files"
			});
		}

		if (toolName.includes("read_editor_config_file")) {
			const fileId: string = getStringArg(args, "fileId") ?? getStringArg(args, "filePath") ?? "editor config";
			return createDisplay("godot", "Godot", "read", "读取编辑器配置", `读取 ${fileId}`, {
				kind: "file",
				label: fileId
			});
		}

		if (toolName.includes("get_editor_project_state")) {
			return createDisplay("godot", "Godot", "read", "读取编辑器状态", "读取当前项目 .godot/editor 状态", {
				kind: "file",
				path: ".godot/editor",
				label: ".godot/editor"
			});
		}

		if (toolName.includes("get_recent_projects")) {
			return createDisplay("godot", "Godot", "read", "读取最近项目", "读取 Godot 最近项目与目录", {
				kind: "file",
				label: "projects.cfg"
			});
		}

		if (toolName.includes("propose_set_project_setting") || toolName.includes("propose_unset_project_setting")) {
			const targetLabel: string = settingKey ?? "project setting";
			return createDisplay("godot", "Godot", "propose", "预览项目设置修改", `预览 ${targetLabel}`, {
				kind: "file",
				path: "project.godot",
				label: targetLabel
			});
		}

		if (toolName.includes("set_project_setting") || toolName.includes("unset_project_setting")) {
			const targetLabel: string = settingKey ?? "project setting";
			return createDisplay("godot", "Godot", "write", "修改项目设置", `修改 ${targetLabel}`, {
				kind: "file",
				path: "project.godot",
				label: targetLabel
			});
		}

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
		const resourcePath: string | undefined = getStringArg(args, "resourcePath");
		const label: string = resourcePath === undefined ? presetName : `${presetName} ${resourcePath}`;
		const target: ToolEventTarget = resourcePath === undefined ? {
			kind: "command",
			label
		} : {
			kind: "command",
			path: resourcePath,
			label
		};
		return createDisplay("terminal", "Terminal", "terminal", "运行终端命令", label, target);
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
