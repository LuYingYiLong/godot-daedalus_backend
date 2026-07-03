export type BackendRuntimeMode = "development" | "runtime";

export const PUBLISHED_BACKEND_PORT: number = 38180;
export const DEVELOPMENT_BACKEND_PORT: number = 38181;

export function getBackendRuntimeMode(): BackendRuntimeMode {
	const explicitMode: string | undefined = process.env.DAEDALUS_BACKEND_MODE;
	if (explicitMode === "development" || explicitMode === "runtime") {
		return explicitMode;
	}

	if (process.env.NODE_ENV === "development" || process.env.npm_lifecycle_event === "dev") {
		return "development";
	}

	return "runtime";
}

export function getDefaultBackendPort(mode: BackendRuntimeMode = getBackendRuntimeMode()): number {
	return mode === "development" ? DEVELOPMENT_BACKEND_PORT : PUBLISHED_BACKEND_PORT;
}

export function getBackendPortFromEnv(): number {
	const mode: BackendRuntimeMode = getBackendRuntimeMode();
	const portText: string = process.env.PORT ?? String(getDefaultBackendPort(mode));
	const port: number = Number.parseInt(portText, 10);

	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(`Invalid PORT: ${portText}`);
	}

	return port;
}
