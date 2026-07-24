import { DEFAULT_BACKEND_PORT, type BackendPidFile, type ManagerStatus } from "./types.js";
import { getInstalledBackendVersion, getLatestBackendVersion, getRunningBackend, healthBackend } from "./backend.js";
import { getInstalledFrontendVersion, getLatestFrontendVersion, getPendingFrontendVersion } from "./frontend.js";
import { isVersionNewer } from "./semver.js";

export type ReadStatusOptions = {
	includeLatest?: boolean;
};

export async function readStatus(projectPath: string | undefined, options: ReadStatusOptions = {}): Promise<ManagerStatus> {
	const includeLatest: boolean = options.includeLatest ?? true;
	const running: BackendPidFile | null = await getRunningBackend();
	const url: string = running?.url ?? `ws://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
	const health = await healthBackend(url);
	const installedFrontendVersion: string | null = await getInstalledFrontendVersion(projectPath);
	const pendingFrontendVersion: string | null = await getPendingFrontendVersion();
	return {
		frontend: {
			installedVersion: installedFrontendVersion,
			latestVersion: includeLatest ? await getLatestFrontendVersion() : null,
			pendingVersion: getActionablePendingFrontendVersion(pendingFrontendVersion, installedFrontendVersion)
		},
		backend: {
			installedVersion: await getInstalledBackendVersion(),
			latestVersion: includeLatest ? await getLatestBackendVersion() : null,
			runningVersion: running?.version ?? null,
			pid: running?.pid ?? null
		},
		health: {
			ok: health.ok,
			url,
			error: health.error
		}
	};
}

function getActionablePendingFrontendVersion(pendingVersion: string | null, installedVersion: string | null): string | null {
	if (pendingVersion === null || pendingVersion.trim() === "") {
		return null;
	}
	if (installedVersion === null || installedVersion.trim() === "") {
		return pendingVersion;
	}
	return isVersionNewer(pendingVersion, installedVersion) ? pendingVersion : null;
}
