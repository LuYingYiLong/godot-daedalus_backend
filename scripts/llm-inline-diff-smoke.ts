import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";

type ProviderId = "deepseek" | "moonshot" | "openai";
type JsonObject = Record<string, unknown>;
type ServerResponse = {
	type: "response";
	id: string;
	ok: boolean;
	result?: unknown;
	error?: {
		code: string;
		message: string;
	};
};
type ServerEvent = {
	type: "event";
	id: string;
	event: string;
	data?: unknown;
};
type ServerMessage = ServerResponse | ServerEvent;
type MessagePredicate = (message: ServerMessage) => boolean;

type CliOptions = {
	useLlm: boolean;
	dryRun: boolean;
	help: boolean;
	startBackend: boolean;
	keepBackend: boolean;
	provider: ProviderId;
	modelId: string;
	projectPath: string;
	godotExecutablePath?: string | undefined;
	backendUrl: string;
	port: number;
	baseUrl?: string | undefined;
	apiKeyEnv?: string | undefined;
	timeoutMs: number;
	targetPath: string;
};

type StartedBackend = {
	process: ChildProcess;
	stdoutLog: string;
	stderrLog: string;
};

const DEFAULT_MODELS: Record<ProviderId, string> = {
	deepseek: "deepseek-v4-pro",
	moonshot: "kimi-k2.7-code",
	openai: "gpt-5.5"
};

const DEFAULT_PROJECT_PATH: string = "D:\\GodotProjects\\example";
const DEFAULT_PORT: number = 38182;
const DEFAULT_TIMEOUT_MS: number = 240_000;
const ALLOWED_SMOKE_WRITE_TOOLS: Set<string> = new Set([
	"mcp_godot_create_text_file",
	"mcp_godot_overwrite_text_file",
	"mcp_godot_replace_text_in_file",
	"mcp_godot_delete_file"
]);

