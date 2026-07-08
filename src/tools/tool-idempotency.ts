import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getToolExecutionLedgerPath } from "../app-paths.js";
import type { McpHost } from "../mcp/mcp-host.js";
import { MAX_TOOL_RESULT_CHARS } from "./llm-tool-budget.js";
import { resolveToolMapping } from "./tool-mapping.js";
import { getToolPolicy } from "./tool-policy.js";
import { captureFileEditBatchDraft, type FileEditBatchDraft } from "./file-edit-snapshots.js";
import { logger } from "../logger.js";

const TOOL_EXECUTION_DEDUP_TTL_MS: number = 30 * 60 * 1000;
const MAX_COMPLETED_TOOL_EXECUTIONS: number = 500;

type ToolResultContent = {
	content: Array<{ type: string; text?: string }>;
};

type ToolExecutionRecord = {
	fingerprint: string;
	scope: string;
	llmToolName: string;
	serverId: string;
	toolName: string;
	argsHash: string;
	content: string;
	rawContentLength: number;
	truncated: boolean;
	createdAt: string;
	expiresAt: string;
};

export type IdempotentToolExecutionResult = {
	content: string;
	rawContentLength: number;
	truncated: boolean;
	reused: boolean;
	fingerprint?: string | undefined;
	fileEditDraft?: FileEditBatchDraft | undefined;
};

type ToolExecutionIdentity = {
	fingerprint: string;
	scope: string;
	serverId: string;
	toolName: string;
	argsHash: string;
};

const completedToolExecutions: Map<string, ToolExecutionRecord> = new Map();
const inFlightToolExecutions: Map<string, Promise<IdempotentToolExecutionResult>> = new Map();

let ledgerLoadPromise: Promise<void> | null = null;
let ledgerWriteQueue: Promise<void> = Promise.resolve();

const GODOT_PROJECT_MUTATION_TOOLS: ReadonlySet<string> = new Set([
	"mcp_godot_set_project_setting",
	"mcp_godot_unset_project_setting",
	"mcp_godot_create_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_replace_text_in_file",
	"mcp_godot_delete_file",
	"mcp_godot_create_scene",
	"mcp_godot_add_node_to_scene",
	"mcp_godot_attach_script_to_node",
	"mcp_godot_connect_signal_in_scene",
	"mcp_godot_apply_scene_patch",
	"mcp_godot_editor_apply_scene_patch"
]);

const GODOT_PROJECT_SETTINGS_MUTATION_TOOLS: ReadonlySet<string> = new Set([
	"mcp_godot_set_project_setting",
	"mcp_godot_unset_project_setting"
]);

function normalizeForStableJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item: unknown): unknown => normalizeForStableJson(item));
	}

	if (value !== null && typeof value === "object") {
		const record: Record<string, unknown> = value as Record<string, unknown>;
		const normalized: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			normalized[key] = normalizeForStableJson(record[key]);
		}
		return normalized;
	}

	if (value === undefined) {
		return null;
	}

	return value;
}

