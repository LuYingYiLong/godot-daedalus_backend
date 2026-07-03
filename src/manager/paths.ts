import { join, resolve, sep } from "node:path";
import { getAppDataDir } from "../app-paths.js";
import { FRONTEND_ADDON_DIR_NAME } from "./types.js";
import { ManagerError } from "./manager-error.js";

export type ManagerPaths = {
	appDir: string;
	backendDir: string;
	backendVersionsDir: string;
	backendCurrentPath: string;
	backendRuntimeDir: string;
	backendPidPath: string;
	logsDir: string;
	updateCachePath: string;
	frontendDir: string;
	frontendDownloadsDir: string;
	frontendStagedDir: string;
	pendingFrontendUpdatePath: string;
};

export function getManagerAppDir(): string {
	const override: string | undefined = process.env.GODOT_DAEDALUS_APP_DIR;
	if (override !== undefined && override.trim() !== "") {
		return resolve(override);
	}

	return getAppDataDir();
}

export function getManagerPaths(): ManagerPaths {
	const appDir: string = getManagerAppDir();
	const backendDir: string = join(appDir, "backend");
	const frontendDir: string = join(appDir, "frontend");
	return {
		appDir,
		backendDir,
		backendVersionsDir: join(backendDir, "versions"),
		backendCurrentPath: join(backendDir, "current.json"),
		backendRuntimeDir: join(backendDir, "runtime"),
		backendPidPath: join(backendDir, "runtime", "backend.pid.json"),
		logsDir: join(appDir, "logs"),
		updateCachePath: join(appDir, "update-cache.json"),
		frontendDir,
		frontendDownloadsDir: join(frontendDir, "downloads"),
		frontendStagedDir: join(frontendDir, "staged"),
		pendingFrontendUpdatePath: join(frontendDir, "pending_frontend_update.json")
	};
}

export function assertInside(parentDir: string, childPath: string): string {
	const resolvedParent: string = resolve(parentDir);
	const resolvedChild: string = resolve(childPath);
	if (resolvedChild !== resolvedParent && !resolvedChild.startsWith(`${resolvedParent}${sep}`)) {
		throw new ManagerError({
			code: "invalid_path",
			message: `Refusing to operate outside managed directory: ${resolvedChild}`,
			details: `Allowed root: ${resolvedParent}`
		});
	}

	return resolvedChild;
}

export function resolveProjectPluginDir(projectPath: string | undefined): string | null {
	if (projectPath === undefined || projectPath.trim() === "") {
		return null;
	}

	const projectRoot: string = resolve(projectPath);
	return assertInside(projectRoot, join(projectRoot, "addons", FRONTEND_ADDON_DIR_NAME));
}
