import type { ChatCompletionMessageToolCall } from "openai/resources/chat/completions";

const TOOL_TAG_PATTERN: RegExp = /<\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*>([\s\S]*?)<\/\s*\1\s*>/g;
const PARAMETER_TAG_PATTERN: RegExp = /<\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*>([\s\S]*?)<\/\s*\1\s*>/g;

const RAW_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
	get_project_summary: "mcp_godot_get_project_summary",
	list_project_files: "mcp_godot_list_project_files",
	list_scenes: "mcp_godot_list_scenes",
	list_scripts: "mcp_godot_list_scripts",
	read_text_file: "mcp_godot_read_text_file",
	search_text: "mcp_godot_search_text",
	propose_create_text_file: "mcp_godot_propose_create_text_file",
	create_text_file: "mcp_godot_create_text_file",
	propose_overwrite_text_file: "mcp_godot_propose_overwrite_text_file",
	overwrite_text_file: "mcp_godot_overwrite_text_file",
	propose_replace_text_in_file: "mcp_godot_propose_replace_text_in_file",
	replace_text_in_file: "mcp_godot_replace_text_in_file",
	delete_file: "mcp_godot_delete_file",
	get_terminal_capabilities: "mcp_terminal_get_capabilities",
	run_safe_preset: "mcp_terminal_run_safe_preset",
	run_write_preset: "mcp_terminal_run_write_preset",
	run_godot_scene_script: "mcp_terminal_run_godot_scene_script",
	inspect_scene_tree: "mcp_godot_inspect_scene_tree",
	propose_create_scene: "mcp_godot_propose_create_scene",
	create_scene: "mcp_godot_create_scene",
	propose_add_node_to_scene: "mcp_godot_propose_add_node_to_scene",
	add_node_to_scene: "mcp_godot_add_node_to_scene",
	propose_attach_script_to_node: "mcp_godot_propose_attach_script_to_node",
	attach_script_to_node: "mcp_godot_attach_script_to_node",
	propose_connect_signal_in_scene: "mcp_godot_propose_connect_signal_in_scene",
	connect_signal_in_scene: "mcp_godot_connect_signal_in_scene",
	propose_apply_scene_patch: "mcp_godot_propose_apply_scene_patch",
	apply_scene_patch: "mcp_godot_apply_scene_patch"
};
const RAW_TOOL_NAMES: readonly string[] = Object.keys(RAW_TOOL_NAME_MAP);

const RELATIVE_PATH_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_godot_read_text_file",
	"mcp_godot_propose_create_text_file",
	"mcp_godot_create_text_file",
	"mcp_godot_propose_overwrite_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_propose_replace_text_in_file",
	"mcp_godot_replace_text_in_file",
	"mcp_godot_delete_file",
	"mcp_godot_inspect_scene_tree",
	"mcp_godot_propose_create_scene",
	"mcp_godot_create_scene"
]);

const SCENE_PATH_TOOL_NAMES: ReadonlySet<string> = new Set([
	"mcp_godot_propose_add_node_to_scene",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_propose_attach_script_to_node",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_propose_connect_signal_in_scene",
	"mcp_godot_connect_signal_in_scene",
	"mcp_godot_propose_apply_scene_patch",
	"mcp_godot_apply_scene_patch"
]);

