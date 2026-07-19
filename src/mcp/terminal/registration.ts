import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as path from "node:path";
import { z } from "zod";
import { terminalJobStore } from "./job-store.js";
import { runCommandWait, startCommandJob } from "./process-runner.js";
import {
	BACKEND_DIR,
	COMMAND_PRESETS,
	COMMAND_TIMEOUT_MS,
	DEFAULT_JOB_TIMEOUT_MS,
	GODOT_EXECUTABLE,
	GODOT_PROJECT,
	createAllowedWorkingRoots,
	createGodotResourceCommand,
	describePresetCommand,
	findPreset,
	isPathInsideRoot,
	materializePreset,
	normalizeTimeoutMs,
	normalizeWakeAfterMs,
	resolveWorkingDirectory
} from "./presets.js";
import { findWorkspace } from "../../workspace/registry.js";
import type { WorkspaceConfig } from "../../workspace/types.js";
import type { CommandPreset, PresetRunInput, TerminalCommandResult, TerminalJobRecord } from "./types.js";
import { logger } from "../../logger.js";

function asJsonTextResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(value, null, 2)
		}]
	};
}

function createMissingGodotProjectResult(presetName: string, context?: { godotProjectPath?: string | undefined; godotExecutablePath?: string | undefined }): { content: Array<{ type: "text"; text: string }> } {
	return asJsonTextResult({
		preset: presetName,
		ok: false,
		error: "GODOT_PROJECT_PATH is not configured for the terminal MCP server. Configure the Godot project path in the client and restart or reconnect the backend workspace before running Godot presets.",
		godotProjectPath: (context?.godotProjectPath ?? GODOT_PROJECT) || null,
		godotExecutablePath: context?.godotExecutablePath ?? GODOT_EXECUTABLE
	});
}

function parseJsonObjectsFromOutput(output: string): unknown[] {
	const lines: string[] = output
		.split(/\r?\n/)
		.map((line: string): string => line.trim())
		.filter((line: string): boolean => line.startsWith("{") && line.endsWith("}"));
	const values: unknown[] = [];

	for (const line of lines) {
		try {
			values.push(JSON.parse(line));
		} catch {
			continue;
		}
	}

	return values;
}

function selectGodotOperationResult(values: unknown[]): unknown {
	const objectValues: Array<Record<string, unknown>> = values.filter(
		(value: unknown): value is Record<string, unknown> =>
			typeof value === "object" && value !== null && !Array.isArray(value)
	);

	const changedValue: Record<string, unknown> | undefined = objectValues.find(
		(value: Record<string, unknown>): boolean =>
			value.ok === true && (value.created === true || value.modified === true)
	);
	if (changedValue !== undefined) {
		return changedValue;
	}

	const okValue: Record<string, unknown> | undefined = objectValues.find(
		(value: Record<string, unknown>): boolean => value.ok === true
	);
	if (okValue !== undefined) {
		return okValue;
	}

	return objectValues.at(-1) ?? null;
}

function createJobStartedResult(record: TerminalJobRecord): Record<string, unknown> {
	return {
		preset: record.preset,
		ok: undefined,
		status: record.status,
		jobId: record.jobId,
		command: record.command,
		commandLine: record.commandLine,
		cwd: record.cwd,
		pid: record.pid ?? null,
		startedAt: record.startedAt,
		timeoutAt: record.timeoutAt ?? null,
		wakeAfterMs: record.wakeAfterMs,
		nextWakeAt: record.nextWakeAt,
		resourcePath: record.resourcePath ?? null,
		godotProjectPath: record.godotProjectPath,
		godotExecutablePath: record.godotExecutablePath,
		stdoutTail: record.stdoutTail,
		stderrTail: record.stderrTail,
		durationMs: record.durationMs,
		truncated: record.truncated
	};
}

type TerminalInternalInput = {
	__daedalusWorkspaceId?: string | undefined;
};

function resolveTerminalContext(input: TerminalInternalInput): {
	workspaceId?: string | undefined;
	workspace?: WorkspaceConfig | undefined;
	godotProjectPath: string;
	godotExecutablePath: string;
} {
	const workspaceId: string | undefined = input.__daedalusWorkspaceId;
	const workspace: WorkspaceConfig | undefined = workspaceId === undefined
		? undefined
		: findWorkspace(workspaceId);

	if (workspaceId !== undefined && workspace === undefined) {
		return {
			workspaceId,
			godotProjectPath: "",
			godotExecutablePath: GODOT_EXECUTABLE
		};
	}

	return {
		workspaceId,
		workspace,
		godotProjectPath: workspace?.rootPath ?? GODOT_PROJECT,
		godotExecutablePath: workspace?.godotExecutablePath ?? GODOT_EXECUTABLE
	};
}

