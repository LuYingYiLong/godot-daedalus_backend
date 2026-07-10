export const DEFAULT_BACKEND_PORT: number = 38180;
export const BACKEND_PACKAGE_NAME: string = "daedalus-backend";
export const BACKEND_BIN_NAME: string = "godot-daedalus-backend";
export const FRONTEND_REPOSITORY: string = "LuYingYiLong/godot-daedalus";
export const FRONTEND_ADDON_DIR_NAME: string = "godot_daedalus";

export type JsonObject = Record<string, unknown>;

export type ManagerErrorCode =
	| "invalid_arguments"
	| "invalid_path"
	| "not_installed"
	| "network_error"
	| "install_failed"
	| "health_failed"
	| "process_failed"
	| "manifest_invalid"
	| "hash_mismatch"
	| "frontend_update_missing"
	| "unknown_error";

export type ManagerFailure = {
	ok: false;
	code: ManagerErrorCode;
	message: string;
	details?: string;
	logPath?: string;
	suggestedAction?: string;
};

export type ManagerSuccess<T extends JsonObject = JsonObject> = {
	ok: true;
} & T;

export type ManagerResult<T extends JsonObject = JsonObject> = ManagerSuccess<T> | ManagerFailure;

export type BackendCurrentFile = {
	version: string;
	path: string;
	previousVersion?: string;
	updatedAt: string;
};

export type BackendPidFile = {
	pid: number;
	version: string;
	port: number;
	url: string;
	logPath: string;
	startedAt: string;
};

export type FrontendManifest = {
	version: string;
	tag: string;
	sha256: string;
	assetName: string;
	minGodotVersion?: string;
};

export type PendingFrontendUpdate = {
	version: string;
	sourceZipPath: string;
	stagedDir: string;
	manifest: FrontendManifest;
	createdAt: string;
};

export type ManagerStatus = {
	frontend: {
		installedVersion: string | null;
		latestVersion: string | null;
		pendingVersion: string | null;
	};
	backend: {
		installedVersion: string | null;
		latestVersion: string | null;
		runningVersion: string | null;
		pid: number | null;
	};
	health: {
		ok: boolean;
		url: string;
		error: string | null;
	};
};
