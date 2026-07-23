import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { BACKEND_BIN_NAME, BACKEND_PACKAGE_NAME, DEFAULT_BACKEND_PORT, type BackendCurrentFile, type BackendPidFile } from "./types.js";
import { ManagerError } from "./manager-error.js";
import { assertInside, getManagerPaths, type ManagerPaths } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import { getCachedOrFetchLatestVersion, type LatestVersionOptions } from "./latest-cache.js";
import { runCommand, stopProcess, isProcessAlive, type CommandResult } from "./process.js";

const MAX_BACKEND_VERSIONS: number = 3;
const START_LOCK_STALE_MS: number = 30000;
const START_LOCK_WAIT_MS: number = 10000;
const START_LOCK_POLL_MS: number = 250;

export async function getLatestBackendVersion(options: LatestVersionOptions = {}): Promise<string | null> {
	return getCachedOrFetchLatestVersion("backend", fetchLatestBackendVersion, options);
}

async function fetchLatestBackendVersion(): Promise<string | null> {
	const result: CommandResult = await runCommand(getNpmCommand(), ["view", BACKEND_PACKAGE_NAME, "version"], {
		env: createNpmCommandEnv(),
		timeoutMs: 20000
	});
	if (result.exitCode !== 0) {
		return null;
	}

	const version: string = result.stdout.trim().split(/\s+/)[0] ?? "";
	return version.length === 0 ? null : version;
}

export async function getCurrentBackend(): Promise<BackendCurrentFile | null> {
	const paths: ManagerPaths = getManagerPaths();
	return readJsonFile<BackendCurrentFile>(paths.backendCurrentPath);
}

export async function installBackend(versionSpec: string = "latest"): Promise<{ version: string; path: string }> {
	const paths: ManagerPaths = getManagerPaths();
	await mkdir(paths.backendVersionsDir, { recursive: true });
	const packageSpec: string = await resolveBackendPackageSpec(versionSpec);
	const stagingName: string = versionSpec.match(/^\d+\.\d+\.\d+$/) !== null || versionSpec === "latest"
		? `${packageSpec.replace(`${BACKEND_PACKAGE_NAME}@`, "")}.staging`
		: `manual-${Date.now()}.staging`;
	const stagingDir: string = assertInside(paths.backendVersionsDir, join(paths.backendVersionsDir, stagingName));
	const previous: BackendCurrentFile | null = await getCurrentBackend();

	await removeDirectory(stagingDir);
	await mkdir(stagingDir, { recursive: true });
	const installResult: CommandResult = await runCommand(getNpmCommand(), ["install", "--prefix", stagingDir, "--prefer-online", packageSpec], {
		env: createNpmCommandEnv(),
		timeoutMs: 120000
	});
	if (installResult.exitCode !== 0) {
		await removeDirectory(stagingDir);
		throw new ManagerError({
			code: "install_failed",
			message: `Failed to install ${packageSpec}`,
			details: installResult.stderr || installResult.stdout,
			suggestedAction: "Check your npm registry/network, then try again."
		});
	}

	const installedVersion: string = await readInstalledBackendVersion(stagingDir);
	const versionDir: string = assertInside(paths.backendVersionsDir, join(paths.backendVersionsDir, installedVersion));
	const packageJsonPath: string = join(stagingDir, "node_modules", BACKEND_PACKAGE_NAME, "package.json");
	await removeDirectory(versionDir);
	await rename(stagingDir, versionDir);

	await writeJsonFile(paths.backendCurrentPath, {
		version: installedVersion,
		path: versionDir,
		...(previous === null ? {} : { previousVersion: previous.version }),
		updatedAt: new Date().toISOString()
	} satisfies BackendCurrentFile);
	await pruneBackendVersions(installedVersion, previous?.version);
	return { version: installedVersion, path: versionDir };
}

async function resolveBackendPackageSpec(versionSpec: string): Promise<string> {
	if (versionSpec === "latest") {
		return `${BACKEND_PACKAGE_NAME}@${await requireLatestBackendVersion()}`;
	}
	if (versionSpec.match(/^\d+\.\d+\.\d+(?:[-+].*)?$/) !== null) {
		return `${BACKEND_PACKAGE_NAME}@${versionSpec}`;
	}
	return versionSpec;
}

