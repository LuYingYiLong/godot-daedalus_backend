import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { asJsonTextResult, getGodotUserDataDir, getProjectNameForUserData, isPathInsideRoot, parseProjectSettingBoolean, parseProjectSettingInteger, parseProjectSettingString, readProjectConfig, redactOnePath, redactSensitivePaths, resolveGodotPath, type ResolvedGodotPath } from "./context.js";

const MAX_PROJECT_LOG_BYTES: number = 256 * 1024;
const DEFAULT_PROJECT_LOG_LINES: number = 200;
const MAX_PROJECT_LOG_LINES: number = 1000;
const DEFAULT_GODOT_LOG_PATH: string = "user://logs/godot.log";
const DEFAULT_GODOT_LOG_MAX_FILES: number = 5;

export type ProjectLogConfig = {
	projectName: string;
	userDataDir: string;
	logPath: string;
	logPathSource: "project" | "default";
	absolutePath: string;
	logDirectory: string;
	fileLoggingEnabled: boolean;
	fileLoggingEnabledSource: "project" | "default_pc";
	maxLogFiles: number;
	maxLogFilesSource: "project" | "default";
	pathKind: ResolvedGodotPath["kind"];
	resolutionNote: string;
};

export type ProjectLogFile = {
	fileName: string;
	absolutePath: string;
	size: number;
	modifiedAt: string;
};

async function getProjectLogConfig(): Promise<ProjectLogConfig> {
	const config: Record<string, string> = await readProjectConfig();
	const projectName: string = getProjectNameForUserData(config);
	const userDataDir: string = getGodotUserDataDir(config);
	const configuredLogPath: string | undefined = parseProjectSettingString(config["debug/file_logging/log_path"]);
	const logPath: string = configuredLogPath ?? DEFAULT_GODOT_LOG_PATH;
	const resolvedPath: ResolvedGodotPath = resolveGodotPath(logPath, config);
	const hasExplicitFileLogging: boolean = config["debug/file_logging/enable_file_logging"] !== undefined
		|| config["debug/file_logging/enable_file_logging.pc"] !== undefined;
	const fileLoggingEnabled: boolean = parseProjectSettingBoolean(
		config["debug/file_logging/enable_file_logging.pc"] ?? config["debug/file_logging/enable_file_logging"],
		true
	);
	const configuredMaxLogFiles: string | undefined = config["debug/file_logging/max_log_files"];
	const maxLogFiles: number = Math.max(0, parseProjectSettingInteger(configuredMaxLogFiles, DEFAULT_GODOT_LOG_MAX_FILES));

	return {
		projectName,
		userDataDir,
		logPath,
		logPathSource: configuredLogPath === undefined ? "default" : "project",
		absolutePath: resolvedPath.absolutePath,
		logDirectory: path.dirname(resolvedPath.absolutePath),
		fileLoggingEnabled,
		fileLoggingEnabledSource: hasExplicitFileLogging ? "project" : "default_pc",
		maxLogFiles,
		maxLogFilesSource: configuredMaxLogFiles === undefined ? "default" : "project",
		pathKind: resolvedPath.kind,
		resolutionNote: "Godot 的 user:// 会解析到 OS.get_user_data_dir()；当前 Windows 项目默认位于 %APPDATA%/Godot/app_userdata/<application/config/name>。"
	};
}

async function listProjectLogFiles(): Promise<{ config: ProjectLogConfig; logs: ProjectLogFile[] }> {
	const config: ProjectLogConfig = await getProjectLogConfig();
	const baseName: string = path.basename(config.absolutePath);
	const extension: string = path.extname(baseName) || ".log";
	const stem: string = baseName.endsWith(extension) ? baseName.slice(0, -extension.length) : baseName;

	let entries: Dirent[];
	try {
		entries = await fs.readdir(config.logDirectory, { withFileTypes: true });
	} catch {
		return { config, logs: [] };
	}

	const logs: ProjectLogFile[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}

		const fileName: string = entry.name;
		if (fileName !== baseName && (!fileName.startsWith(stem) || !fileName.endsWith(extension))) {
			continue;
		}

		const absolutePath: string = path.resolve(config.logDirectory, fileName);
		if (!isPathInsideRoot(absolutePath, config.logDirectory)) {
			continue;
		}

		const stat = await fs.stat(absolutePath);
		logs.push({
			fileName,
			absolutePath,
			size: stat.size,
			modifiedAt: stat.mtime.toISOString()
		});
	}

	logs.sort((left: ProjectLogFile, right: ProjectLogFile): number =>
		Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt)
	);
	return { config, logs };
}

