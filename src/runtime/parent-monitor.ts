const DEFAULT_PARENT_CHECK_INTERVAL_MS: number = 1000;

export const STUDIO_PARENT_PID_ENV: string = "DAEDALUS_STUDIO_PID";

export function getStudioParentPidFromEnv(
	env: NodeJS.ProcessEnv = process.env
): number | null {
	const rawValue: string | undefined = env[STUDIO_PARENT_PID_ENV]?.trim();
	if (rawValue === undefined || rawValue.length === 0) {
		return null;
	}
	if (!/^\d+$/u.test(rawValue)) {
		throw new Error(`${STUDIO_PARENT_PID_ENV} must be a positive process ID.`);
	}
	const pid: number = Number.parseInt(rawValue, 10);
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
		throw new Error(`${STUDIO_PARENT_PID_ENV} must identify another live process.`);
	}
	return pid;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function startStudioParentMonitor(
	onParentExit: () => void,
	options: {
		intervalMs?: number | undefined;
		isAlive?: ((pid: number) => boolean) | undefined;
	} = {}
): () => void {
	const parentPid: number | null = getStudioParentPidFromEnv();
	if (parentPid === null) {
		return (): void => {};
	}
	const intervalMs: number = options.intervalMs ?? DEFAULT_PARENT_CHECK_INTERVAL_MS;
	const checkAlive: (pid: number) => boolean = options.isAlive ?? isProcessAlive;
	let stopped: boolean = false;
	const timer: NodeJS.Timeout = setInterval((): void => {
		if (stopped || checkAlive(parentPid)) {
			return;
		}
		stopped = true;
		clearInterval(timer);
		onParentExit();
	}, intervalMs);
	timer.unref();
	return (): void => {
		if (stopped) {
			return;
		}
		stopped = true;
		clearInterval(timer);
	};
}
