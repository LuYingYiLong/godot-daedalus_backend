import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { FRONTEND_ADDON_DIR_NAME, FRONTEND_REPOSITORY, type FrontendManifest, type PendingFrontendUpdate } from "./types.js";
import { ManagerError } from "./manager-error.js";
import { assertInside, getManagerPaths, resolveProjectPluginDir, type ManagerPaths } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import { getCachedOrFetchLatestVersion, type LatestVersionOptions } from "./latest-cache.js";
import { isProcessAlive, runCommand } from "./process.js";

export type GithubReleaseAsset = {
	name?: unknown;
	browser_download_url?: unknown;
};

export type GithubRelease = {
	tag_name?: unknown;
	html_url?: unknown;
	assets?: unknown;
};

type FrontendReleasePackage = {
	version: string;
	tag: string;
	assetName: string;
	assetUrl: string;
	sha256: string | null;
	minGodotVersion: string | undefined;
};

export async function getInstalledFrontendVersion(projectPath: string | undefined): Promise<string | null> {
	const pluginDir: string | null = resolveProjectPluginDir(projectPath);
	if (pluginDir === null) {
		return null;
	}

	const pluginCfgPath: string = join(pluginDir, "plugin.cfg");
	const text: string = await readFile(pluginCfgPath, "utf8").catch((): string => "");
	const match: RegExpMatchArray | null = text.match(/version="([^"]+)"/);
	return match?.[1] ?? null;
}

export async function getLatestFrontendVersion(options: LatestVersionOptions = {}): Promise<string | null> {
	return getCachedOrFetchLatestVersion("frontend", fetchLatestFrontendVersion, options);
}

async function fetchLatestFrontendVersion(): Promise<string | null> {
	const latestRelease: GithubRelease | null = await fetchGithubRelease("latest");
	const apiVersion: string | null = getVersionFromGithubRelease(latestRelease);
	if (apiVersion !== null) {
		return apiVersion;
	}
	return fetchLatestFrontendVersionFromRedirect();
}

export async function getPendingFrontendVersion(): Promise<string | null> {
	const paths: ManagerPaths = getManagerPaths();
	const pending: PendingFrontendUpdate | null = await readJsonFile<PendingFrontendUpdate>(paths.pendingFrontendUpdatePath);
	return pending?.version ?? null;
}

export async function downloadAndStageFrontend(version: string): Promise<PendingFrontendUpdate> {
	const releasePackage: FrontendReleasePackage = await resolveFrontendReleasePackage(version);
	const paths: ManagerPaths = getManagerPaths();
	await mkdir(paths.frontendDownloadsDir, { recursive: true });
	await mkdir(paths.frontendStagedDir, { recursive: true });
	const zipPath: string = assertInside(paths.frontendDownloadsDir, join(paths.frontendDownloadsDir, releasePackage.assetName));
	const stagedDir: string = assertInside(paths.frontendStagedDir, join(paths.frontendStagedDir, releasePackage.version));

	await downloadFile(releasePackage.assetUrl, zipPath);
	const hash: string = await sha256File(zipPath);
	if (releasePackage.sha256 !== null && hash.toLowerCase() !== releasePackage.sha256.toLowerCase()) {
		throw new ManagerError({
			code: "hash_mismatch",
			message: "Downloaded frontend package hash does not match manifest.",
			details: `Expected ${releasePackage.sha256}, got ${hash}`
		});
	}

	await rm(stagedDir, { recursive: true, force: true });
	await mkdir(stagedDir, { recursive: true });
	await extractZip(zipPath, stagedDir);
	const stagedPluginDir: string = await ensureStagedFrontendAddonLayout(stagedDir);
	const stagedPluginCfg: string = join(stagedPluginDir, "plugin.cfg");
	const stagedVersion: string | null = await readPluginCfgVersion(stagedPluginCfg);
	if (stagedVersion !== releasePackage.version) {
		throw new ManagerError({
			code: "manifest_invalid",
			message: "Frontend package plugin.cfg version does not match the requested release.",
			details: `Expected ${releasePackage.version}, got ${stagedVersion ?? "missing"}.`
		});
	}
	const manifest: FrontendManifest = {
		version: releasePackage.version,
		tag: releasePackage.tag,
		sha256: releasePackage.sha256 ?? hash,
		assetName: releasePackage.assetName,
		...(releasePackage.minGodotVersion === undefined ? {} : { minGodotVersion: releasePackage.minGodotVersion })
	};
	validateFrontendManifest(manifest);

	const pending: PendingFrontendUpdate = {
		version: manifest.version,
		sourceZipPath: zipPath,
		stagedDir,
		manifest,
		createdAt: new Date().toISOString()
	};
	await writeJsonFile(paths.pendingFrontendUpdatePath, pending);
	return pending;
}

