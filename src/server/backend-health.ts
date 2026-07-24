import { getCurrentBackendLogPath } from "../logger.js";
import { getBackendBuildMetadata, type BackendDistribution } from "../runtime/build-metadata.js";
import { getUsageMetricsAvailabilitySnapshot } from "../usage/metrics-store.js";
import { getBackendPortFromEnv, getBackendRuntimeMode, type BackendRuntimeMode } from "./backend-runtime.js";

const BACKEND_HEALTH_NAME: string = "godot-daedalus-backend";

export type BackendHealthResult = {
	name: string;
	version: string;
	buildId: string;
	distribution: BackendDistribution;
	runtime: {
		nodeVersion: string;
		buildNodeVersion: string;
		platform: NodeJS.Platform;
		arch: string;
	};
	pid: number;
	mode: BackendRuntimeMode;
	port: number;
	multiClient: {
		enabled: boolean;
		protocolVersion: number;
	};
	logPath: string | null;
	metrics: {
		usage: {
			available: boolean | null;
			errorMessage?: string | undefined;
		};
	};
};

export function getBackendPackageVersion(): string {
	return getBackendBuildMetadata().version;
}

export function createBackendHealthResult(): BackendHealthResult {
	const build = getBackendBuildMetadata();
	return {
		name: BACKEND_HEALTH_NAME,
		version: build.version,
		buildId: build.buildId,
		distribution: build.distribution,
		runtime: {
			nodeVersion: build.runtimeNodeVersion,
			buildNodeVersion: build.buildNodeVersion,
			platform: build.platform,
			arch: build.arch
		},
		pid: process.pid,
		mode: getBackendRuntimeMode(),
		port: getBackendPortFromEnv(),
		multiClient: {
			enabled: true,
			protocolVersion: build.protocolVersion
		},
		logPath: getCurrentBackendLogPath(),
		metrics: {
			usage: getUsageMetricsAvailabilitySnapshot()
		}
	};
}