async function runPreset(input: PresetRunInput, allowedRisks: readonly string[]): Promise<Record<string, unknown>> {
	const context = resolveTerminalContext(input as PresetRunInput & TerminalInternalInput);
	const preset: CommandPreset = materializePreset(findPreset(input.presetName), {
		godotProjectPath: context.godotProjectPath,
		godotExecutablePath: context.godotExecutablePath
	});
	const startedAtMs: number = Date.now();

	if (!allowedRisks.includes(preset.risk)) {
		logger.warn("terminal", "preset_risk_rejected", {
			preset: input.presetName,
			risk: preset.risk,
			allowedRisks,
			executionMode: input.executionMode ?? "wait"
		});
		return {
			preset: input.presetName,
			ok: false,
			error: `Preset '${input.presetName}' has risk '${preset.risk}', not allowed by this tool.`,
			requiredRisk: preset.risk
		};
	}

	if (preset.requiresGodotProject && context.godotProjectPath.length === 0) {
		logger.warn("terminal", "godot_project_missing", {
			preset: input.presetName,
			workspaceId: context.workspace?.id ?? context.workspaceId,
			godotExecutablePath: context.godotExecutablePath
		});
		return JSON.parse(createMissingGodotProjectResult(input.presetName, context).content[0]!.text) as Record<string, unknown>;
	}

	let cwd: string;
	try {
		cwd = resolveWorkingDirectory(input.workingDirectory, preset, {
			godotProjectPath: context.godotProjectPath,
			godotExecutablePath: context.godotExecutablePath
		});
	} catch (error: unknown) {
		logger.warn("terminal", "working_directory_rejected", {
			preset: input.presetName,
			workingDirectory: input.workingDirectory,
			error: error instanceof Error ? error.message : "Invalid working directory"
		});
		return {
			preset: input.presetName,
			ok: false,
			error: error instanceof Error ? error.message : "Invalid working directory"
		};
	}

	let command: string[];
	try {
		command = createGodotResourceCommand(preset, input.resourcePath, {
			godotProjectPath: context.godotProjectPath,
			godotExecutablePath: context.godotExecutablePath
		});
	} catch (error: unknown) {
		logger.warn("terminal", "preset_arguments_invalid", {
			preset: input.presetName,
			resourcePath: input.resourcePath,
			error: error instanceof Error ? error.message : "Invalid preset arguments"
		});
		return {
			preset: input.presetName,
			ok: false,
			error: error instanceof Error ? error.message : "Invalid preset arguments",
			resourcePath: input.resourcePath ?? null,
			godotProjectPath: preset.requiresGodotProject ? context.godotProjectPath || null : undefined,
			godotExecutablePath: preset.requiresGodotProject ? context.godotExecutablePath : undefined
		};
	}

	if (input.executionMode === "job") {
		const wakeAfterMs: number | undefined = normalizeWakeAfterMs(input.wakeAfterMs);
		const record: TerminalJobRecord = startCommandJob({
			preset,
			command,
			cwd,
			timeoutMs: normalizeTimeoutMs(input.timeoutMs, preset, DEFAULT_JOB_TIMEOUT_MS),
			wakeAfterMs,
			tailLines: input.tailLines,
			resourcePath: input.resourcePath ?? null,
			godotProjectPath: preset.requiresGodotProject ? context.godotProjectPath || null : undefined,
			godotExecutablePath: preset.requiresGodotProject ? context.godotExecutablePath : undefined
		});
		logger.info("terminal", "job_started", {
			preset: input.presetName,
			risk: preset.risk,
			jobId: record.jobId,
			pid: record.pid,
			cwd,
			resourcePath: input.resourcePath,
			timeoutMs: record.timeoutAt,
			wakeAfterMs,
			durationMs: Date.now() - startedAtMs
		});
		return createJobStartedResult(record);
	}

	logger.info("terminal", "preset_started", {
		preset: input.presetName,
		risk: preset.risk,
		cwd,
		resourcePath: input.resourcePath,
		timeoutMs: normalizeTimeoutMs(input.timeoutMs, preset, COMMAND_TIMEOUT_MS)
	});
	const timeoutMs: number = normalizeTimeoutMs(input.timeoutMs, preset, COMMAND_TIMEOUT_MS);
	const result: TerminalCommandResult = await runCommandWait({
		preset,
		command,
		cwd,
		timeoutMs,
		resourcePath: input.resourcePath ?? null,
		godotProjectPath: preset.requiresGodotProject ? context.godotProjectPath || null : undefined,
		godotExecutablePath: preset.requiresGodotProject ? context.godotExecutablePath : undefined
	});
	logger.info("terminal", "preset_finished", {
		preset: input.presetName,
		risk: preset.risk,
		cwd,
		resourcePath: input.resourcePath,
		ok: result.ok,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		totalDurationMs: Date.now() - startedAtMs,
		stdoutChars: result.stdout.length,
		stderrChars: result.stderr.length,
		truncated: result.truncated
	});
	return result as unknown as Record<string, unknown>;
}