async function readFileTail(absolutePath: string, maxBytes: number): Promise<{ text: string; bytesRead: number; truncatedBytes: boolean }> {
	const stat = await fs.stat(absolutePath);
	const bytesToRead: number = Math.min(stat.size, maxBytes);
	const start: number = Math.max(0, stat.size - bytesToRead);
	const handle = await fs.open(absolutePath, "r");

	try {
		const buffer: Buffer = Buffer.alloc(bytesToRead);
		await handle.read(buffer, 0, bytesToRead, start);
		let text: string = buffer.toString("utf8");
		if (start > 0) {
			const firstNewlineIndex: number = text.indexOf("\n");
			if (firstNewlineIndex >= 0) {
				text = text.slice(firstNewlineIndex + 1);
			}
		}

		return {
			text,
			bytesRead: bytesToRead,
			truncatedBytes: stat.size > bytesToRead
		};
	} finally {
		await handle.close();
	}
}

async function readProjectLog(fileName: string | undefined, lines: number | undefined): Promise<Record<string, unknown>> {
	const { config, logs } = await listProjectLogFiles();
	const requestedLines: number = Math.max(1, Math.min(MAX_PROJECT_LOG_LINES, Math.floor(lines ?? DEFAULT_PROJECT_LOG_LINES)));
	const baseName: string = path.basename(config.absolutePath);
	let selectedLog: ProjectLogFile | undefined;

	if (fileName !== undefined && fileName.trim().length > 0) {
		const normalizedFileName: string = path.basename(fileName.trim());
		if (normalizedFileName !== fileName.trim() || normalizedFileName.includes("/") || normalizedFileName.includes("\\")) {
			throw new Error("fileName must be a plain log file name from mcp_godot_list_project_logs");
		}

		selectedLog = logs.find((log: ProjectLogFile): boolean => log.fileName === normalizedFileName);
	} else {
		selectedLog = logs.find((log: ProjectLogFile): boolean => log.fileName === baseName) ?? logs[0];
	}

	if (selectedLog === undefined) {
		return {
			ok: false,
			message: "No Godot project log file found.",
			config,
			logs
		};
	}

	const absolutePath: string = path.resolve(config.logDirectory, selectedLog.fileName);
	if (!isPathInsideRoot(absolutePath, config.logDirectory)) {
		throw new Error(`Log path traversal denied: ${selectedLog.fileName}`);
	}

	const tail = await readFileTail(absolutePath, MAX_PROJECT_LOG_BYTES);
	const allLines: string[] = tail.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const selectedLines: string[] = allLines.slice(-requestedLines);

	return {
		ok: true,
		fileName: selectedLog.fileName,
		absolutePath,
		logPath: config.logPath,
		lines: selectedLines,
		lineCount: selectedLines.length,
		requestedLines,
		bytesRead: tail.bytesRead,
		truncatedBytes: tail.truncatedBytes,
		config,
		resolutionNote: config.resolutionNote
	};
}

export function registerProjectLogTools(server: McpServer): void {
server.registerTool(
		"get_project_log_config",
		{
			title: "Get Godot Project Log Config",
			description: "读取 Godot 项目日志配置，解析 debug/file_logging/log_path。缺省为 user://logs/godot.log，并返回 user:// 对应的真实系统路径。",
			inputSchema: z.object({})
		},
		async () => asJsonTextResult(await getProjectLogConfig())
	);

server.registerTool(
		"list_project_logs",
		{
			title: "List Godot Project Logs",
			description: "列出当前 Godot 项目日志目录中的 godot.log 和轮转日志。遇到 user:// 路径时会先按 Godot 规则解析到真实系统路径。",
			inputSchema: z.object({})
		},
		async () => asJsonTextResult(await listProjectLogFiles())
	);

server.registerTool(
		"read_project_log",
		{
			title: "Read Godot Project Log",
			description: "读取当前 Godot 项目日志尾部。默认读取 godot.log；如果不存在则读取最新轮转日志。只允许读取日志目录内的 .log 文件。",
			inputSchema: z.object({
				fileName: z.string().optional().describe("可选，来自 list_project_logs 的纯文件名，例如 godot.log"),
				lines: z.number().int().positive().max(MAX_PROJECT_LOG_LINES).optional().describe(`读取尾部行数，默认 ${DEFAULT_PROJECT_LOG_LINES}，最多 ${MAX_PROJECT_LOG_LINES}`)
			})
		},
		async ({ fileName, lines }) => asJsonTextResult(await readProjectLog(fileName, lines))
	);

}
