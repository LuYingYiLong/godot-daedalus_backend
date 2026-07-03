import { DEFAULT_BACKEND_PORT, type BackendPidFile, type ManagerStatus } from "./types.js";
import { getInstalledBackendVersion, getLatestBackendVersion, getRunningBackend, healthBackend } from "./backend.js";
import { getInstalledFrontendVersion, getLatestFrontendVersion, getPendingFrontendVersion } from "./frontend.js";

export async function readStatus(projectPath: string | undefined): Promise<ManagerStatus> {
	const running: BackendPidFile | null = await getRunningBackend();
	const url: string = running?.url ?? `ws://localhost:${DEFAULT_BACKEND_PORT}`;
	const health = await healthBackend(url);
	return {
		frontend: {
			installedVersion: await getInstalledFrontendVersion(projectPath),
			latestVersion: await getLatestFrontendVersion(),
			pendingVersion: await getPendingFrontendVersion()
		},
		backend: {
			installedVersion: await getInstalledBackendVersion(),
			latestVersion: await getLatestBackendVersion(),
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
