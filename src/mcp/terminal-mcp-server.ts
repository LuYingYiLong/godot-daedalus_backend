import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { z } from "zod";

const MAX_STDOUT_CHARS: number = 12000;
const MAX_STDERR_CHARS: number = 12000;
const COMMAND_TIMEOUT_MS: number = 30_000;

type CommandRisk = "read" | "verify" | "write" | "destructive";

type CommandPreset = {
	name: string;
	description: string;
	command: string[];
	workingDirectory: string;
	risk: CommandRisk;
	requiresGodotProject?: boolean | undefined;
	resourcePathMode?: "optional" | "required" | undefined;
};

type SafePresetInput = {
	presetName: string;
	workingDirectory?: string | undefined;
	resourcePath?: string | undefined;
};

const BACKEND_DIR: string = process.env.BACKEND_DIR ?? process.cwd();
const GODOT_EXECUTABLE: string = process.env.GODOT_EXECUTABLE_PATH ?? "godot";
const GODOT_PROJECT: string = process.env.GODOT_PROJECT_PATH ?? "";
const NPM_TYPECHECK_COMMAND: string[] = process.platform === "win32"
	? ["cmd.exe", "/d", "/s", "/c", "npm", "run", "typecheck"]
	: ["npm", "run", "typecheck"];
const ALLOWED_WORKING_ROOTS: string[] = [
	path.resolve(BACKEND_DIR),
	...(GODOT_PROJECT.length > 0 ? [path.resolve(GODOT_PROJECT)] : [])
];

const COMMAND_PRESETS: CommandPreset[] = [
	{
		name: "backend.typecheck",
		description: "运行后端 TypeScript 类型检查 (tsc --noEmit)",
		command: NPM_TYPECHECK_COMMAND,
		workingDirectory: BACKEND_DIR,
		risk: "verify"
	},
	{
		name: "git.status",
		description: "显示 Git 工作区状态 (只读)",
		command: ["git", "status", "--short"],
		workingDirectory: BACKEND_DIR,
		risk: "read"
	},
	{
		name: "git.diff",
		description: "显示 Git 工作区差异 (只读)",
		command: ["git", "diff", "--stat"],
		workingDirectory: BACKEND_DIR,
		risk: "read"
	},
	{
		name: "git.init",
		description: "初始化 Git 仓库",
		command: ["git", "init"],
		workingDirectory: BACKEND_DIR,
		risk: "write"
	},
	{
		name: "godot.check_only",
		description: "运行 Godot 语法检查 (只读)。可传 resourcePath 精确检查 .gd 脚本或加载 .tscn 场景。",
		command: [GODOT_EXECUTABLE, "--headless", "--disable-crash-handler", "--path", GODOT_PROJECT, "--check-only", "--quit"],
		workingDirectory: GODOT_PROJECT || BACKEND_DIR,
		risk: "verify",
		requiresGodotProject: true,
		resourcePathMode: "optional"
	},
	{
		name: "godot.validate_scene",
		description: "验证指定场景文件的语法正确性 (只读)。必须传 resourcePath，例如 scenes/main.tscn。",
		command: [GODOT_EXECUTABLE, "--headless", "--disable-crash-handler", "--path", GODOT_PROJECT, "--check-only", "--quit"],
		workingDirectory: GODOT_PROJECT || BACKEND_DIR,
		risk: "verify",
		requiresGodotProject: true,
		resourcePathMode: "required"
	}
];

function truncateOutput(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) {
		return { text, truncated: false };
	}

	return {
		text: text.slice(0, maxChars) + `\n\n[输出已截断，原始长度 ${text.length} 字符]`,
		truncated: true
	};
}