export async function startBackend(port: number = DEFAULT_BACKEND_PORT): Promise<BackendPidFile> {
	const paths: ManagerPaths = getManagerPaths();
	const current: BackendCurrentFile | null = await getCurrentBackend();
	if (current === null) {
		throw new ManagerError({
			code: "not_installed",
			message: "Daedalus backend is not installed.",
			suggestedAction: "Run godot-daedalus-manager backend install --json."
		});
	}

	await mkdir(paths.backendRuntimeDir, { recursive: true });
	const existingPid: BackendPidFile | null = await getRunningBackendPidForPort(paths, port);
	if (existingPid !== null) {
		return existingPid;
	}

	const releaseLock: () => Promise<void> = await acquireBackendStartLock(paths);
	try {
		const lockedExistingPid: BackendPidFile | null = await getRunningBackendPidForPort(paths, port);
		if (lockedExistingPid !== null) {
			return lockedExistingPid;
		}

		const url: string = `ws://localhost:${port}`;
		const existingHealth = await healthBackend(url);
		if (existingHealth.ok) {
			return {
				pid: 0,
				version: current.version,
				port,
				url,
				logPath: "",
				startedAt: new Date().toISOString()
			};
		}
		if (!isConnectionRefusedHealthError(existingHealth.error)) {
			throw new ManagerError({
				code: "health_failed",
				message: `Backend port ${port} is already occupied by a non-Daedalus service or an incompatible backend.`,
				details: existingHealth.error ?? "Unknown health check failure.",
				suggestedAction: "Stop the process using this port, or change Daedalus backend URL in Settings."
			});
		}

		await mkdir(paths.logsDir, { recursive: true });
		const logPath: string = join(paths.logsDir, `backend_${current.version}_${Date.now()}.log`);
		const out = createWriteStream(logPath, { flags: "a" });
		const packageRoot: string = join(current.path, "node_modules", BACKEND_PACKAGE_NAME);
		const entryPath: string = join(packageRoot, "src", "main.ts");
		const child = (await import("node:child_process")).spawn(
			process.execPath,
			["--import", "tsx", entryPath],
			{
				cwd: packageRoot,
				env: { ...process.env, DAEDALUS_BACKEND_MODE: "runtime", PORT: String(port) },
				detached: true,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"]
			}
		);
		child.stdout.pipe(out, { end: false });
		child.stderr.pipe(out, { end: false });
		child.unref();

		const pidFile: BackendPidFile = {
			pid: child.pid ?? 0,
			version: current.version,
			port,
			url: `ws://localhost:${port}`,
			logPath,
			startedAt: new Date().toISOString()
		};
		await writeJsonFile(paths.backendPidPath, pidFile);
		return pidFile;
	} finally {
		await releaseLock();
	}
}

async function getRunningBackendPidForPort(paths: ManagerPaths, port: number): Promise<BackendPidFile | null> {
	const existingPid: BackendPidFile | null = await readJsonFile<BackendPidFile>(paths.backendPidPath);
	if (existingPid === null) {
		return null;
	}

	if (existingPid.pid > 0 && existingPid.port === port && isProcessAlive(existingPid.pid)) {
		return existingPid;
	}

	if (existingPid.pid <= 0 || !isProcessAlive(existingPid.pid)) {
		await rm(paths.backendPidPath, { force: true });
	}

	return null;
}

async function acquireBackendStartLock(paths: ManagerPaths): Promise<() => Promise<void>> {
	const lockDir: string = join(paths.backendRuntimeDir, "backend-start.lock");
	const ownerPath: string = join(lockDir, "owner.json");
	const deadline: number = Date.now() + START_LOCK_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			await mkdir(lockDir);
			await writeFile(ownerPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
			return async (): Promise<void> => {
				await removeDirectory(lockDir);
			};
		} catch (error: unknown) {
			if (!isFileSystemError(error, "EEXIST")) {
				throw error;
			}

			if (await isBackendStartLockStale(lockDir, ownerPath)) {
				await removeDirectory(lockDir);
				continue;
			}

			await sleep(START_LOCK_POLL_MS);
		}
	}

	throw new ManagerError({
		code: "process_failed",
		message: "Another Daedalus backend startup is still in progress.",
		suggestedAction: "Wait a few seconds, then reconnect. If this repeats, close duplicate Godot editors and try again."
	});
}

async function isBackendStartLockStale(lockDir: string, ownerPath: string): Promise<boolean> {
	const lockStats = await stat(ownerPath).catch(async (): Promise<Awaited<ReturnType<typeof stat>> | null> => {
		return stat(lockDir).catch((): null => null);
	});
	if (lockStats === null || lockStats === undefined) {
		return true;
	}

	return Date.now() - Number(lockStats.mtimeMs) > START_LOCK_STALE_MS;
}

function isConnectionRefusedHealthError(error: string | null): boolean {
	if (error === null) {
		return false;
	}

	const normalized: string = error.toLowerCase();
	return normalized.includes("econnrefused") || normalized.includes("connection refused");
}