export async function applyFrontendUpdate(projectPath: string | undefined): Promise<{ applied: boolean; version: string | null; backupDir?: string }> {
	const pluginDir: string | null = resolveProjectPluginDir(projectPath);
	if (pluginDir === null) {
		throw new ManagerError({
			code: "invalid_arguments",
			message: "frontend apply requires --project <Godot project root>."
		});
	}

	const paths: ManagerPaths = getManagerPaths();
	const pending: PendingFrontendUpdate | null = await readJsonFile<PendingFrontendUpdate>(paths.pendingFrontendUpdatePath);
	if (pending === null) {
		return { applied: false, version: null };
	}

	const stagedPluginDir: string = join(pending.stagedDir, "addons", FRONTEND_ADDON_DIR_NAME);
	const stagedStats = await stat(stagedPluginDir).catch((): null => null);
	if (stagedStats === null || !stagedStats.isDirectory()) {
		throw new ManagerError({
			code: "frontend_update_missing",
			message: "Pending frontend update staged directory is missing."
		});
	}

	const backupDir: string = `${pluginDir}.backup-${Date.now()}`;
	await rm(backupDir, { recursive: true, force: true });
	await rename(pluginDir, backupDir).catch(async (error: unknown): Promise<void> => {
		await rm(backupDir, { recursive: true, force: true });
		throw new ManagerError({
			code: "process_failed",
			message: "Could not move the current Daedalus plugin directory. Close Godot, then try again.",
			details: formatUpdateError(error)
		});
	});
	try {
		await copyDirectory(stagedPluginDir, pluginDir);
		await rm(paths.pendingFrontendUpdatePath, { force: true });
		return { applied: true, version: pending.version, backupDir };
	} catch (error: unknown) {
		await rm(pluginDir, { recursive: true, force: true });
		await rename(backupDir, pluginDir).catch((): void => undefined);
		throw error;
	}
}

export type ApplyFrontendUpdateWaitOptions = {
	timeoutMs?: number;
	intervalMs?: number;
	waitPid?: number;
	applyUpdate?: (projectPath: string | undefined) => Promise<{ applied: boolean; version: string | null; backupDir?: string }>;
};