async function runCommand(command: string[], cwd: string): Promise<{
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	truncated: boolean;
}> {
	return new Promise((resolve) => {
		const startMs: number = Date.now();
		let stdout: string = "";
		let stderr: string = "";
		let child: ChildProcess;

		try {
			child = spawn(command[0]!, command.slice(1), {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: COMMAND_TIMEOUT_MS
			});
		} catch (error: unknown) {
			resolve({
				exitCode: null,
				stdout,
				stderr: error instanceof Error ? `Process error: ${error.message}` : "Process spawn failed",
				durationMs: Date.now() - startMs,
				truncated: false
			});
			return;
		}

		child.stdout?.on("data", (data: Buffer): void => {
			stdout += data.toString("utf8");
		});

		child.stderr?.on("data", (data: Buffer): void => {
			stderr += data.toString("utf8");
		});

		child.on("error", (error: Error): void => {
			stderr += `\nProcess error: ${error.message}`;
			resolve({
				exitCode: null,
				stdout,
				stderr,
				durationMs: Date.now() - startMs,
				truncated: false
			});
		});

		child.on("close", (exitCode: number | null): void => {
			const stdoutResult = truncateOutput(stdout, MAX_STDOUT_CHARS);
			const stderrResult = truncateOutput(stderr, MAX_STDERR_CHARS);

			resolve({
				exitCode,
				stdout: stdoutResult.text,
				stderr: stderrResult.text,
				durationMs: Date.now() - startMs,
				truncated: stdoutResult.truncated || stderrResult.truncated
			});
		});
	});
}

function findPreset(name: string): CommandPreset {
	const preset: CommandPreset | undefined = COMMAND_PRESETS.find((p: CommandPreset): boolean => p.name === name);

	if (!preset) {
		throw new Error(`Unknown preset: ${name}. Available: ${COMMAND_PRESETS.map((p: CommandPreset): string => p.name).join(", ")}`);
	}

	return preset;
}

function asJsonTextResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [{
			type: "text",
			text: JSON.stringify(value, null, 2)
		}]
	};
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

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
	const relativePath: string = path.relative(rootPath, candidatePath);
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolveWorkingDirectory(workingDirectory: string | undefined, preset: CommandPreset): string {
	const requestedPath: string = workingDirectory ?? preset.workingDirectory;
	const resolvedPath: string = path.resolve(requestedPath);

	for (const allowedRoot of ALLOWED_WORKING_ROOTS) {
		if (isPathInsideRoot(resolvedPath, allowedRoot)) {
			return resolvedPath;
		}
	}

	throw new Error(`Working directory is outside allowed roots: ${resolvedPath}`);
}

function createMissingGodotProjectResult(presetName: string): { content: Array<{ type: "text"; text: string }> } {
	return asJsonTextResult({
		preset: presetName,
		ok: false,
		error: "GODOT_PROJECT_PATH is not configured for the terminal MCP server. Configure the Godot project path in the client and restart or reconnect the backend workspace before running Godot presets.",
		godotProjectPath: GODOT_PROJECT || null,
		godotExecutablePath: GODOT_EXECUTABLE
	});
}

function toProjectRelativePath(resourcePath: string): string {
	const trimmedPath: string = resourcePath.trim();
	if (trimmedPath.length === 0) {
		throw new Error("resourcePath cannot be empty");
	}

	if (GODOT_PROJECT.length === 0) {
		throw new Error("Cannot resolve resourcePath without GODOT_PROJECT_PATH");
	}

	const projectRoot: string = path.resolve(GODOT_PROJECT);
	if (trimmedPath.startsWith("res://")) {
		const relativePath: string = trimmedPath.slice("res://".length).replaceAll("\\", "/");
		const absolutePath: string = path.resolve(projectRoot, relativePath);
		if (!isPathInsideRoot(absolutePath, projectRoot)) {
			throw new Error(`resourcePath is outside the Godot project: ${trimmedPath}`);
		}

		return path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/");
	}

	if (path.isAbsolute(trimmedPath)) {
		const absolutePath: string = path.resolve(trimmedPath);
		if (!isPathInsideRoot(absolutePath, projectRoot)) {
			throw new Error(`resourcePath is outside the Godot project: ${absolutePath}`);
		}

		return path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/");
	}

	const relativePath: string = trimmedPath.replaceAll("\\", "/");
	const absolutePath: string = path.resolve(projectRoot, relativePath);
	if (!isPathInsideRoot(absolutePath, projectRoot)) {
		throw new Error(`resourcePath is outside the Godot project: ${trimmedPath}`);
	}

	return path.relative(projectRoot, absolutePath).replaceAll(path.sep, "/");
}

function toResPath(relativePath: string): string {
	return `res://${relativePath.replace(/^\/+/u, "")}`;
}