function stableJson(value: unknown): string {
	return JSON.stringify(normalizeForStableJson(value));
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function trimToolResult(text: string): string {
	if (text.length <= MAX_TOOL_RESULT_CHARS) {
		return text;
	}

	return text.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[结果已截断，原始长度 ${text.length} 字符]`;
}

function extractTextContent(result: ToolResultContent): string {
	const firstContent = result.content[0];
	if (firstContent !== undefined && firstContent.text !== undefined) {
		return firstContent.text;
	}

	return JSON.stringify(result);
}

function isRecordExpired(record: ToolExecutionRecord, now: number = Date.now()): boolean {
	return Date.parse(record.expiresAt) <= now;
}

function isToolExecutionRecord(value: unknown): value is ToolExecutionRecord {
	if (value === null || typeof value !== "object") {
		return false;
	}

	const record: Partial<ToolExecutionRecord> = value as Partial<ToolExecutionRecord>;
	return typeof record.fingerprint === "string"
		&& typeof record.scope === "string"
		&& typeof record.llmToolName === "string"
		&& typeof record.serverId === "string"
		&& typeof record.toolName === "string"
		&& typeof record.argsHash === "string"
		&& typeof record.content === "string"
		&& typeof record.rawContentLength === "number"
		&& typeof record.truncated === "boolean"
		&& typeof record.createdAt === "string"
		&& typeof record.expiresAt === "string";
}

async function loadLedger(): Promise<void> {
	try {
		const raw: string = await readFile(getToolExecutionLedgerPath(), "utf8");
		const now: number = Date.now();
		for (const line of raw.split("\n")) {
			const trimmed: string = line.trim();
			if (trimmed.length === 0) {
				continue;
			}

			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (isToolExecutionRecord(parsed) && !isRecordExpired(parsed, now)) {
					completedToolExecutions.set(parsed.fingerprint, parsed);
				}
			} catch {
				// 忽略损坏的 ledger 行，避免单条记录影响后端启动。
			}
		}
		pruneCompletedToolExecutions(now);
	} catch {
		// Ledger 不存在时按空记录处理。
	}
}

async function ensureLedgerLoaded(): Promise<void> {
	if (ledgerLoadPromise === null) {
		ledgerLoadPromise = loadLedger();
	}

	await ledgerLoadPromise;
}

function pruneCompletedToolExecutions(now: number = Date.now()): void {
	for (const [fingerprint, record] of completedToolExecutions.entries()) {
		if (isRecordExpired(record, now)) {
			completedToolExecutions.delete(fingerprint);
		}
	}

	while (completedToolExecutions.size > MAX_COMPLETED_TOOL_EXECUTIONS) {
		const oldestFingerprint: string | undefined = completedToolExecutions.keys().next().value;
		if (oldestFingerprint === undefined) {
			break;
		}
		completedToolExecutions.delete(oldestFingerprint);
	}
}

function enqueueLedgerWrite(record: ToolExecutionRecord): Promise<void> {
	ledgerWriteQueue = ledgerWriteQueue.then(async (): Promise<void> => {
		const ledgerPath: string = getToolExecutionLedgerPath();
		await mkdir(dirname(ledgerPath), { recursive: true });
		await writeFile(ledgerPath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
	}, async (): Promise<void> => {
		const ledgerPath: string = getToolExecutionLedgerPath();
		await mkdir(dirname(ledgerPath), { recursive: true });
		await writeFile(ledgerPath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
	});

	return ledgerWriteQueue;
}

export function shouldDedupeLlmToolExecution(llmToolName: string): boolean {
	const policy = getToolPolicy(llmToolName);
	return policy?.risk === "write" || policy?.risk === "destructive";
}

export function getLlmToolExecutionIdentity(
	llmToolName: string,
	args: Record<string, unknown>,
	scope: string = "workspace:none"
): ToolExecutionIdentity | undefined {
	if (!shouldDedupeLlmToolExecution(llmToolName)) {
		return undefined;
	}

	const mapping = resolveToolMapping(llmToolName);
	const argsHash: string = sha256(stableJson(args));
	const fingerprintHash: string = sha256(`${scope}\n${mapping.serverId}\n${mapping.toolName}\n${argsHash}`);
	return {
		fingerprint: `${mapping.serverId}:${mapping.toolName}:${fingerprintHash}`,
		scope,
		serverId: mapping.serverId,
		toolName: mapping.toolName,
		argsHash
	};
}

function getMcpExecutionScope(mcpHost: McpHost): string {
	return mcpHost.getActiveWorkspaceId() ?? "workspace:none";
}

function addRefreshPath(paths: Set<string>, value: unknown): void {
	if (typeof value !== "string") {
		return;
	}

	const trimmed: string = value.trim();
	if (trimmed.length === 0) {
		return;
	}

	paths.add(trimmed);
}

export function collectGodotRefreshPaths(llmToolName: string, args: Record<string, unknown>): string[] {
	const paths: Set<string> = new Set();
	if (GODOT_PROJECT_SETTINGS_MUTATION_TOOLS.has(llmToolName)) {
		paths.add("project.godot");
	}

	addRefreshPath(paths, args.relativePath);
	addRefreshPath(paths, args.scenePath);
	addRefreshPath(paths, args.scriptPath);
	addRefreshPath(paths, args.resourcePath);
	addRefreshPath(paths, args.path);

	const operations: unknown = args.operations;
	if (Array.isArray(operations)) {
		for (const operation of operations) {
			if (operation === null || typeof operation !== "object") {
				continue;
			}

			const operationRecord: Record<string, unknown> = operation as Record<string, unknown>;
			addRefreshPath(paths, operationRecord.scenePath);
			addRefreshPath(paths, operationRecord.scriptPath);
			addRefreshPath(paths, operationRecord.resourcePath);
			addRefreshPath(paths, operationRecord.path);
		}
	}

	return [...paths];
}

function refreshEditorFilesystemAfterGodotMutation(
	mcpHost: McpHost,
	llmToolName: string,
	args: Record<string, unknown>
): void {
	if (!GODOT_PROJECT_MUTATION_TOOLS.has(llmToolName)) {
		return;
	}

	const changedPaths: string[] = collectGodotRefreshPaths(llmToolName, args);
	void mcpHost.getEditorBridge().refreshFilesystem(changedPaths).catch((error: unknown): void => {
		logger.warn("godot_editor", "filesystem_refresh_failed", {
			llmToolName,
			changedPaths,
			error: error instanceof Error ? error.message : String(error)
		});
	});
}

async function executeMappedTool(
	mcpHost: McpHost,
	serverId: string,
	toolName: string,
	args: Record<string, unknown>,
	fingerprint?: string | undefined
): Promise<IdempotentToolExecutionResult> {
	const result = await mcpHost.callTool(serverId, toolName, args) as ToolResultContent;
	const textResult: string = extractTextContent(result);
	const truncated: boolean = textResult.length > MAX_TOOL_RESULT_CHARS;
	return {
		content: trimToolResult(textResult),
		rawContentLength: textResult.length,
		truncated,
		reused: false,
		fingerprint
	};
}

export async function executeLlmToolWithIdempotency(
	mcpHost: McpHost,
	llmToolName: string,
	args: Record<string, unknown>
): Promise<IdempotentToolExecutionResult> {
	const identity: ToolExecutionIdentity | undefined = getLlmToolExecutionIdentity(llmToolName, args, getMcpExecutionScope(mcpHost));
	if (identity === undefined) {
		const mapping = resolveToolMapping(llmToolName);
		const result: IdempotentToolExecutionResult = await captureFileEditBatchDraft(
			mcpHost,
			llmToolName,
			args,
			(): Promise<IdempotentToolExecutionResult> => executeMappedTool(mcpHost, mapping.serverId, mapping.toolName, args)
		);
		refreshEditorFilesystemAfterGodotMutation(mcpHost, llmToolName, args);
		return result;
	}

	await ensureLedgerLoaded();
	pruneCompletedToolExecutions();

	const existingRecord: ToolExecutionRecord | undefined = completedToolExecutions.get(identity.fingerprint);
	if (existingRecord !== undefined && !isRecordExpired(existingRecord)) {
		refreshEditorFilesystemAfterGodotMutation(mcpHost, llmToolName, args);
		return {
			content: existingRecord.content,
			rawContentLength: existingRecord.rawContentLength,
			truncated: existingRecord.truncated,
			reused: true,
			fingerprint: identity.fingerprint
		};
	}

	const existingInFlight: Promise<IdempotentToolExecutionResult> | undefined = inFlightToolExecutions.get(identity.fingerprint);
	if (existingInFlight !== undefined) {
		const result: IdempotentToolExecutionResult = await existingInFlight;
		refreshEditorFilesystemAfterGodotMutation(mcpHost, llmToolName, args);
		return { ...result, reused: true };
	}

	const executionPromise: Promise<IdempotentToolExecutionResult> = (async (): Promise<IdempotentToolExecutionResult> => {
		const result: IdempotentToolExecutionResult = await captureFileEditBatchDraft(
			mcpHost,
			llmToolName,
			args,
			(): Promise<IdempotentToolExecutionResult> => executeMappedTool(
				mcpHost,
				identity.serverId,
				identity.toolName,
				args,
				identity.fingerprint
			)
		);
		refreshEditorFilesystemAfterGodotMutation(mcpHost, llmToolName, args);
		const createdAt: string = new Date().toISOString();
		const record: ToolExecutionRecord = {
			fingerprint: identity.fingerprint,
			scope: identity.scope,
			llmToolName,
			serverId: identity.serverId,
			toolName: identity.toolName,
			argsHash: identity.argsHash,
			content: result.content,
			rawContentLength: result.rawContentLength,
			truncated: result.truncated,
			createdAt,
			expiresAt: new Date(Date.now() + TOOL_EXECUTION_DEDUP_TTL_MS).toISOString()
		};
		completedToolExecutions.set(identity.fingerprint, record);
		pruneCompletedToolExecutions();
		await enqueueLedgerWrite(record);
		return result;
	})();

	inFlightToolExecutions.set(identity.fingerprint, executionPromise);
	try {
		return await executionPromise;
	} finally {
		inFlightToolExecutions.delete(identity.fingerprint);
	}
}
