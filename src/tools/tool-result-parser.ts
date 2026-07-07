export type ToolValidationStatus = "passed" | "failed" | "unknown";

export type ParsedToolResultSummary = {
	ok?: boolean | undefined;
	exitCode?: number | null | undefined;
	diagnosticsCount?: number | undefined;
	diagnosticsErrorCount?: number | undefined;
	validationStatus?: ToolValidationStatus | undefined;
	summary?: string | undefined;
	failedChecks?: string[] | undefined;
	artifactRefs?: string[] | undefined;
	terminalJobId?: string | undefined;
	terminalJobStatus?: string | undefined;
	terminalJobWakeAfterMs?: number | undefined;
};

function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

function getString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumberOrNull(value: unknown): number | null | undefined {
	if (typeof value === "number") {
		return value;
	}
	if (value === null) {
		return null;
	}
	return undefined;
}

function getBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function clipSummary(text: string, maxChars: number = 360): string {
	const trimmedText: string = text.trim();
	if (trimmedText.length <= maxChars) {
		return trimmedText;
	}

	return `${trimmedText.slice(0, maxChars)}...`;
}

function firstUsefulLine(text: string): string | undefined {
	return text
		.split(/\r?\n/u)
		.map((line: string): string => line.trim())
		.find((line: string): boolean => line.length > 0);
}

function collectArtifactRefs(args: Record<string, unknown>, record: Record<string, unknown> | null): string[] {
	const refs: Set<string> = new Set();
	for (const key of ["relativePath", "resourcePath", "scenePath", "scriptPath", "path"]) {
		const argValue: string | undefined = getString(args[key]);
		if (argValue !== undefined) {
			refs.add(argValue);
		}
		const recordValue: string | undefined = record === null ? undefined : getString(record[key]);
		if (recordValue !== undefined) {
			refs.add(recordValue);
		}
	}

	return [...refs];
}

function createFailureMessage(record: Record<string, unknown>, fallback: string): string {
	const errorText: string | undefined = getString(record.error);
	if (errorText !== undefined) {
		return errorText;
	}

	const stderrLine: string | undefined = getString(record.stderr) === undefined ? undefined : firstUsefulLine(String(record.stderr));
	if (stderrLine !== undefined) {
		return stderrLine;
	}

	const stdoutLine: string | undefined = getString(record.stdout) === undefined ? undefined : firstUsefulLine(String(record.stdout));
	if (stdoutLine !== undefined) {
		return stdoutLine;
	}

	return fallback;
}