function createGodotResourceCommand(preset: CommandPreset, resourcePath: string | undefined): string[] {
	if (!preset.requiresGodotProject) {
		return preset.command;
	}

	if (GODOT_PROJECT.length === 0) {
		return preset.command;
	}

	const trimmedResourcePath: string = resourcePath?.trim() ?? "";
	if (preset.resourcePathMode === "required" && trimmedResourcePath.length === 0) {
		throw new Error(`Preset '${preset.name}' requires resourcePath`);
	}

	if (trimmedResourcePath.length === 0) {
		return preset.command;
	}

	const relativePath: string = toProjectRelativePath(trimmedResourcePath);
	const extension: string = path.extname(relativePath).toLowerCase();
	const resPath: string = toResPath(relativePath);

	if (extension === ".gd") {
		return [
			GODOT_EXECUTABLE,
			"--headless",
			"--disable-crash-handler",
			"--path", GODOT_PROJECT,
			"--script", resPath,
			"--check-only"
		];
	}

	if (extension === ".tscn" || extension === ".scn") {
		return [
			GODOT_EXECUTABLE,
			"--headless",
			"--disable-crash-handler",
			"--path", GODOT_PROJECT,
			resPath,
			"--quit-after", "1"
		];
	}

	throw new Error(`Unsupported Godot resourcePath extension for '${preset.name}': ${extension || "(none)"}. Use a .gd or .tscn file.`);
}

