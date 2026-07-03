import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBackendPortFromEnv, getBackendRuntimeMode, type BackendRuntimeMode } from "./backend-runtime.js";

const BACKEND_HEALTH_NAME: string = "godot-daedalus-backend";
const PACKAGE_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGE_JSON_PATH: string = resolve(PACKAGE_ROOT, "package.json");

type PackageManifest = {
	name?: unknown;
	version?: unknown;
};

export type BackendHealthResult = {
	name: string;
	version: string;
	pid: number;
	mode: BackendRuntimeMode;
	port: number;
};

let cachedPackageVersion: string | null = null;

export function getBackendPackageVersion(): string {
	if (cachedPackageVersion !== null) {
		return cachedPackageVersion;
	}

	const envVersion: string | undefined = process.env.npm_package_version;
	if (envVersion !== undefined && envVersion.trim() !== "") {
		cachedPackageVersion = envVersion.trim();
		return cachedPackageVersion;
	}

	try {
		const manifestText: string = readFileSync(PACKAGE_JSON_PATH, "utf8");
		const manifest: PackageManifest = JSON.parse(manifestText) as PackageManifest;
		if (typeof manifest.version === "string" && manifest.version.trim() !== "") {
			cachedPackageVersion = manifest.version.trim();
			return cachedPackageVersion;
		}
	} catch {
		// health 不能因为版本元数据不可读而阻断 WebSocket 启动。
	}

	cachedPackageVersion = "0.0.0";
	return cachedPackageVersion;
}

export function createBackendHealthResult(): BackendHealthResult {
	return {
		name: BACKEND_HEALTH_NAME,
		version: getBackendPackageVersion(),
		pid: process.pid,
		mode: getBackendRuntimeMode(),
		port: getBackendPortFromEnv()
	};
}