function getEnv(name: string): string | undefined {
	const value: string | undefined = process.env[name];
	const trimmed: string | undefined = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeArgName(name: string): string {
	return name.replace(/^--?/u, "").replaceAll("-", "_").toLowerCase();
}

function parseRawArgs(argv: string[]): Map<string, string | boolean> {
	const values: Map<string, string | boolean> = new Map();
	for (const rawArg of argv) {
		if (rawArg.trim().length === 0) {
			continue;
		}

		const equalsIndex: number = rawArg.indexOf("=");
		if (equalsIndex >= 0) {
			const name: string = normalizeArgName(rawArg.slice(0, equalsIndex));
			const value: string = rawArg.slice(equalsIndex + 1);
			values.set(name, value);
			continue;
		}

		values.set(normalizeArgName(rawArg), true);
	}

	return values;
}

function parseBoolean(value: string | boolean | undefined, defaultValue: boolean): boolean {
	if (value === undefined) {
		return defaultValue;
	}
	if (typeof value === "boolean") {
		return value;
	}
	const normalized: string = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseInteger(value: string | boolean | undefined, defaultValue: number, label: string): number {
	if (value === undefined || typeof value === "boolean") {
		return defaultValue;
	}
	const parsed: number = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Invalid ${label}: ${value}`);
	}
	return parsed;
}

function parseProvider(value: string | boolean | undefined): ProviderId {
	if (typeof value !== "string" || value.trim().length === 0) {
		return "deepseek";
	}
	const normalized: string = value.trim().toLowerCase();
	if (normalized === "deepseek" || normalized === "moonshot" || normalized === "openai") {
		return normalized;
	}
	throw new Error(`Invalid provider: ${value}`);
}

function getStringArg(values: Map<string, string | boolean>, ...names: string[]): string | undefined {
	for (const name of names) {
		const value: string | boolean | undefined = values.get(name);
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function createDefaultTargetPath(): string {
	return `scripts/daedalus_inline_diff_smoke_${Date.now().toString(36)}.gd`;
}

function parseOptions(argv: string[]): CliOptions {
	const values: Map<string, string | boolean> = parseRawArgs(argv);
	const help: boolean = values.has("help") || values.has("h");
	const dryRun: boolean = parseBoolean(values.get("dry_run") ?? values.get("dryrun"), false);
	const useLlm: boolean = values.has("use_llm") || values.has("usellm") || parseBoolean(values.get("llm"), false);
	const provider: ProviderId = parseProvider(getStringArg(values, "provider"));
	const modelId: string = getStringArg(values, "model_id", "model")
		?? getEnv("DAEDALUS_MODEL_ID")
		?? getEnv(`${provider.toUpperCase()}_MODEL`)
		?? DEFAULT_MODELS[provider];
	const projectPath: string = path.resolve(
		getStringArg(values, "project", "project_path", "godot_project_path")
			?? getEnv("GODOT_PROJECT_PATH")
			?? DEFAULT_PROJECT_PATH
	);
	const port: number = parseInteger(values.get("port"), Number.parseInt(getEnv("PORT") ?? String(DEFAULT_PORT), 10), "port");
	const backendUrl: string = getStringArg(values, "url", "backend_url") ?? `ws://localhost:${port}`;
	const timeoutMs: number = parseInteger(
		values.get("timeout_ms"),
		parseInteger(values.get("timeout_seconds"), DEFAULT_TIMEOUT_MS / 1000, "timeout_seconds") * 1000,
		"timeout_ms"
	);

	if (values.has("api_key") || values.has("api_key_value")) {
		throw new Error("Do not pass API keys as command arguments. Use api_key_env=NAME or DAEDALUS_<PROVIDER>_API_KEY instead.");
	}

	return {
		useLlm,
		dryRun,
		help,
		startBackend: !parseBoolean(values.get("no_start_backend"), false),
		keepBackend: parseBoolean(values.get("keep_backend"), false),
		provider,
		modelId,
		projectPath,
		godotExecutablePath: getStringArg(values, "godot", "godot_executable_path") ?? getEnv("GODOT_EXECUTABLE_PATH"),
		backendUrl,
		port,
		baseUrl: getStringArg(values, "base_url", "baseurl") ?? getEnv(`${provider.toUpperCase()}_BASE_URL`),
		apiKeyEnv: getStringArg(values, "api_key_env"),
		timeoutMs,
		targetPath: (getStringArg(values, "target", "target_path") ?? createDefaultTargetPath()).replaceAll("\\", "/")
	};
}

function printHelp(): void {
	console.log(`Godot Daedalus real LLM inline diff smoke

Usage:
  npm run dev:llm -- model_id=deepseek-v4-pro
  npm run smoke:llm -- use_llm provider=deepseek model_id=deepseek-v4-pro project=D:\\GodotProjects\\example

Options:
  use_llm                         Required by smoke:llm to allow a real provider call.
  provider=deepseek|moonshot|openai
  model_id=<model>
  project=<Godot project path>
  target_path=scripts/file.gd      Default is a timestamped smoke file.
  port=38182                      Used when starting a temporary backend.
  backend_url=ws://localhost:38180 Connect to an existing backend.
  no_start_backend                Do not start a temporary backend.
  keep_backend                    Leave the temporary backend running after the smoke.
  api_key_env=NAME                Read API key from a specific environment variable.

API key lookup:
  DAEDALUS_<PROVIDER>_API_KEY, then <PROVIDER>_API_KEY. If no env key is found,
  the script uses existing keytar provider config and only selects provider/model.
`);
}

function resolveApiKey(options: CliOptions): string | undefined {
	if (options.apiKeyEnv !== undefined) {
		return getEnv(options.apiKeyEnv);
	}

	const prefix: string = options.provider.toUpperCase();
	const candidates: string[] = [
		`DAEDALUS_${prefix}_API_KEY`,
		`${prefix}_API_KEY`
	];
	for (const candidate of candidates) {
		const value: string | undefined = getEnv(candidate);
		if (value !== undefined) {
			return value;
		}
	}

	return undefined;
}

function isRecord(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function isPathInsideRoot(absolutePath: string, rootPath: string): boolean {
	const relativePath: string = path.relative(rootPath, absolutePath);
	return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolveTargetAbsolutePath(projectPath: string, targetPath: string): string {
	const absolutePath: string = path.resolve(projectPath, targetPath);
	if (!isPathInsideRoot(absolutePath, projectPath)) {
		throw new Error(`Target path escapes project root: ${targetPath}`);
	}
	return absolutePath;
}

function createSmokePrompt(targetPath: string): string {
	const content: string = [
		"extends Node",
		"",
		"const DAEDALUS_INLINE_DIFF_SMOKE: bool = true",
		"const DAEDALUS_INLINE_DIFF_MESSAGE: String = \"inline diff smoke\"",
		"",
		"func _ready() -> void:",
		"\tprint(DAEDALUS_INLINE_DIFF_MESSAGE)",
		""
	].join("\n");

	return [
		"执行 Godot Daedalus 真实 LLM inline diff smoke。请严格只做下面这一个文件写入动作。",
		`调用 mcp_godot_create_text_file 创建 ${targetPath}。`,
		"文件内容必须完整写成：",
		"```gdscript",
		content,
		"```",
		"不要读取、创建或修改任何其他文件。不要使用 propose 工具。写入成功后用一句话说明完成。"
	].join("\n");
}

function startBackend(options: CliOptions): StartedBackend {
	const logDir: string = path.join(tmpdir(), "godot-daedalus-llm-smoke");
	mkdirSync(logDir, { recursive: true });
	const stamp: string = new Date().toISOString().replaceAll(":", "").replaceAll(".", "-");
	const stdoutLog: string = path.join(logDir, `backend-${stamp}.stdout.log`);
	const stderrLog: string = path.join(logDir, `backend-${stamp}.stderr.log`);
	const stdoutStream = createWriteStream(stdoutLog, { encoding: "utf8" });
	const stderrStream = createWriteStream(stderrLog, { encoding: "utf8" });
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PORT: String(options.port),
		GODOT_PROJECT_PATH: options.projectPath
	};
	if (options.godotExecutablePath !== undefined) {
		env.GODOT_EXECUTABLE_PATH = options.godotExecutablePath;
	}

	const backendProcess: ChildProcess = spawn(
		process.execPath,
		["--import", "tsx", "src/main.ts"],
		{
			cwd: process.cwd(),
			env,
			stdio: ["ignore", "pipe", "pipe"]
		}
	);
	backendProcess.stdout?.pipe(stdoutStream);
	backendProcess.stderr?.pipe(stderrStream);
	return {
		process: backendProcess,
		stdoutLog,
		stderrLog
	};
}

async function stopBackend(startedBackend: StartedBackend | null): Promise<void> {
	if (startedBackend === null || startedBackend.process.killed || startedBackend.process.exitCode !== null) {
		return;
	}

	await new Promise<void>((resolve: () => void): void => {
		const timeout = setTimeout(resolve, 2_000);
		startedBackend.process.once("exit", (): void => {
			clearTimeout(timeout);
			resolve();
		});
		startedBackend.process.kill();
	});
}

class RpcClient {
	private socket: WebSocket | null = null;
	private sequence: number = 0;
	private readonly pending: Map<string, {
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
		timeout: NodeJS.Timeout;
	}> = new Map();
	private readonly waiters: Set<{
		predicate: MessagePredicate;
		resolve: (message: ServerMessage) => void;
		reject: (error: Error) => void;
		timeout: NodeJS.Timeout;
	}> = new Set();
	private readonly messages: ServerMessage[] = [];
	private fatalError: Error | null = null;

	constructor(private readonly url: string) {}

	async connect(timeoutMs: number = 10_000): Promise<void> {
		await new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
			const socket: WebSocket = new WebSocket(this.url);
			const timeout = setTimeout((): void => {
				socket.close();
				reject(new Error(`Timed out connecting to ${this.url}`));
			}, timeoutMs);

			socket.once("open", (): void => {
				clearTimeout(timeout);
				this.socket = socket;
				socket.on("message", (data: WebSocket.RawData): void => {
					this.handleRawMessage(data);
				});
				socket.on("error", (error: Error): void => {
					this.reportFatal(error);
				});
				socket.on("close", (): void => {
					if (this.fatalError === null) {
						this.reportFatal(new Error("WebSocket closed"));
					}
				});
				resolve();
			});
			socket.once("error", (error: Error): void => {
				clearTimeout(timeout);
				reject(error);
			});
		});
	}

	close(): void {
		this.socket?.close();
		this.socket = null;
	}

	reportFatal(error: Error): void {
		if (this.fatalError !== null) {
			return;
		}
		this.fatalError = error;
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timeout);
			waiter.reject(error);
		}
		this.waiters.clear();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private handleRawMessage(data: WebSocket.RawData): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data.toString("utf8"));
		} catch (error: unknown) {
			this.reportFatal(error instanceof Error ? error : new Error("Invalid JSON from backend"));
			return;
		}
		if (!isRecord(parsed) || typeof parsed.type !== "string") {
			return;
		}

		const message: ServerMessage = parsed as ServerMessage;
		this.messages.push(message);
		if (message.type === "response") {
			const pending = this.pending.get(message.id);
			if (pending !== undefined) {
				this.pending.delete(message.id);
				clearTimeout(pending.timeout);
				if (message.ok) {
					pending.resolve(message.result);
				} else {
					pending.reject(new Error(message.error?.message ?? "Request failed"));
				}
			}
		}

		for (const waiter of Array.from(this.waiters)) {
			if (waiter.predicate(message)) {
				this.waiters.delete(waiter);
				clearTimeout(waiter.timeout);
				waiter.resolve(message);
			}
		}
	}

	sendRequest(method: string, params?: JsonObject | undefined, timeoutMs: number = 30_000): Promise<unknown> {
		if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket is not connected");
		}

		const id: string = `llm-smoke-${++this.sequence}`;
		const request: JsonObject = {
			type: "request",
			id,
			method
		};
		if (params !== undefined) {
			request.params = params;
		}
		return new Promise<unknown>((resolve: (value: unknown) => void, reject: (error: Error) => void): void => {
			if (this.fatalError !== null) {
				reject(this.fatalError);
				return;
			}
			const timeout = setTimeout((): void => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
			this.socket?.send(JSON.stringify(request));
		});
	}

	sendRequestNoWait(method: string, params?: JsonObject | undefined): string {
		if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket is not connected");
		}

		const id: string = `llm-smoke-${++this.sequence}`;
		const request: JsonObject = {
			type: "request",
			id,
			method
		};
		if (params !== undefined) {
			request.params = params;
		}
		this.socket.send(JSON.stringify(request));
		return id;
	}

	waitForMessage(predicate: MessagePredicate, timeoutMs: number): Promise<ServerMessage> {
		for (const message of this.messages) {
			if (predicate(message)) {
				return Promise.resolve(message);
			}
		}
		return new Promise<ServerMessage>((resolve: (message: ServerMessage) => void, reject: (error: Error) => void): void => {
			if (this.fatalError !== null) {
				reject(this.fatalError);
				return;
			}
			const timeout = setTimeout((): void => {
				this.waiters.delete(waiter);
				reject(new Error("Timed out waiting for backend event"));
			}, timeoutMs);
			const waiter = { predicate, resolve, reject, timeout };
			this.waiters.add(waiter);
		});
	}
}

