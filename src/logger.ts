import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { getDaedalusDir } from "./app-paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

type LogRecord = {
	ts: string;
	level: LogLevel;
	area: string;
	event: string;
	message?: string | undefined;
	data?: unknown;
	error?: unknown;
};

const LEVEL_PRIORITIES: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};

const MAX_STRING_LENGTH: number = 2000;
const MAX_ARRAY_LENGTH: number = 50;
const MAX_OBJECT_KEYS: number = 80;
const REDACTED: string = "[redacted]";

let stream: WriteStream | null | undefined;
let streamPath: string | null | undefined;
let processHandlersInstalled: boolean = false;

function parseLevel(value: string | undefined): LogLevel {
	if (value === "debug" || value === "info" || value === "warn" || value === "error") {
		return value;
	}

	return "info";
}

function shouldWriteLevel(level: LogLevel): boolean {
	const configuredLevel: LogLevel = parseLevel(process.env.DAEDALUS_LOG_LEVEL);
	return LEVEL_PRIORITIES[level] >= LEVEL_PRIORITIES[configuredLevel];
}

function shouldLogToConsole(): boolean {
	if (process.env.NODE_TEST_CONTEXT !== undefined && process.env.DAEDALUS_LOG_CONSOLE === undefined) {
		return false;
	}

	return process.env.DAEDALUS_LOG_CONSOLE !== "0";
}

function getLogDateStamp(date: Date = new Date()): string {
	return date.toISOString().slice(0, 10);
}

function resolveLogDir(): string | null {
	const override: string | undefined = process.env.DAEDALUS_LOG_DIR;
	if (override !== undefined && override.trim().length > 0) {
		return override;
	}

	try {
		return join(getDaedalusDir(), "logs");
	} catch {
		return null;
	}
}

function createLogStream(): WriteStream | null {
	if (stream !== undefined) {
		return stream;
	}

	const logDir: string | null = resolveLogDir();
	if (logDir === null) {
		stream = null;
		streamPath = null;
		return null;
	}

	mkdirSync(logDir, { recursive: true });
	streamPath = join(logDir, `backend-${getLogDateStamp()}.log`);
	stream = createWriteStream(streamPath, { flags: "a", encoding: "utf8" });
	stream.on("error", (error: Error): void => {
		stream = null;
		// 这里保留 stderr，因为 logger 自身失效时不能再递归调用 logger。
		console.error("[logger] failed to write backend log:", error.message);
	});
	return stream;
}

function isSensitiveKey(key: string): boolean {
	return /api[_-]?key|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|passwd|bearer|cookie|set-cookie/i.test(key);
}

function clipString(value: string): string {
	if (value.length <= MAX_STRING_LENGTH) {
		return value;
	}

	return `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

export function redactForLog(value: unknown, keyHint: string = "", depth: number = 0): unknown {
	if (keyHint.length > 0 && isSensitiveKey(keyHint)) {
		return REDACTED;
	}
	if (value === null || value === undefined) {
		return value;
	}
	if (typeof value === "string") {
		if (/^Bearer\s+/i.test(value)) {
			return REDACTED;
		}
		return clipString(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: clipString(value.message),
			stack: value.stack === undefined ? undefined : clipString(value.stack)
		};
	}
	if (depth >= 6) {
		return "[depth-limit]";
	}
	if (Array.isArray(value)) {
		const items: unknown[] = value
			.slice(0, MAX_ARRAY_LENGTH)
			.map((item: unknown): unknown => redactForLog(item, keyHint, depth + 1));
		if (value.length > MAX_ARRAY_LENGTH) {
			items.push(`[truncated ${value.length - MAX_ARRAY_LENGTH} items]`);
		}
		return items;
	}
	if (typeof value === "object") {
		const source: Record<string, unknown> = value as Record<string, unknown>;
		const entries: Array<[string, unknown]> = Object.entries(source).slice(0, MAX_OBJECT_KEYS);
		const result: Record<string, unknown> = {};
		for (const [key, item] of entries) {
			result[key] = redactForLog(item, key, depth + 1);
		}
		if (Object.keys(source).length > MAX_OBJECT_KEYS) {
			result.__truncatedKeys = Object.keys(source).length - MAX_OBJECT_KEYS;
		}
		return result;
	}

	return inspect(value, { depth: 2 });
}

function writeRecord(record: LogRecord): void {
	const redactedRecord: LogRecord = {
		...record,
		data: record.data === undefined ? undefined : redactForLog(record.data),
		error: record.error === undefined ? undefined : redactForLog(record.error)
	};
	const line: string = `${JSON.stringify(redactedRecord)}\n`;
	const logStream: WriteStream | null = createLogStream();
	if (logStream !== null) {
		logStream.write(line);
	}
	if (!shouldLogToConsole()) {
		return;
	}

	const consoleLine: string = `[${redactedRecord.ts}] ${redactedRecord.level.toUpperCase()} ${redactedRecord.area}.${redactedRecord.event}${redactedRecord.message === undefined ? "" : ` ${redactedRecord.message}`}`;
	if (record.level === "error") {
		console.error(consoleLine);
	} else if (record.level === "warn") {
		console.warn(consoleLine);
	} else {
		console.log(consoleLine);
	}
}

export function log(level: LogLevel, area: string, event: string, data?: LogContext, message?: string): void {
	if (!shouldWriteLevel(level)) {
		return;
	}

	writeRecord({
		ts: new Date().toISOString(),
		level,
		area,
		event,
		message,
		data
	});
}

export const logger = {
	debug(area: string, event: string, data?: LogContext, message?: string): void {
		log("debug", area, event, data, message);
	},
	info(area: string, event: string, data?: LogContext, message?: string): void {
		log("info", area, event, data, message);
	},
	warn(area: string, event: string, data?: LogContext, message?: string): void {
		log("warn", area, event, data, message);
	},
	error(area: string, event: string, error: unknown, data?: LogContext, message?: string): void {
		if (!shouldWriteLevel("error")) {
			return;
		}

		writeRecord({
			ts: new Date().toISOString(),
			level: "error",
			area,
			event,
			message,
			data,
			error
		});
	}
};

export function getCurrentBackendLogPath(): string | null {
	createLogStream();
	return streamPath ?? null;
}

export function installProcessLogHandlers(): void {
	if (processHandlersInstalled) {
		return;
	}

	processHandlersInstalled = true;
	process.on("uncaughtException", (error: Error): void => {
		logger.error("process", "uncaught_exception", error);
	});
	process.on("unhandledRejection", (reason: unknown): void => {
		logger.error("process", "unhandled_rejection", reason);
	});
}