export async function applyFrontendUpdateWait(
	projectPath: string | undefined,
	options: ApplyFrontendUpdateWaitOptions = {}
): Promise<{ applied: boolean; version: string | null; backupDir?: string; logPath: string }> {
	const paths: ManagerPaths = getManagerPaths();
	const logPath: string = join(paths.logsDir, `frontend-update-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
	await mkdir(paths.logsDir, { recursive: true });
	await writeUpdateLog(logPath, "Daedalus frontend update installer started.");
	await writeUpdateLog(logPath, `Project: ${projectPath ?? ""}`);
	await assertPendingFrontendUpdateExists(paths);

	const timeoutMs: number = options.timeoutMs ?? 5 * 60 * 1000;
	const intervalMs: number = options.intervalMs ?? 1000;
	const applyUpdate = options.applyUpdate ?? applyFrontendUpdate;
	const deadlineMs: number = Date.now() + timeoutMs;
	if (options.waitPid !== undefined && Number.isFinite(options.waitPid) && options.waitPid > 0) {
		await writeUpdateLog(logPath, `Waiting for Godot editor process ${options.waitPid} to exit.`);
		while (Date.now() <= deadlineMs && isProcessAlive(options.waitPid)) {
			await sleep(intervalMs);
		}
		if (isProcessAlive(options.waitPid)) {
			throw new ManagerError({
				code: "process_failed",
				message: "Godot editor is still running; Daedalus plugin update was not applied.",
				details: "Close Godot editor, then run the pending plugin installer again.",
				logPath,
				suggestedAction: "Close Godot editor and run Install pending update again."
			});
		}
		await writeUpdateLog(logPath, "Godot editor process has exited.");
	}
	let attempt: number = 0;
	let lastError: unknown = null;
	while (Date.now() <= deadlineMs) {
		attempt += 1;
		try {
			await writeUpdateLog(logPath, `Attempt ${attempt}: applying staged plugin update.`);
			const result = await applyUpdate(projectPath);
			await writeUpdateLog(logPath, `Update applied successfully. Version: ${result.version ?? "unknown"}.`);
			return { ...result, logPath };
		} catch (error: unknown) {
			lastError = error;
			await writeUpdateLog(logPath, `Attempt ${attempt} failed: ${formatUpdateError(error)}`);
			if (!isRetryableApplyError(error)) {
				throw addLogPathToManagerError(error, logPath);
			}
			await writeUpdateLog(logPath, "Waiting for Godot editor to close before retrying.");
			await sleep(intervalMs);
		}
	}

	throw new ManagerError({
		code: "process_failed",
		message: "Could not apply Daedalus plugin update before the timeout.",
		details: `Close Godot editor and run the installer again.\nLast error: ${formatUpdateError(lastError)}`,
		logPath,
		suggestedAction: "Close Godot editor, then run the pending plugin installer again."
	});
}

export async function rollbackFrontend(projectPath: string | undefined): Promise<{ rolledBack: boolean }> {
	const pluginDir: string | null = resolveProjectPluginDir(projectPath);
	if (pluginDir === null) {
		throw new ManagerError({ code: "invalid_arguments", message: "frontend rollback requires --project <Godot project root>." });
	}
	const parent: string = dirname(pluginDir);
	const entries = await readdir(parent, { withFileTypes: true });
	const backup = entries
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(`${FRONTEND_ADDON_DIR_NAME}.backup-`))
		.map((entry) => entry.name)
		.sort()
		.reverse()[0];
	if (backup === undefined) {
		return { rolledBack: false };
	}
	await rm(pluginDir, { recursive: true, force: true });
	await rename(join(parent, backup), pluginDir);
	return { rolledBack: true };
}

async function assertPendingFrontendUpdateExists(paths: ManagerPaths): Promise<void> {
	const pending: PendingFrontendUpdate | null = await readJsonFile<PendingFrontendUpdate>(paths.pendingFrontendUpdatePath);
	if (pending === null) {
		throw new ManagerError({
			code: "frontend_update_missing",
			message: "No pending Daedalus plugin update is staged."
		});
	}

	const stagedPluginDir: string = join(pending.stagedDir, "addons", FRONTEND_ADDON_DIR_NAME);
	const stagedStats = await stat(stagedPluginDir).catch((): null => null);
	if (stagedStats === null || !stagedStats.isDirectory()) {
		throw new ManagerError({
			code: "frontend_update_missing",
			message: "Pending frontend update staged directory is missing."
		});
	}
}

function isRetryableApplyError(error: unknown): boolean {
	const code: string = getErrorCode(error);
	if (code === "EBUSY" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY") {
		return true;
	}
	if (error instanceof ManagerError) {
		return error.code === "process_failed" && error.message.toLowerCase().includes("close godot");
	}
	return false;
}

function getErrorCode(error: unknown): string {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return "";
	}
	const value: unknown = (error as { code?: unknown }).code;
	return typeof value === "string" ? value : "";
}

function addLogPathToManagerError(error: unknown, logPath: string): ManagerError {
	if (error instanceof ManagerError) {
		return new ManagerError({
			code: error.code,
			message: error.message,
			...(error.details === undefined ? {} : { details: error.details }),
			logPath,
			...(error.suggestedAction === undefined ? {} : { suggestedAction: error.suggestedAction })
		});
	}
	return new ManagerError({
		code: "unknown_error",
		message: error instanceof Error ? error.message : String(error),
		logPath
	});
}

function formatUpdateError(error: unknown): string {
	if (error instanceof ManagerError) {
		return `${error.code}: ${error.message}${error.details === undefined ? "" : ` (${error.details})`}`;
	}
	if (error instanceof Error) {
		const code: string = getErrorCode(error);
		return `${code.length === 0 ? "error" : code}: ${error.message}`;
	}
	return String(error);
}

async function writeUpdateLog(logPath: string, message: string): Promise<void> {
	await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

async function sleep(ms: number): Promise<void> {
	await new Promise<void>((resolve): void => {
		setTimeout(resolve, ms);
	});
}

export function getVersionFromGithubRelease(release: GithubRelease | null): string | null {
	if (release === null || typeof release.tag_name !== "string") {
		return null;
	}
	return normalizeFrontendVersion(release.tag_name);
}

export function normalizeFrontendVersion(value: string): string | null {
	const trimmed: string = value.trim().replace(/^v/i, "");
	if (!trimmed.match(/^\d+\.\d+\.\d+$/)) {
		return null;
	}
	return trimmed;
}

export function selectFrontendZipAsset(release: GithubRelease | null, version: string): GithubReleaseAsset | null {
	const assets: GithubReleaseAsset[] = getGithubReleaseAssets(release);
	if (assets.length === 0) {
		return null;
	}

	const normalizedVersion: string = normalizeFrontendVersion(version) ?? version;
	const tag: string = `v${normalizedVersion}`;
	const exactNames: Set<string> = new Set<string>([
		`godot-daedalus-plugin-${tag}.zip`,
		`godot-daedalus-plugin-${normalizedVersion}.zip`,
		"godot_daedalus.zip",
		"godot-daedalus.zip"
	]);
	const exactAsset: GithubReleaseAsset | undefined = assets.find((asset: GithubReleaseAsset): boolean => {
		return typeof asset.name === "string" && exactNames.has(asset.name);
	});
	if (exactAsset !== undefined) {
		return exactAsset;
	}

	const namedAsset: GithubReleaseAsset | undefined = assets.find((asset: GithubReleaseAsset): boolean => {
		if (typeof asset.name !== "string") {
			return false;
		}
		const lowerName: string = asset.name.toLowerCase();
		return lowerName.endsWith(".zip") && lowerName.includes("godot") && lowerName.includes("daedalus");
	});
	if (namedAsset !== undefined) {
		return namedAsset;
	}

	return assets.find((asset: GithubReleaseAsset): boolean => typeof asset.name === "string" && asset.name.toLowerCase().endsWith(".zip")) ?? null;
}

export function validateFrontendManifest(manifest: FrontendManifest): void {
	if (!manifest.version.match(/^\d+\.\d+\.\d+$/)) {
		throw new ManagerError({ code: "manifest_invalid", message: "Frontend manifest version must be X.Y.Z." });
	}
	if (manifest.tag !== `v${manifest.version}`) {
		throw new ManagerError({ code: "manifest_invalid", message: "Frontend manifest tag must match version." });
	}
	if (!manifest.assetName.endsWith(".zip")) {
		throw new ManagerError({ code: "manifest_invalid", message: "Frontend manifest assetName must be a zip file." });
	}
	if (!manifest.sha256.match(/^[a-fA-F0-9]{64}$/)) {
		throw new ManagerError({ code: "manifest_invalid", message: "Frontend manifest sha256 is invalid." });
	}
	if (manifest.minGodotVersion === undefined || !manifest.minGodotVersion.match(/^\d+\.\d+(?:\.\d+)?$/)) {
		throw new ManagerError({ code: "manifest_invalid", message: "Frontend manifest minGodotVersion is required." });
	}
}

async function resolveFrontendReleasePackage(version: string): Promise<FrontendReleasePackage> {
	const normalizedVersion: string | null = normalizeFrontendVersion(version);
	if (normalizedVersion === null) {
		throw new ManagerError({ code: "invalid_arguments", message: "Frontend version must be X.Y.Z." });
	}
	const manifest: FrontendManifest | null = await downloadFrontendManifest(normalizedVersion);
	if (manifest !== null) {
		validateFrontendManifest(manifest);
		return {
			version: manifest.version,
			tag: manifest.tag,
			assetName: manifest.assetName,
			assetUrl: getReleaseAssetUrl(manifest.tag, manifest.assetName),
			sha256: manifest.sha256,
			minGodotVersion: manifest.minGodotVersion
		};
	}

	const tag: string = `v${normalizedVersion}`;
	const release: GithubRelease | null = await fetchGithubRelease(`tags/${tag}`);
	const asset: GithubReleaseAsset | null = selectFrontendZipAsset(release, normalizedVersion);
	if (asset !== null && typeof asset.name === "string" && typeof asset.browser_download_url === "string") {
		return {
			version: normalizedVersion,
			tag,
			assetName: asset.name,
			assetUrl: asset.browser_download_url,
			sha256: null,
			minGodotVersion: undefined
		};
	}

	const fallbackAssetName: string = "godot_daedalus.zip";
	return {
		version: normalizedVersion,
		tag,
		assetName: fallbackAssetName,
		assetUrl: getReleaseAssetUrl(tag, fallbackAssetName),
		sha256: null,
		minGodotVersion: undefined
	};
}

async function downloadFrontendManifest(version: string): Promise<FrontendManifest | null> {
	const tag: string = version.startsWith("v") ? version : `v${version}`;
	const assetName: string = `godot-daedalus-plugin-${tag}.manifest.json`;
	const manifest: FrontendManifest | null = await fetchJsonWithFallback<FrontendManifest>(getReleaseAssetUrl(tag, assetName));
	if (manifest === null) {
		return null;
	}
	return manifest;
}

function getReleaseAssetUrl(tag: string, assetName: string): string {
	return `https://github.com/${FRONTEND_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

async function downloadFile(url: string, destination: string): Promise<void> {
	await mkdir(dirname(destination), { recursive: true });
	const errors: string[] = [];
	try {
		const response: Response = await fetch(url, { headers: { "User-Agent": "godot-daedalus-manager" } });
		if (!response.ok || response.body === null) {
			throw new Error(`${response.status} ${response.statusText}`);
		}
		await pipeline(response.body, createWriteStream(destination));
		return;
	} catch (error: unknown) {
		errors.push(`node fetch: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (process.platform === "win32") {
		const powershellError: string | null = await downloadFileWithPowerShell(url, destination);
		if (powershellError === null) {
			return;
		}
		errors.push(`PowerShell: ${powershellError}`);

		const curlError: string | null = await downloadFileWithCurl(url, destination);
		if (curlError === null) {
			return;
		}
		errors.push(`curl.exe: ${curlError}`);
	}

	throw new ManagerError({
		code: "network_error",
		message: `Could not download ${url}`,
		details: errors.join("\n")
	});
}

async function fetchJsonWithFallback<T>(url: string): Promise<T | null> {
	try {
		const response: Response = await fetch(url, { headers: { "User-Agent": "godot-daedalus-manager" } });
		if (!response.ok) {
			return null;
		}
		return await response.json() as T;
	} catch {
		if (process.platform !== "win32") {
			return null;
		}
		return fetchJsonWithPowerShell<T>(url);
	}
}

async function fetchGithubRelease(path: "latest" | `tags/${string}`): Promise<GithubRelease | null> {
	return fetchJsonWithFallback<GithubRelease>(`https://api.github.com/repos/${FRONTEND_REPOSITORY}/releases/${path}`);
}

async function fetchLatestFrontendVersionFromRedirect(): Promise<string | null> {
	const url: string = `https://github.com/${FRONTEND_REPOSITORY}/releases/latest`;
	try {
		const response: Response = await fetch(url, {
			headers: { "User-Agent": "godot-daedalus-manager" },
			redirect: "follow"
		});
		const version: string | null = getVersionFromGithubReleaseUrl(response.url);
		if (version !== null) {
			return version;
		}
	} catch {
		// Windows 上部分用户环境会让 Node fetch 受代理或证书影响，继续尝试 PowerShell。
	}
	if (process.platform !== "win32") {
		return null;
	}
	return fetchLatestFrontendVersionFromRedirectWithPowerShell(url);
}

async function fetchLatestFrontendVersionFromRedirectWithPowerShell(url: string): Promise<string | null> {
	const command: string = [
		"$ProgressPreference = 'SilentlyContinue';",
		`$response = Invoke-WebRequest -Uri ${quotePowerShellString(url)} -Headers @{ 'User-Agent' = 'godot-daedalus-manager' } -MaximumRedirection 5 -TimeoutSec 30;`,
		"$response.BaseResponse.ResponseUri.AbsoluteUri"
	].join(" ");
	const result = await runCommand("powershell.exe", [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		command
	], { timeoutMs: 45000 });
	if (result.exitCode !== 0) {
		return null;
	}
	return getVersionFromGithubReleaseUrl(result.stdout.trim());
}

function getVersionFromGithubReleaseUrl(url: string): string | null {
	const match: RegExpMatchArray | null = url.match(/\/releases\/tag\/([^/?#]+)/);
	if (match === null || match[1] === undefined) {
		return null;
	}
	return normalizeFrontendVersion(decodeURIComponent(match[1]));
}

function getGithubReleaseAssets(release: GithubRelease | null): GithubReleaseAsset[] {
	if (release === null || !Array.isArray(release.assets)) {
		return [];
	}
	return release.assets.filter((asset: unknown): asset is GithubReleaseAsset => {
		return typeof asset === "object" && asset !== null;
	});
}

async function readPluginCfgVersion(pluginCfgPath: string): Promise<string | null> {
	const text: string = await readFile(pluginCfgPath, "utf8").catch((): string => "");
	const match: RegExpMatchArray | null = text.match(/version="([^"]+)"/);
	return match?.[1] ?? null;
}

async function ensureStagedFrontendAddonLayout(stagedDir: string): Promise<string> {
	const expectedPluginDir: string = join(stagedDir, "addons", FRONTEND_ADDON_DIR_NAME);
	if (await isFile(join(expectedPluginDir, "plugin.cfg"))) {
		return expectedPluginDir;
	}

	const discoveredPluginDir: string | null = await findExtractedFrontendPluginDir(stagedDir);
	if (discoveredPluginDir === null) {
		throw new ManagerError({
			code: "manifest_invalid",
			message: "Frontend package does not contain godot_daedalus/plugin.cfg."
		});
	}

	await rm(expectedPluginDir, { recursive: true, force: true });
	await mkdir(dirname(expectedPluginDir), { recursive: true });
	await rename(discoveredPluginDir, expectedPluginDir).catch(async (): Promise<void> => {
		await copyDirectory(discoveredPluginDir, expectedPluginDir);
		await rm(discoveredPluginDir, { recursive: true, force: true });
	});
	return expectedPluginDir;
}

async function findExtractedFrontendPluginDir(root: string, depth: number = 0): Promise<string | null> {
	if (depth > 4) {
		return null;
	}
	const entries = await readdir(root, { withFileTypes: true }).catch((): [] => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const entryPath: string = join(root, entry.name);
		if (basename(entryPath) === FRONTEND_ADDON_DIR_NAME && await isFile(join(entryPath, "plugin.cfg"))) {
			return entryPath;
		}
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const found: string | null = await findExtractedFrontendPluginDir(join(root, entry.name), depth + 1);
		if (found !== null) {
			return found;
		}
	}
	return null;
}

async function isFile(filePath: string): Promise<boolean> {
	const fileStats = await stat(filePath).catch((): null => null);
	return fileStats !== null && fileStats.isFile();
}

async function fetchJsonWithPowerShell<T>(url: string): Promise<T | null> {
	const command: string = [
		"$ProgressPreference = 'SilentlyContinue';",
		`Invoke-RestMethod -Uri ${quotePowerShellString(url)} -Headers @{ 'User-Agent' = 'godot-daedalus-manager' } -TimeoutSec 30 | ConvertTo-Json -Depth 64 -Compress`
	].join(" ");
	const result = await runCommand("powershell.exe", [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		command
	], { timeoutMs: 45000 });
	if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
		return null;
	}

	try {
		return JSON.parse(result.stdout) as T;
	} catch {
		return null;
	}
}

async function downloadFileWithPowerShell(url: string, destination: string): Promise<string | null> {
	const command: string = [
		"$ProgressPreference = 'SilentlyContinue';",
		`Invoke-WebRequest -Uri ${quotePowerShellString(url)} -OutFile ${quotePowerShellString(destination)} -Headers @{ 'User-Agent' = 'godot-daedalus-manager' } -TimeoutSec 60`
	].join(" ");
	const result = await runCommand("powershell.exe", [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		command
	], { timeoutMs: 90000 });
	if (result.exitCode === 0) {
		return null;
	}
	return formatCommandError(result.exitCode, result.stderr, result.stdout);
}

async function downloadFileWithCurl(url: string, destination: string): Promise<string | null> {
	const result = await runCommand("curl.exe", [
		"-L",
		"--fail",
		"--show-error",
		"--silent",
		"--connect-timeout",
		"30",
		"--max-time",
		"90",
		"-H",
		"User-Agent: godot-daedalus-manager",
		"-o",
		destination,
		url
	], { timeoutMs: 100000 });
	if (result.exitCode === 0) {
		return null;
	}
	return formatCommandError(result.exitCode, result.stderr, result.stdout);
}

function quotePowerShellString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function formatCommandError(exitCode: number, stderr: string, stdout: string): string {
	const message: string = (stderr.trim() || stdout.trim() || "no output").slice(0, 2000);
	return `exit ${exitCode}: ${message}`;
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	hash.update(await readFile(filePath));
	return hash.digest("hex");
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
	if (process.platform === "win32") {
		const result = await runCommand("powershell.exe", [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			`Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`
		], { timeoutMs: 60000 });
		if (result.exitCode !== 0) {
			throw new ManagerError({ code: "process_failed", message: "Failed to extract frontend zip.", details: result.stderr || result.stdout });
		}
		return;
	}
	const result = await runCommand("unzip", ["-q", zipPath, "-d", destination], { timeoutMs: 60000 });
	if (result.exitCode !== 0) {
		throw new ManagerError({ code: "process_failed", message: "Failed to extract frontend zip.", details: result.stderr || result.stdout });
	}
}

async function copyDirectory(source: string, destination: string): Promise<void> {
	await mkdir(destination, { recursive: true });
	const entries = await readdir(source, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath: string = join(source, entry.name);
		const destinationPath: string = join(destination, entry.name);
		if (entry.isDirectory()) {
			await copyDirectory(sourcePath, destinationPath);
		} else if (entry.isFile()) {
			await mkdir(dirname(destinationPath), { recursive: true });
			await copyFile(sourcePath, destinationPath);
		}
	}
}