const presetRunSchema = z.object({
	presetName: z.string().min(1).describe("预设名称"),
	resourcePath: z.string().optional().describe("Godot 资源路径，可用 res://、项目相对路径或项目内绝对路径。"),
	workingDirectory: z.string().optional().describe("覆盖默认工作目录"),
	executionMode: z.enum(["wait", "job"]).optional().describe("wait 为默认同步等待；job 为长任务，立即返回 jobId。"),
	wakeAfterMs: z.number().int().positive().optional().describe("job 模式下请求 backend 在指定毫秒后唤醒 AI。"),
	timeoutMs: z.number().int().positive().optional().describe("命令超时毫秒。wait 默认 30000，job 默认 30 分钟。"),
	tailLines: z.number().int().positive().optional().describe("job tail 行数。")
}).passthrough();

export function registerTerminalTools(server: McpServer): void {
	server.registerTool(
		"get_terminal_capabilities",
		{
			title: "Get Terminal Capabilities",
			description: "返回当前终端 MCP 支持的所有预设命令列表及其风险等级。",
			inputSchema: z.object({}).passthrough()
		},
		async (input: TerminalInternalInput) => {
			const context = resolveTerminalContext(input);
			return asJsonTextResult({
				presets: COMMAND_PRESETS.map((preset: CommandPreset) => ({
					name: preset.name,
					description: preset.description,
					workingDirectory: materializePreset(preset, {
						godotProjectPath: context.godotProjectPath,
						godotExecutablePath: context.godotExecutablePath
					}).workingDirectory,
					risk: preset.risk,
					resourcePathMode: preset.resourcePathMode ?? "none",
					godotProjectPath: preset.requiresGodotProject ? context.godotProjectPath || null : undefined,
					godotExecutablePath: preset.requiresGodotProject ? context.godotExecutablePath : undefined,
					command: preset.requiresGodotProject
						? describePresetCommand(materializePreset(preset, {
							godotProjectPath: context.godotProjectPath,
							godotExecutablePath: context.godotExecutablePath
						}).command)
						: undefined,
					defaultTimeoutMs: preset.defaultTimeoutMs ?? COMMAND_TIMEOUT_MS
				}))
			});
		}
	);

	server.registerTool(
		"run_safe_preset",
		{
			title: "Run Safe Command Preset",
			description: "执行安全的预设命令（read/verify 风险），自动允许。默认同步等待；executionMode=job 时启动长任务并返回 jobId。",
			inputSchema: presetRunSchema
		},
		async (input: PresetRunInput) => asJsonTextResult(await runPreset(input, ["read", "verify"]))
	);

	server.registerTool(
		"run_write_preset",
		{
			title: "Run Write Command Preset",
			description: "执行写操作预设命令（write 风险），需要通过审批系统批准。也允许执行更低风险的 read/verify 预设，避免审批后的流程因为工具包装器选择错误而中断。默认同步等待；executionMode=job 时启动长任务并返回 jobId。",
			inputSchema: presetRunSchema
		},
		async (input: PresetRunInput) => asJsonTextResult(await runPreset(input, ["read", "verify", "write"]))
	);

	server.registerTool(
		"get_terminal_job_status",
		{
			title: "Get Terminal Job Status",
			description: "查询 terminal 长任务状态和最近输出 tail。",
			inputSchema: z.object({
				jobId: z.string().min(1)
			})
		},
		async ({ jobId }) => {
			const record: TerminalJobRecord | null = await terminalJobStore.get(jobId);
			return asJsonTextResult(record ?? { ok: false, status: "missing", jobId, error: `Terminal job not found: ${jobId}` });
		}
	);

	server.registerTool(
		"get_terminal_job_tail",
		{
			title: "Get Terminal Job Tail",
			description: "读取 terminal 长任务最近 stdout/stderr tail。",
			inputSchema: z.object({
				jobId: z.string().min(1)
			})
		},
		async ({ jobId }) => {
			const record: TerminalJobRecord | null = await terminalJobStore.get(jobId);
			if (record === null) {
				return asJsonTextResult({ ok: false, status: "missing", jobId, error: `Terminal job not found: ${jobId}` });
			}
			return asJsonTextResult({
				ok: record.status === "completed",
				status: record.status,
				jobId,
				stdoutTail: record.stdoutTail,
				stderrTail: record.stderrTail,
				durationMs: record.durationMs,
				exitCode: record.exitCode ?? null
			});
		}
	);

	server.registerTool(
		"cancel_terminal_job",
		{
			title: "Cancel Terminal Job",
			description: "取消正在运行的 terminal 长任务。需要审批。",
			inputSchema: z.object({
				jobId: z.string().min(1)
			})
		},
		async ({ jobId }) => asJsonTextResult(await terminalJobStore.cancel(jobId))
	);

	server.registerTool(
		"run_godot_scene_script",
		{
			title: "Run Godot Scene Script",
			description: "通过 Godot headless 模式调用 scene_operator.gd 执行场景操作。操作通过审批后实际写入磁盘。",
			inputSchema: z.object({
				operationJson: z.string().min(1).describe("JSON 格式的场景操作，包含 operation 字段和对应参数")
			}).passthrough()
		},
		async (input: { operationJson: string } & TerminalInternalInput) => {
			const { operationJson } = input;
			let parsed: unknown;
			try {
				parsed = JSON.parse(operationJson);
			} catch {
				return asJsonTextResult({ ok: false, error: "Invalid JSON: operationJson must be valid JSON" });
			}

			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				return asJsonTextResult({ ok: false, error: "operationJson must be a JSON object" });
			}

			const op = parsed as Record<string, unknown>;
			if (typeof op.operation !== "string" || op.operation.length === 0) {
				return asJsonTextResult({ ok: false, error: "Missing required field: operation" });
			}

			const scriptPath: string = "res://addons/godot_daedalus/tools/scene_operator.gd";
			const context = resolveTerminalContext(input);
			const godotProject: string = context.godotProjectPath;
			const godotExecutable: string = context.godotExecutablePath;
			if (godotProject.length === 0) {
				return createMissingGodotProjectResult("godot.scene_script", context);
			}
			const command: string[] = [
				godotExecutable,
				"--headless",
				"--disable-crash-handler",
				"--path", godotProject,
				"--script", scriptPath,
				"--", operationJson
			];
			const cwd: string = path.resolve(godotProject);
			const allowedWorkingRoots: string[] = createAllowedWorkingRoots({
				godotProjectPath: godotProject,
				godotExecutablePath: godotExecutable
			});
			if (!allowedWorkingRoots.some((allowedRoot: string): boolean => isPathInsideRoot(cwd, allowedRoot))) {
				return asJsonTextResult({ ok: false, error: "Godot project path is outside allowed roots" });
			}

			const result: TerminalCommandResult = await runCommandWait({
				preset: {
					name: "godot.scene_script",
					description: "Run scene operator",
					command,
					workingDirectory: cwd,
					risk: "write"
				},
				command,
				cwd,
				timeoutMs: COMMAND_TIMEOUT_MS,
				godotProjectPath: godotProject || null,
				godotExecutablePath: godotExecutable
			});
			const parsedEvents: unknown[] = parseJsonObjectsFromOutput(result.stdout);
			const parsedOutput: unknown = selectGodotOperationResult(parsedEvents);
			return asJsonTextResult({
				ok: result.exitCode === 0 && parsedOutput !== null && typeof parsedOutput === "object" && (parsedOutput as Record<string, unknown>).ok === true,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				durationMs: result.durationMs,
				truncated: result.truncated,
				parsed: parsedOutput,
				parsedEvents
			});
		}
	);
}