function isFileSystemError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve): void => {
		setTimeout(resolve, ms);
	});
}

export async function stopBackend(): Promise<{ stopped: boolean; pid: number | null; details: string }> {
	const paths: ManagerPaths = getManagerPaths();
	const pidFile: BackendPidFile | null = await readJsonFile<BackendPidFile>(paths.backendPidPath);
	if (pidFile === null) {
		return { stopped: false, pid: null, details: "No backend pid file found." };
	}

	if (!isProcessAlive(pidFile.pid)) {
		await rm(paths.backendPidPath, { force: true });
		return { stopped: false, pid: pidFile.pid, details: "Backend process was already stopped." };
	}

	const result: CommandResult = await stopProcess(pidFile.pid);
	if (result.exitCode === 0 || !isProcessAlive(pidFile.pid)) {
		await rm(paths.backendPidPath, { force: true });
		return { stopped: true, pid: pidFile.pid, details: result.stdout || result.stderr };
	}

	throw new ManagerError({
		code: "process_failed",
		message: `Failed to stop backend process ${pidFile.pid}`,
		details: result.stderr || result.stdout,
		logPath: pidFile.logPath
	});
}

export async function rollbackBackend(): Promise<BackendCurrentFile> {
	const paths: ManagerPaths = getManagerPaths();
	const current: BackendCurrentFile | null = await getCurrentBackend();
	if (current === null || current.previousVersion === undefined) {
		throw new ManagerError({
			code: "not_installed",
			message: "No previous backend version is available for rollback."
		});
	}

	const previousDir: string = join(paths.backendVersionsDir, current.previousVersion);
	const previousStats = await stat(previousDir).catch((): null => null);
	if (previousStats === null || !previousStats.isDirectory()) {
		throw new ManagerError({
			code: "not_installed",
			message: `Previous backend version is missing: ${current.previousVersion}`
		});
	}

	const rollbackFile: BackendCurrentFile = {
		version: current.previousVersion,
		path: previousDir,
		previousVersion: current.version,
		updatedAt: new Date().toISOString()
	};
	await writeJsonFile(paths.backendCurrentPath, rollbackFile);
	return rollbackFile;
}

export async function healthBackend(url: string = `ws://localhost:${DEFAULT_BACKEND_PORT}`): Promise<{ ok: boolean; url: string; error: string | null; result?: unknown }> {
	try {
		const parsedUrl: URL = new URL(url);
		const port: number = parsedUrl.port === "" ? 80 : Number.parseInt(parsedUrl.port, 10);
		const host: string = parsedUrl.hostname;
		const path: string = `${parsedUrl.pathname}${parsedUrl.search}`;
		const key: string = randomBytes(16).toString("base64");
		return await new Promise((resolveHealth): void => {
			const socket = createConnection({ host, port });
			let buffer: Buffer = Buffer.alloc(0);
			let handshakeDone: boolean = false;
			let settled: boolean = false;
			const finish = (result: { ok: boolean; url: string; error: string | null; result?: unknown }): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				resolveHealth(result);
			};
			const timer = setTimeout((): void => {
				finish({ ok: false, url, error: "Timed out waiting for backend health." });
			}, 2500);
			socket.on("connect", (): void => {
				socket.write([
					`GET ${path === "" ? "/" : path} HTTP/1.1`,
					`Host: ${host}:${port}`,
					"Upgrade: websocket",
					"Connection: Upgrade",
					`Sec-WebSocket-Key: ${key}`,
					"Sec-WebSocket-Version: 13",
					"",
					""
				].join("\r\n"));
			});
			socket.on("data", (chunk: Buffer): void => {
				buffer = Buffer.concat([buffer, chunk]);
				if (!handshakeDone) {
					const headerEnd: number = buffer.indexOf("\r\n\r\n");
					if (headerEnd < 0) {
						return;
					}
					const headerText: string = buffer.subarray(0, headerEnd).toString("utf8");
					if (!headerText.startsWith("HTTP/1.1 101")) {
						finish({ ok: false, url, error: `Unexpected WebSocket handshake: ${headerText.split("\r\n")[0] ?? headerText}` });
						return;
					}
					handshakeDone = true;
					buffer = buffer.subarray(headerEnd + 4);
					socket.write(createClientTextFrame(JSON.stringify({ id: "manager-health", method: "backend.health", params: {} })));
				}
				const frame = tryReadServerTextFrame(buffer);
				if (frame === null) {
					return;
				}
				const parsed: unknown = JSON.parse(frame.text);
				finish({ ok: true, url, error: null, result: parsed });
			});
			socket.on("error", (error: Error): void => {
				finish({ ok: false, url, error: error.message });
			});
		});
	} catch (error: unknown) {
		return { ok: false, url, error: error instanceof Error ? error.message : String(error) };
	}
}