async function waitForBackend(url: string, timeoutMs: number, startedBackend: StartedBackend | null): Promise<void> {
	const deadline: number = Date.now() + timeoutMs;
	let lastError: Error | null = null;
	while (Date.now() < deadline) {
		if (startedBackend !== null && startedBackend.process.exitCode !== null) {
			throw new Error(`Backend exited before becoming healthy. Logs: ${startedBackend.stdoutLog} ; ${startedBackend.stderrLog}`);
		}

		const client: RpcClient = new RpcClient(url);
		try {
			await client.connect(1_500);
			await client.sendRequest("ping", {}, 1_500);
			client.close();
			return;
		} catch (error: unknown) {
			lastError = error instanceof Error ? error : new Error("Backend health check failed");
			client.close();
			await new Promise<void>((resolve: () => void): NodeJS.Timeout => setTimeout(resolve, 500));
		}
	}

	throw new Error(`Backend did not become healthy: ${lastError?.message ?? "timeout"}`);
}

function findBatchInEvent(message: ServerMessage, targetPath: string): JsonObject | null {
	if (message.type !== "event" || message.event !== "agent.tool.result" || !isRecord(message.data)) {
		return null;
	}

	const batch: unknown = message.data.fileEditBatch;
	if (!isRecord(batch)) {
		return null;
	}
	const editedFiles: unknown = batch.editedFiles;
	if (!Array.isArray(editedFiles)) {
		return null;
	}
	const hasTarget: boolean = editedFiles.some((item: unknown): boolean => {
		return isRecord(item) && item.path === targetPath;
	});
	return hasTarget ? batch : null;
}

