import { EXTERNAL_MCP_MODES, isExternalMcpMode, type ExternalMcpMode } from "../../tools/external-mcp-mode.js";

export const EXTERNAL_MCP_MINIMAL_TOOL_NAMES = [
	"daedalus_backend_health",
	"daedalus_list_workspaces",
	"daedalus_select_workspace",
	"daedalus_create_session",
	"daedalus_open_session",
	"daedalus_get_session_info",
	"daedalus_get_session_events",
	"daedalus_get_plan",
	"daedalus_list_pending_approvals"
] as const;

export const EXTERNAL_MCP_LITE_TOOL_NAMES = [
	...EXTERNAL_MCP_MINIMAL_TOOL_NAMES,
	"daedalus_send_chat",
	"daedalus_wait_for_event",
	"daedalus_submit_clarification",
	"daedalus_revise_plan",
	"daedalus_list_runtime_tools",
	"daedalus_call_runtime_tool"
] as const;

export const EXTERNAL_MCP_FULL_TOOL_NAMES = [
	...EXTERNAL_MCP_LITE_TOOL_NAMES,
	"daedalus_approve_plan",
	"daedalus_approve_tool",
	"daedalus_reject_tool"
] as const;

export type ExternalMcpToolName = typeof EXTERNAL_MCP_FULL_TOOL_NAMES[number];

export type ExternalMcpConfig = {
	mode: ExternalMcpMode;
	backendUrl: string;
	clientName: string;
	requestTimeoutMs: number;
};

const DEFAULT_BACKEND_URL = "ws://localhost:38180";
const DEFAULT_CLIENT_NAME = "godot-daedalus-mcp";
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

function readArgValue(argv: readonly string[], name: string): string | undefined {
	const equalsPrefix = `--${name}=`;
	for (let index = 0; index < argv.length; index += 1) {
		const arg: string | undefined = argv[index];
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

function readModeArg(argv: readonly string[], env: NodeJS.ProcessEnv): ExternalMcpMode {
	for (const mode of EXTERNAL_MCP_MODES) {
		if (argv.includes(`--${mode}`)) {
			return mode;
		}
	}

	const value: string | undefined = readArgValue(argv, "mode") ?? env.DAEDALUS_MCP_MODE;
	if (value === undefined || value.trim() === "") {
		return "lite";
	}
	if (!isExternalMcpMode(value)) {
		throw new Error(`Invalid external MCP mode: ${value}`);
	}
	return value;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") {
		return fallback;
	}
	const parsed: number = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

export function createExternalMcpConfig(
	env: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv.slice(2)
): ExternalMcpConfig {
	return {
		mode: readModeArg(argv, env),
		backendUrl: readArgValue(argv, "backend-url")
			?? env.DAEDALUS_MCP_BACKEND_URL
			?? env.DAEDALUS_BACKEND_URL
			?? DEFAULT_BACKEND_URL,
		clientName: readArgValue(argv, "client-name")
			?? env.DAEDALUS_MCP_CLIENT_NAME
			?? DEFAULT_CLIENT_NAME,
		requestTimeoutMs: parsePositiveInt(
			readArgValue(argv, "request-timeout-ms") ?? env.DAEDALUS_MCP_REQUEST_TIMEOUT_MS,
			DEFAULT_REQUEST_TIMEOUT_MS
		)
	};
}

export function getExternalMcpToolNames(mode: ExternalMcpMode): readonly ExternalMcpToolName[] {
	if (mode === "minimal") {
		return EXTERNAL_MCP_MINIMAL_TOOL_NAMES;
	}
	if (mode === "lite") {
		return EXTERNAL_MCP_LITE_TOOL_NAMES;
	}
	return EXTERNAL_MCP_FULL_TOOL_NAMES;
}