function parseDiagnosticsSummary(record: Record<string, unknown>, args: Record<string, unknown>): ParsedToolResultSummary {
	const diagnostics: unknown = record.diagnostics;
	const diagnosticsList: Record<string, unknown>[] = Array.isArray(diagnostics)
		? diagnostics.filter((item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
		: [];
	const errorDiagnostics: Record<string, unknown>[] = diagnosticsList.filter((diagnostic: Record<string, unknown>): boolean => (
		String(diagnostic.severity ?? "").toLowerCase() === "error"
	));
	const failedChecks: string[] = errorDiagnostics.map((diagnostic: Record<string, unknown>): string => {
		const resourcePath: string = String(diagnostic.resourcePath ?? args.resourcePath ?? "script");
		const line: string = diagnostic.lineStart === undefined ? "?" : String(diagnostic.lineStart);
		const column: string = diagnostic.columnStart === undefined ? "?" : String(diagnostic.columnStart);
		return `${resourcePath}:${line}:${column} ${String(diagnostic.message ?? "LSP diagnostic error")}`;
	});
	const ok: boolean | undefined = getBoolean(record.ok);
	const diagnosticsCount: number = diagnosticsList.length;
	const diagnosticsErrorCount: number = errorDiagnostics.length;
	const validationOk: boolean | undefined = diagnosticsErrorCount > 0 ? false : ok;

	return {
		ok: validationOk,
		diagnosticsCount,
		diagnosticsErrorCount,
		validationStatus: diagnosticsErrorCount > 0 ? "failed" : ok === false ? "failed" : "passed",
		summary: `${String(record.resourcePath ?? args.resourcePath ?? "script")} LSP diagnostics: ${diagnosticsCount} total, ${diagnosticsErrorCount} errors`,
		failedChecks,
		artifactRefs: collectArtifactRefs(args, record)
	};
}

function parseTerminalSummary(record: Record<string, unknown>, args: Record<string, unknown>): ParsedToolResultSummary {
	const presetName: string = String(record.preset ?? args.presetName ?? "terminal");
	const status: string | undefined = getString(record.status);
	const jobId: string | undefined = getString(record.jobId);
	const ok: boolean | undefined = getBoolean(record.ok);
	const exitCode: number | null | undefined = getNumberOrNull(record.exitCode);
	const resourcePath: string | undefined = getString(record.resourcePath) ?? getString(args.resourcePath);
	if (status === "running") {
		return {
			ok: undefined,
			exitCode,
			validationStatus: "unknown",
			summary: `${presetName}${jobId === undefined ? "" : ` ${jobId}`} running`,
			artifactRefs: collectArtifactRefs(args, record),
			terminalJobId: jobId,
			terminalJobStatus: status,
			terminalJobWakeAfterMs: getNumberOrNull(record.wakeAfterMs) ?? undefined
		};
	}

	const isFailedStatus: boolean = status === "failed" || status === "timed_out" || status === "spawn_error";
	const failedChecks: string[] = ok === false || isFailedStatus
		? [`${presetName}${resourcePath === undefined ? "" : ` ${resourcePath}`} failed: ${createFailureMessage(record, `exitCode=${String(exitCode)}`)}`]
		: [];

	return {
		ok,
		exitCode,
		validationStatus: ok === false || isFailedStatus ? "failed" : ok === true || status === "completed" ? "passed" : "unknown",
		summary: `${presetName}${resourcePath === undefined ? "" : ` ${resourcePath}`} ${ok === false || status === "failed" || status === "timed_out" ? "failed" : ok === true || status === "completed" ? "passed" : "finished"}`,
		failedChecks: failedChecks.length > 0 ? failedChecks : undefined,
		artifactRefs: collectArtifactRefs(args, record),
		terminalJobId: jobId,
		terminalJobStatus: status
	};
}

function parseGenericJsonSummary(toolName: string, record: Record<string, unknown>, args: Record<string, unknown>): ParsedToolResultSummary {
	const ok: boolean | undefined = getBoolean(record.ok) ?? getBoolean(record.valid);
	const failedChecks: string[] = [];
	const errors: unknown = record.errors;
	if (Array.isArray(errors)) {
		for (const error of errors) {
			failedChecks.push(String(error));
		}
	}
	if (ok === false && failedChecks.length === 0) {
		failedChecks.push(createFailureMessage(record, `${toolName} returned ok=false`));
	}

	return {
		ok,
		validationStatus: ok === false ? "failed" : ok === true ? "passed" : "unknown",
		summary: getString(record.summary) ?? `${toolName}${ok === undefined ? "" : ok ? " passed" : " failed"}`,
		failedChecks: failedChecks.length > 0 ? failedChecks : undefined,
		artifactRefs: collectArtifactRefs(args, record)
	};
}

export function parseToolResultSummary(
	toolName: string,
	args: Record<string, unknown>,
	content: string
): ParsedToolResultSummary {
	const record: Record<string, unknown> | null = parseJsonObject(content);
	if (record === null) {
		return {
			validationStatus: "unknown",
			summary: firstUsefulLine(content) === undefined ? toolName : clipSummary(firstUsefulLine(content) ?? toolName),
			artifactRefs: collectArtifactRefs(args, null)
		};
	}

	if (toolName === "mcp_terminal_run_safe_preset" || toolName === "mcp_terminal_run_write_preset") {
		return parseTerminalSummary(record, args);
	}

	if (toolName === "mcp_godot_lsp_get_file_diagnostics") {
		return parseDiagnosticsSummary(record, args);
	}

	return parseGenericJsonSummary(toolName, record, args);
}