function isUnsafeApproval(data: JsonObject, targetPath: string): boolean {
	const toolName: string | undefined = asString(data.toolName);
	if (toolName === undefined || !ALLOWED_SMOKE_WRITE_TOOLS.has(toolName)) {
		return true;
	}
	const args: unknown = data.args;
	if (!isRecord(args)) {
		return true;
	}
	return args.relativePath !== targetPath;
}

async function configureProvider(client: RpcClient, options: CliOptions, apiKey: string | undefined): Promise<void> {
	if (apiKey !== undefined) {
		const params: JsonObject = {
			provider: options.provider,
			apiKey,
			model: options.modelId
		};
		if (options.baseUrl !== undefined) {
			params.baseUrl = options.baseUrl;
		}
		await client.sendRequest("provider.configure", params, 30_000);
		return;
	}

	const params: JsonObject = {
		provider: options.provider,
		model: options.modelId,
		activate: true
	};
	if (options.baseUrl !== undefined) {
		params.baseUrl = options.baseUrl;
	}
	await client.sendRequest("provider.config.set", params, 30_000);
}

async function runSmoke(options: CliOptions): Promise<void> {
	if (!existsSync(options.projectPath)) {
		throw new Error(`Godot project was not found: ${options.projectPath}`);
	}
	resolveTargetAbsolutePath(options.projectPath, options.targetPath);
	const apiKey: string | undefined = resolveApiKey(options);
	let startedBackend: StartedBackend | null = null;
	const approvedApprovals: Set<string> = new Set();
	const observedBatch: { value: JsonObject | null } = { value: null };

	try {
		if (options.startBackend) {
			console.log(`Starting temporary backend on ${options.backendUrl}`);
			startedBackend = startBackend(options);
			console.log(`Backend logs: ${startedBackend.stdoutLog} ; ${startedBackend.stderrLog}`);
		}

		await waitForBackend(options.backendUrl, 30_000, startedBackend);
		const client: RpcClient = new RpcClient(options.backendUrl);
		await client.connect();

		try {
			await client.sendRequest("environment.configure", {
				godotProjectPath: options.projectPath,
				...(options.godotExecutablePath === undefined ? {} : { godotExecutablePath: options.godotExecutablePath })
			}, 30_000);
			await configureProvider(client, options, apiKey);
			const sessionResult: unknown = await client.sendRequest("session.create", {
				title: `LLM inline diff smoke ${new Date().toISOString()}`
			}, 30_000);
			const sessionId: string | undefined = isRecord(sessionResult) ? asString(sessionResult.id) : undefined;
			if (sessionId === undefined) {
				throw new Error("session.create did not return a session id");
			}
			await client.sendRequest("approval.mode.set", { mode: "manual" }, 10_000);

			const finalMessagePromise: Promise<ServerMessage> = client.waitForMessage((message: ServerMessage): boolean => {
				const maybeBatch: JsonObject | null = findBatchInEvent(message, options.targetPath);
				if (maybeBatch !== null) {
					observedBatch.value = maybeBatch;
				}
				if (message.type === "event" && message.event === "agent.tool.approval_required" && isRecord(message.data)) {
					const approvalId: string | undefined = asString(message.data.approvalId);
					if (approvalId !== undefined && !approvedApprovals.has(approvalId)) {
						approvedApprovals.add(approvalId);
						if (isUnsafeApproval(message.data, options.targetPath)) {
							client.reportFatal(new Error(`Refusing to approve non-smoke write: ${JSON.stringify(message.data)}`));
							return false;
						}
						console.log(`Approving smoke write ${approvalId}`);
						void client.sendRequest("approval.approve", { approvalId }, options.timeoutMs).catch((error: unknown): void => {
							client.reportFatal(error instanceof Error ? error : new Error("Approval failed"));
						});
					}
				}
				if (message.type === "response" && message.ok === false) {
					client.reportFatal(new Error(message.error?.message ?? "Backend request failed"));
					return false;
				}
				return message.type === "event" && (message.event === "agent.message.done" || message.event === "agent.run.error");
			}, options.timeoutMs);

			console.log(`Running real LLM smoke with ${options.provider}/${options.modelId}`);
			console.log(`Target file: ${options.targetPath}`);
			client.sendRequestNoWait("ai.chat", {
				message: createSmokePrompt(options.targetPath),
				mode: "agent",
				options: {
					temperature: 0,
					stream: false,
					toolBudget: "project_edit",
					workflow: "single"
				}
			});

			const finalMessage: ServerMessage = await finalMessagePromise;
			if (finalMessage.type === "event" && finalMessage.event === "agent.run.error") {
				throw new Error(`Agent failed: ${JSON.stringify(finalMessage.data)}`);
			}
			const batchSummary: JsonObject | null = observedBatch.value;
			if (batchSummary === null) {
				throw new Error("Agent completed without a fileEditBatch for the smoke file.");
			}

			const batchId: string | undefined = asString(batchSummary.batchId);
			if (batchId === undefined) {
				throw new Error("Observed fileEditBatch did not include batchId.");
			}
			const batchResponse: unknown = await client.sendRequest("fileEdit.batch.get", { sessionId, batchId }, 30_000);
			const fileEditBatch: unknown = isRecord(batchResponse) ? batchResponse.fileEditBatch : undefined;
			if (!isRecord(fileEditBatch) || !Array.isArray(fileEditBatch.edits)) {
				throw new Error("fileEdit.batch.get did not return persisted edits.");
			}
			const targetEdit: unknown = fileEditBatch.edits.find((edit: unknown): boolean => {
				return isRecord(edit) && edit.path === options.targetPath;
			});
			if (!isRecord(targetEdit)) {
				throw new Error("Persisted batch did not include the smoke target edit.");
			}
			if (targetEdit.undoable !== true) {
				throw new Error(`Smoke edit is not undoable: ${JSON.stringify(targetEdit)}`);
			}
			const afterSha256: string | undefined = asString(targetEdit.afterSha256);
			const targetAbsolutePath: string = resolveTargetAbsolutePath(options.projectPath, options.targetPath);
			const diskText: string = readFileSync(targetAbsolutePath, "utf8");
			if (afterSha256 !== undefined && sha256(diskText) !== afterSha256) {
				throw new Error("Disk file hash does not match persisted afterSha256.");
			}

			console.log(`LLM inline diff smoke passed. Session: ${sessionId}`);
			console.log(`File edit batch: ${batchId}`);
			console.log(`Smoke file: ${targetAbsolutePath}`);
		} finally {
			client.close();
		}
	} finally {
		if (!options.keepBackend) {
			await stopBackend(startedBackend);
		}
	}
}

async function main(): Promise<void> {
	const options: CliOptions = parseOptions(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}
	if (!options.useLlm && !options.dryRun) {
		printHelp();
		throw new Error("Refusing to call a real provider without use_llm. Use npm run dev:llm or pass use_llm.");
	}
	if (options.dryRun) {
		console.log(JSON.stringify({
			provider: options.provider,
			modelId: options.modelId,
			projectPath: options.projectPath,
			backendUrl: options.backendUrl,
			startBackend: options.startBackend,
			targetPath: options.targetPath
		}, null, 2));
		return;
	}

	await runSmoke(options);
}

void main().catch((error: unknown): void => {
	console.error(`LLM inline diff smoke failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