function describePresetCommand(command: string[]): string {
	return command.map((part: string): string => {
		if (!/[\s"]/u.test(part)) {
			return part;
		}

		return `"${part.replaceAll("\"", "\\\"")}"`;
	}).join(" ");
}

async function main(): Promise<void> {
	const server: McpServer = new McpServer({
		name: "terminal-mcp-server",
		version: "1.0.0"
	});

	server.registerTool(
		"get_terminal_capabilities",
		{
			title: "Get Terminal Capabilities",
			description: "返回当前终端 MCP 支持的所有预设命令列表及其风险等级。",
			inputSchema: z.object({})
		},
		async () => asJsonTextResult({
			presets: COMMAND_PRESETS.map((p: CommandPreset) => ({
				name: p.name,
				description: p.description,
				workingDirectory: p.workingDirectory,
				risk: p.risk,
				resourcePathMode: p.resourcePathMode ?? "none",
				godotProjectPath: p.requiresGodotProject ? GODOT_PROJECT || null : undefined,
				godotExecutablePath: p.requiresGodotProject ? GODOT_EXECUTABLE : undefined,
				command: p.requiresGodotProject ? describePresetCommand(p.command) : undefined
			}))
		})
	);

	server.registerTool(
		"run_safe_preset",
		{
			title: "Run Safe Command Preset",
			description: "执行安全的预设命令（read/verify 风险），自动允许。包括 git.status、git.diff、backend.typecheck、godot.check_only。Godot 预设可传 resourcePath 精确检查 .gd 或 .tscn。",
			inputSchema: z.object({
				presetName: z.string().min(1).describe("安全预设名称"),
				resourcePath: z.string().optional().describe("Godot 资源路径，可用 res://、项目相对路径或项目内绝对路径。例如 scripts/main.gd、scenes/main.tscn。"),
				workingDirectory: z.string().optional().describe("覆盖默认工作目录")
			})
		},
		async ({ presetName, workingDirectory, resourcePath }: SafePresetInput) => {
			const preset: CommandPreset = findPreset(presetName);

			if (preset.risk !== "read" && preset.risk !== "verify") {
				return asJsonTextResult({
					preset: presetName,
					ok: false,
					error: `Preset '${presetName}' has risk '${preset.risk}', not allowed via run_safe_preset. Use run_write_preset for write commands.`,
					requiredRisk: preset.risk
				});
			}

			if (preset.requiresGodotProject && GODOT_PROJECT.length === 0) {
				return createMissingGodotProjectResult(presetName);
			}

			let cwd: string;
			try {
				cwd = resolveWorkingDirectory(workingDirectory, preset);
			} catch (error: unknown) {
				return asJsonTextResult({
					preset: presetName,
					ok: false,
					error: error instanceof Error ? error.message : "Invalid working directory"
				});
			}

			let command: string[];
			try {
				command = createGodotResourceCommand(preset, resourcePath);
			} catch (error: unknown) {
				return asJsonTextResult({
					preset: presetName,
					ok: false,
					error: error instanceof Error ? error.message : "Invalid preset arguments",
					resourcePath: resourcePath ?? null,
					godotProjectPath: preset.requiresGodotProject ? GODOT_PROJECT || null : undefined,
					godotExecutablePath: preset.requiresGodotProject ? GODOT_EXECUTABLE : undefined
				});
			}

			const result = await runCommand(command, cwd);

			return asJsonTextResult({
				preset: presetName,
				ok: result.exitCode === 0,
				exitCode: result.exitCode,
				command,
				commandLine: describePresetCommand(command),
				cwd,
				resourcePath: resourcePath ?? null,
				godotProjectPath: preset.requiresGodotProject ? GODOT_PROJECT || null : undefined,
				godotExecutablePath: preset.requiresGodotProject ? GODOT_EXECUTABLE : undefined,
				stdout: result.stdout,
				stderr: result.stderr,
				durationMs: result.durationMs,
				truncated: result.truncated
			});
		}
	);

	server.registerTool(
		"run_write_preset",
		{
			title: "Run Write Command Preset",
			description: "执行写操作预设命令（write 风险），需要通过审批系统批准。可用的写预设：git.init。破坏性预设会被直接拒绝。",
			inputSchema: z.object({
				presetName: z.string().min(1).describe("写操作预设名称"),
				workingDirectory: z.string().optional().describe("覆盖默认工作目录")
			})
		},
		async ({ presetName, workingDirectory }) => {
			const preset: CommandPreset = findPreset(presetName);

			if (preset.risk === "destructive") {
				return asJsonTextResult({
					preset: presetName,
					ok: false,
					error: `Preset '${presetName}' has destructive risk and is permanently forbidden.`
				});
			}

			if (preset.risk !== "write") {
				return asJsonTextResult({
					preset: presetName,
					ok: false,
					error: `Preset '${presetName}' has risk '${preset.risk}', use run_safe_preset instead.`
				});
			}

			let cwd: string;
			try {
				cwd = resolveWorkingDirectory(workingDirectory, preset);
			} catch (error: unknown) {
				return asJsonTextResult({
					preset: presetName,
					ok: false,
					error: error instanceof Error ? error.message : "Invalid working directory"
				});
			}

			const result = await runCommand(preset.command, cwd);

			return asJsonTextResult({
				preset: presetName,
				ok: result.exitCode === 0,
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
				durationMs: result.durationMs,
				truncated: result.truncated
			});
		}
	);

	server.registerTool(
		"run_godot_scene_script",
		{
			title: "Run Godot Scene Script",
			description: "通过 Godot headless 模式调用 scene_operator.gd 执行场景操作（创建场景、添加节点、挂载脚本、连接信号、查看场景树）。操作通过审批后实际写入磁盘。接受的 operation JSON 格式示例：{\"operation\":\"create_scene\",\"path\":\"scenes/foo.tscn\",\"root_type\":\"Node2D\",\"root_name\":\"Main\"}。支持的操作：create_scene、add_node、attach_script、connect_signal、inspect。",
			inputSchema: z.object({
				operationJson: z.string().min(1).describe("JSON 格式的场景操作，包含 operation 字段和对应参数")
			})
		},
		async ({ operationJson }) => {
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
			const command: string[] = [
				GODOT_EXECUTABLE,
				"--headless",
				"--disable-crash-handler",
				"--path", GODOT_PROJECT,
				"--script", scriptPath,
				"--", operationJson
			];

			const cwd: string = GODOT_PROJECT.length > 0 ? path.resolve(GODOT_PROJECT) : BACKEND_DIR;

			if (!isPathInsideRoot(cwd, ALLOWED_WORKING_ROOTS[0] ?? BACKEND_DIR) && !(ALLOWED_WORKING_ROOTS.length > 1 && isPathInsideRoot(cwd, ALLOWED_WORKING_ROOTS[1]!))) {
				return asJsonTextResult({ ok: false, error: "Godot project path is outside allowed roots" });
			}

			const result = await runCommand(command, cwd);

			// Godot may print banners or warnings before/after the script result.
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

	const transport: StdioServerTransport = new StdioServerTransport();
	await server.connect(transport);

	console.error(`Terminal MCP Server started`);
}

main().catch((error: unknown): void => {
	console.error("Terminal MCP server fatal error:", error);
	process.exit(1);
});
