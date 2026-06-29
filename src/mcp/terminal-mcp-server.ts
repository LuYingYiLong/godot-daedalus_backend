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
		description: "运行 Godot 全项目脚本语法检查 (只读)",
		command: [GODOT_EXECUTABLE, "--headless", "--disable-crash-handler", "--path", GODOT_PROJECT, "--check-only", "--quit"],
		workingDirectory: GODOT_PROJECT || BACKEND_DIR,
		risk: "verify"
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
				risk: p.risk
			}))
		})
	);

	server.registerTool(
		"run_safe_preset",
		{
			title: "Run Safe Command Preset",
			description: "执行安全的预设命令（read/verify 风险），自动允许。包括 git.status、git.diff、backend.typecheck、godot.check_only。",
			inputSchema: z.object({
				presetName: z.string().min(1).describe("安全预设名称"),
				workingDirectory: z.string().optional().describe("覆盖默认工作目录")
			})
		},
		async ({ presetName, workingDirectory }) => {
			const preset: CommandPreset = findPreset(presetName);

			if (preset.risk !== "read" && preset.risk !== "verify") {
				return asJsonTextResult({
					preset: presetName,
					ok: false,
					error: `Preset '${presetName}' has risk '${preset.risk}', not allowed via run_safe_preset. Use run_write_preset for write commands.`,
					requiredRisk: preset.risk
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

	const transport: StdioServerTransport = new StdioServerTransport();
	await server.connect(transport);

	console.error(`Terminal MCP Server started`);
}

main().catch((error: unknown): void => {
	console.error("Terminal MCP server fatal error:", error);
	process.exit(1);
});
