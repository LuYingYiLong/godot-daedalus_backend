import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { FRONTEND_ADDON_DIR_NAME, FRONTEND_REPOSITORY, type FrontendManifest, type PendingFrontendUpdate } from "./types.js";
import { ManagerError } from "./manager-error.js";
import { assertInside, getManagerPaths, resolveProjectPluginDir, type ManagerPaths } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./json-file.js";
import { getCachedOrFetchLatestVersion, type LatestVersionOptions } from "./latest-cache.js";
import { runCommand } from "./process.js";

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
	const data: { tag_name?: unknown } | null = await fetchJsonWithFallback<{ tag_name?: unknown }>(
		`https://api.github.com/repos/${FRONTEND_REPOSITORY}/releases/latest`
	);
	if (data === null) {
		return null;
	}
	if (typeof data.tag_name !== "string") {
		return null;
	}
	return data.tag_name.replace(/^v/, "");
}

export async function getPendingFrontendVersion(): Promise<string | null> {
	const paths: ManagerPaths = getManagerPaths();
	const pending: PendingFrontendUpdate | null = await readJsonFile<PendingFrontendUpdate>(paths.pendingFrontendUpdatePath);
	return pending?.version ?? null;
}

export async function downloadAndStageFrontend(version: string): Promise<PendingFrontendUpdate> {
	const manifest: FrontendManifest = await downloadFrontendManifest(version);
	validateFrontendManifest(manifest);
	const paths: ManagerPaths = getManagerPaths();
	await mkdir(paths.frontendDownloadsDir, { recursive: true });
	await mkdir(paths.frontendStagedDir, { recursive: true });
	const zipPath: string = assertInside(paths.frontendDownloadsDir, join(paths.frontendDownloadsDir, manifest.assetName));
	const stagedDir: string = assertInside(paths.frontendStagedDir, join(paths.frontendStagedDir, manifest.version));

	await downloadFile(getReleaseAssetUrl(manifest.tag, manifest.assetName), zipPath);
	const hash: string = await sha256File(zipPath);
	if (hash.toLowerCase() !== manifest.sha256.toLowerCase()) {
		throw new ManagerError({
			code: "hash_mismatch",
			message: "Downloaded frontend package hash does not match manifest.",
			details: `Expected ${manifest.sha256}, got ${hash}`
		});
	}

	await rm(stagedDir, { recursive: true, force: true });
	await mkdir(stagedDir, { recursive: true });
	await extractZip(zipPath, stagedDir);
	const stagedPluginCfg: string = join(stagedDir, "addons", FRONTEND_ADDON_DIR_NAME, "plugin.cfg");
	const stagedStats = await stat(stagedPluginCfg).catch((): null => null);
	if (stagedStats === null || !stagedStats.isFile()) {
		throw new ManagerError({
			code: "manifest_invalid",
			message: "Frontend package does not contain addons/godot_daedalus/plugin.cfg."
		});
	}

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
	await rename(pluginDir, backupDir).catch(async (): Promise<void> => {
		await rm(backupDir, { recursive: true, force: true });
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
}

async function downloadFrontendManifest(version: string): Promise<FrontendManifest> {
	const tag: string = version.startsWith("v") ? version : `v${version}`;
	const assetName: string = `godot-daedalus-plugin-${tag}.manifest.json`;
	const manifest: FrontendManifest | null = await fetchJsonWithFallback<FrontendManifest>(getReleaseAssetUrl(tag, assetName));
	if (manifest === null) {
		throw new ManagerError({
			code: "network_error",
			message: `Could not download frontend manifest ${assetName}.`,
			details: "GitHub release manifest request failed."
		});
	}
	return manifest;
}

function getReleaseAssetUrl(tag: string, assetName: string): string {
	return `https://github.com/${FRONTEND_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

async function downloadFile(url: string, destination: string): Promise<void> {
	await mkdir(dirname(destination), { recursive: true });
	try {
		const response: Response = await fetch(url, { headers: { "User-Agent": "godot-daedalus-manager" } });
		if (!response.ok || response.body === null) {
			throw new Error(`${response.status} ${response.statusText}`);
		}
		await pipeline(response.body, createWriteStream(destination));
		return;
	} catch (error: unknown) {
		if (process.platform === "win32" && await downloadFileWithPowerShell(url, destination)) {
			return;
		}
		throw new ManagerError({
			code: "network_error",
			message: `Could not download ${url}`,
			details: error instanceof Error ? error.message : String(error)
		});
	}
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

async function downloadFileWithPowerShell(url: string, destination: string): Promise<boolean> {
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
	return result.exitCode === 0;
}

function quotePowerShellString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
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
