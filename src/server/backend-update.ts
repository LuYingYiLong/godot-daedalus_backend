import { getBackendPackageVersion } from "./backend-health.js";
import { getCurrentBackend, getInstalledBackendVersion, getLatestBackendVersion, installBackend } from "../manager/backend.js";
import { isVersionNewer } from "../manager/semver.js";

export type BackendUpdateCheckResult = {
	currentVersion: string;
	installedVersion: string | null;
	latestVersion: string | null;
	updateAvailable: boolean;
	checkedAt: string;
	errorMessage: string | null;
};

export type BackendUpdateInstallParams = {
	version?: string | undefined;
};

export type BackendUpdateInstallResult = {
	installed: true;
	version: string;
	previousVersion: string | null;
	installedAt: string;
};

type BackendUpdateCheckInput = {
	currentVersion: string;
	installedVersion: string | null;
	latestVersion: string | null;
	checkedAt: string;
	errorMessage: string | null;
};

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getEffectiveCurrentVersion(installedVersion: string | null): string {
	return installedVersion ?? getBackendPackageVersion();
}

export function createBackendUpdateCheckResult(input: BackendUpdateCheckInput): BackendUpdateCheckResult {
	return {
		currentVersion: input.currentVersion,
		installedVersion: input.installedVersion,
		latestVersion: input.latestVersion,
		updateAvailable: input.latestVersion !== null && isVersionNewer(input.latestVersion, input.currentVersion),
		checkedAt: input.checkedAt,
		errorMessage: input.errorMessage
	};
}

export function createBackendUpdateInstallResult(version: string, previousVersion: string | null, installedAt: string): BackendUpdateInstallResult {
	return {
		installed: true,
		version,
		previousVersion,
		installedAt
	};
}

export async function checkBackendUpdate(): Promise<BackendUpdateCheckResult> {
	const installedVersion: string | null = await getInstalledBackendVersion();
	const currentVersion: string = getEffectiveCurrentVersion(installedVersion);
	let latestVersion: string | null = null;
	let errorMessage: string | null = null;

	try {
		latestVersion = await getLatestBackendVersion({ forceRefresh: true });
	} catch (error: unknown) {
		errorMessage = getErrorMessage(error);
	}

	return createBackendUpdateCheckResult({
		currentVersion,
		installedVersion,
		latestVersion,
		checkedAt: new Date().toISOString(),
		errorMessage
	});
}

export async function installBackendUpdate(params: BackendUpdateInstallParams = {}): Promise<BackendUpdateInstallResult> {
	const current = await getCurrentBackend();
	const versionSpec: string = typeof params.version === "string" && params.version.trim().length > 0
		? params.version.trim()
		: "latest";
	const installed = await installBackend(versionSpec);

	return createBackendUpdateInstallResult(installed.version, current?.version ?? null, new Date().toISOString());
}
