export const AUTOMATION_MCP_TOOL_NAMES = [
	"daedalus_backend_health",
	"daedalus_configure_environment",
	"daedalus_create_session",
	"daedalus_open_session",
	"daedalus_get_session_info",
	"daedalus_send_chat",
	"daedalus_wait_for_event",
	"daedalus_wait_for_run",
	"daedalus_get_session_events",
	"daedalus_get_plan",
	"daedalus_submit_clarification",
	"daedalus_revise_plan",
	"daedalus_approve_plan",
	"daedalus_list_pending_approvals",
	"daedalus_approve_matching_tool",
	"daedalus_get_file_edit_batch",
	"daedalus_assert_session_state"
] as const;

export type AutomationMcpToolName = typeof AUTOMATION_MCP_TOOL_NAMES[number];

export type AutomationConfig = {
	enabled: boolean;
	backendUrl: string;
	clientName: string;
	requestTimeoutMs: number;
	allowedTools: readonly string[];
	allowedPathPrefixes: readonly string[];
};

const DEFAULT_BACKEND_URL = "ws://localhost:38180";
const DEFAULT_CLIENT_NAME = "daedalus-automation-mcp";
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

const DEFAULT_ALLOWED_TOOLS = [
	"mcp_godot_create_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_replace_text_in_file",
	"mcp_godot_create_scene",
	"mcp_godot_apply_scene_patch",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_connect_signal_in_scene",
	"mcp_godot_editor_apply_scene_patch"
] as const;

const DEFAULT_ALLOWED_PATH_PREFIXES = [
	"scripts/daedalus_smoke_",
	"scenes/daedalus_smoke_"
] as const;

function readArgValue(argv: readonly string[], name: string): string | undefined {
	const equalsPrefix = `--${name}=`;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) {
			continue;
		}
		if (arg.startsWith(equalsPrefix)) {
			return arg.slice(equalsPrefix.length);
		}
		if (arg === `--${name}`) {
			return argv[index + 1];
		}
	}
	return undefined;
}

function parseCsv(value: string | undefined, fallback: readonly string[]): readonly string[] {
	if (value === undefined || value.trim() === "") {
		return fallback;
	}
	return value
		.split(",")
		.map((entry: string): string => entry.trim())
		.filter((entry: string): boolean => entry.length > 0);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

export function createAutomationConfig(
	env: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv.slice(2)
): AutomationConfig {
	return {
		enabled: env.DAEDALUS_AUTOMATION_MCP === "1",
		backendUrl: readArgValue(argv, "backend-url")
			?? env.DAEDALUS_AUTOMATION_BACKEND_URL
			?? env.DAEDALUS_BACKEND_URL
			?? DEFAULT_BACKEND_URL,
		clientName: readArgValue(argv, "client-name")
			?? env.DAEDALUS_AUTOMATION_CLIENT_NAME
			?? DEFAULT_CLIENT_NAME,
		requestTimeoutMs: parsePositiveInt(
			readArgValue(argv, "request-timeout-ms") ?? env.DAEDALUS_AUTOMATION_REQUEST_TIMEOUT_MS,
			DEFAULT_REQUEST_TIMEOUT_MS
		),
		allowedTools: parseCsv(env.DAEDALUS_AUTOMATION_ALLOWED_TOOLS, DEFAULT_ALLOWED_TOOLS),
		allowedPathPrefixes: parseCsv(env.DAEDALUS_AUTOMATION_ALLOWED_PATH_PREFIXES, DEFAULT_ALLOWED_PATH_PREFIXES)
	};
}