function decodeXmlEntities(text: string): string {
	return text
		.replaceAll("&quot;", "\"")
		.replaceAll("&apos;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

function parseLooseValue(rawValue: string): unknown {
	const decoded: string = decodeXmlEntities(rawValue).trim();
	if (decoded.length === 0) {
		return "";
	}

	if (
		decoded.startsWith("{")
		|| decoded.startsWith("[")
		|| decoded.startsWith("\"")
		|| decoded === "true"
		|| decoded === "false"
		|| decoded === "null"
		|| /^-?\d+(?:\.\d+)?$/.test(decoded)
	) {
		try {
			return JSON.parse(decoded) as unknown;
		} catch {
			return decoded;
		}
	}

	return decoded;
}

export function normalizeKnownToolName(toolName: string): string | undefined {
	if (toolName.startsWith("mcp_")) {
		return toolName;
	}

	return RAW_TOOL_NAME_MAP[toolName];
}

export function isKnownLooseToolTagName(toolName: string): boolean {
	return toolName.startsWith("mcp_") || RAW_TOOL_NAME_MAP[toolName] !== undefined;
}

export function isPotentialLooseToolTagName(toolNamePrefix: string): boolean {
	return toolNamePrefix.length > 0 && (
		"mcp_".startsWith(toolNamePrefix)
		|| toolNamePrefix.startsWith("mcp_")
		|| RAW_TOOL_NAMES.some((toolName: string): boolean => toolName.startsWith(toolNamePrefix))
	);
}

function normalizeParameterName(toolName: string, parameterName: string): string {
	if (parameterName === "path") {
		if (SCENE_PATH_TOOL_NAMES.has(toolName)) {
			return "scenePath";
		}

		if (RELATIVE_PATH_TOOL_NAMES.has(toolName)) {
			return "relativePath";
		}
	}

	if (parameterName === "preset") {
		return "presetName";
	}

	if (parameterName === "operation") {
		return "operationJson";
	}

	return parameterName;
}

function defaultParameterName(toolName: string): string | undefined {
	if (SCENE_PATH_TOOL_NAMES.has(toolName)) {
		return "scenePath";
	}

	if (RELATIVE_PATH_TOOL_NAMES.has(toolName)) {
		return "relativePath";
	}

	if (toolName === "mcp_godot_search_text") {
		return "query";
	}

	if (toolName === "mcp_terminal_run_safe_preset" || toolName === "mcp_terminal_run_write_preset") {
		return "presetName";
	}

	return undefined;
}

function parseLooseArguments(toolName: string, body: string): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	let foundParameter: boolean = false;
	let parameterMatch: RegExpExecArray | null;

	PARAMETER_TAG_PATTERN.lastIndex = 0;
	while ((parameterMatch = PARAMETER_TAG_PATTERN.exec(body)) !== null) {
		const rawParameterName: string = parameterMatch[1] ?? "";
		const rawParameterValue: string = parameterMatch[2] ?? "";
		if (rawParameterName.length === 0) {
			continue;
		}

		foundParameter = true;
		const parameterName: string = normalizeParameterName(toolName, rawParameterName);
		args[parameterName] = parseLooseValue(rawParameterValue);
	}

	if (!foundParameter) {
		const fallbackName: string | undefined = defaultParameterName(toolName);
		const fallbackValue: unknown = parseLooseValue(body);
		if (fallbackName !== undefined && typeof fallbackValue === "string" && fallbackValue.length > 0) {
			args[fallbackName] = fallbackValue;
		}
	}

	return args;
}

function isAllowedToolName(toolName: string, allowedToolNames?: ReadonlySet<string>): boolean {
	return allowedToolNames === undefined || allowedToolNames.has(toolName);
}

export function containsLooseToolCalls(
	text: string | null | undefined,
	allowedToolNames?: ReadonlySet<string>
): boolean {
	if (text === null || text === undefined) {
		return false;
	}

	let tagMatch: RegExpExecArray | null;
	TOOL_TAG_PATTERN.lastIndex = 0;
	while ((tagMatch = TOOL_TAG_PATTERN.exec(text)) !== null) {
		const rawToolName: string = tagMatch[1] ?? "";
		const toolName: string | undefined = normalizeKnownToolName(rawToolName);
		if (toolName !== undefined && isAllowedToolName(toolName, allowedToolNames)) {
			return true;
		}
	}

	return false;
}

export function stripLooseToolCalls(text: string, allowedToolNames?: ReadonlySet<string>): string {
	return text.replace(
		TOOL_TAG_PATTERN,
		(match: string, rawToolName: string): string => {
			const toolName: string | undefined = normalizeKnownToolName(rawToolName);
			if (toolName !== undefined && isAllowedToolName(toolName, allowedToolNames)) {
				return "";
			}

			return match;
		}
	).trim();
}

export function parseLooseToolCalls(
	text: string,
	idPrefix: string = "loose-tool",
	allowedToolNames?: ReadonlySet<string>
): ChatCompletionMessageToolCall[] {
	const toolCalls: ChatCompletionMessageToolCall[] = [];
	let tagMatch: RegExpExecArray | null;

	TOOL_TAG_PATTERN.lastIndex = 0;
	while ((tagMatch = TOOL_TAG_PATTERN.exec(text)) !== null) {
		const rawToolName: string = tagMatch[1] ?? "";
		const body: string = tagMatch[2] ?? "";
		const toolName: string | undefined = normalizeKnownToolName(rawToolName);
		if (toolName === undefined || !isAllowedToolName(toolName, allowedToolNames)) {
			continue;
		}

		toolCalls.push({
			id: `${idPrefix}-${toolCalls.length + 1}`,
			type: "function",
			function: {
				name: toolName,
				arguments: JSON.stringify(parseLooseArguments(toolName, body))
			}
		});
	}

	return toolCalls;
}