function createClientTextFrame(text: string): Buffer {
	const payload: Buffer = Buffer.from(text, "utf8");
	const mask: Buffer = randomBytes(4);
	const headerLength: number = payload.length < 126 ? 6 : 8;
	const frame: Buffer = Buffer.alloc(headerLength + payload.length);
	frame[0] = 0x81;
	if (payload.length < 126) {
		frame[1] = 0x80 | payload.length;
		mask.copy(frame, 2);
		for (let index: number = 0; index < payload.length; index += 1) {
			frame[6 + index] = payload[index]! ^ mask[index % 4]!;
		}
		return frame;
	}
	frame[1] = 0x80 | 126;
	frame.writeUInt16BE(payload.length, 2);
	mask.copy(frame, 4);
	for (let index: number = 0; index < payload.length; index += 1) {
		frame[8 + index] = payload[index]! ^ mask[index % 4]!;
	}
	return frame;
}

function tryReadServerTextFrame(buffer: Buffer): { text: string; bytesRead: number } | null {
	if (buffer.length < 2) {
		return null;
	}
	const opcode: number = buffer[0]! & 0x0f;
	let payloadLength: number = buffer[1]! & 0x7f;
	let offset: number = 2;
	if (payloadLength === 126) {
		if (buffer.length < 4) {
			return null;
		}
		payloadLength = buffer.readUInt16BE(2);
		offset = 4;
	} else if (payloadLength === 127) {
		return null;
	}
	if (buffer.length < offset + payloadLength) {
		return null;
	}
	if (opcode !== 1) {
		return null;
	}
	return {
		text: buffer.subarray(offset, offset + payloadLength).toString("utf8"),
		bytesRead: offset + payloadLength
	};
}

export async function getInstalledBackendVersion(): Promise<string | null> {
	const current: BackendCurrentFile | null = await getCurrentBackend();
	return current?.version ?? null;
}

export async function getRunningBackend(): Promise<BackendPidFile | null> {
	const paths: ManagerPaths = getManagerPaths();
	const pidFile: BackendPidFile | null = await readJsonFile<BackendPidFile>(paths.backendPidPath);
	if (pidFile === null || !isProcessAlive(pidFile.pid)) {
		return null;
	}
	return pidFile;
}

async function requireLatestBackendVersion(): Promise<string> {
	const latest: string | null = await getLatestBackendVersion({ forceRefresh: true });
	if (latest === null) {
		throw new ManagerError({
			code: "network_error",
			message: "Could not read latest backend version from npm.",
			suggestedAction: "Check npm network access, then try again."
		});
	}
	return latest;
}

async function readInstalledBackendVersion(versionDir: string): Promise<string> {
	const manifestText: string = await readFile(join(versionDir, "node_modules", BACKEND_PACKAGE_NAME, "package.json"), "utf8");
	const manifest = JSON.parse(manifestText) as { version?: unknown };
	if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
		throw new ManagerError({ code: "install_failed", message: "Installed backend package has no version." });
	}
	return manifest.version;
}

async function pruneBackendVersions(currentVersion: string, previousVersion: string | undefined): Promise<void> {
	const paths: ManagerPaths = getManagerPaths();
	const entries = await readdir(paths.backendVersionsDir, { withFileTypes: true }).catch(() => []);
	const keep: Set<string> = new Set([currentVersion, ...(previousVersion === undefined ? [] : [previousVersion])]);
	const versions = entries
		.filter((entry) => entry.isDirectory() && !entry.name.endsWith(".staging"))
		.map((entry) => entry.name)
		.sort()
		.reverse();
	for (const version of versions) {
		if (keep.has(version)) {
			continue;
		}
		if (keep.size < MAX_BACKEND_VERSIONS) {
			keep.add(version);
			continue;
		}
		await removeDirectory(assertInside(paths.backendVersionsDir, join(paths.backendVersionsDir, version)));
	}
}

async function removeDirectory(targetPath: string): Promise<void> {
	await rm(targetPath, {
		recursive: true,
		force: true,
		maxRetries: 8,
		retryDelay: 250
	});
}

export function sha256Text(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function getNpmCommand(): string {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function createNpmCommandEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.toLowerCase() === "npm_config_dry_run") {
			delete env[key];
		}
	}
	env.npm_config_dry_run = "false";
	return env;
}
