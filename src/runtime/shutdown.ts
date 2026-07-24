export type BackendShutdownHandler = (reason: string) => Promise<void>;

let shutdownHandler: BackendShutdownHandler | null = null;

export function registerBackendShutdownHandler(handler: BackendShutdownHandler | null): void {
	shutdownHandler = handler;
}

export function requestBackendShutdown(reason: string): boolean {
	const handler: BackendShutdownHandler | null = shutdownHandler;
	if (handler === null) {
		return false;
	}
	void handler(reason);
	return true;
}

