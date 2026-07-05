import { getManagerPaths } from "./paths.js";
import { readJsonFile, writeJsonFile } from "./json-file.js";

export const LATEST_CACHE_TTL_MS: number = 60 * 60 * 1000;

export type LatestCacheKind = "backend" | "frontend";

type LatestCacheEntry = {
	version: string;
	checkedAt: string;
};

type LatestCacheFile = Partial<Record<LatestCacheKind, LatestCacheEntry>>;

export type LatestVersionOptions = {
	forceRefresh?: boolean;
	skipNetwork?: boolean;
	maxAgeMs?: number;
};

export async function getCachedOrFetchLatestVersion(
	kind: LatestCacheKind,
	fetchLatest: () => Promise<string | null>,
	options: LatestVersionOptions = {}
): Promise<string | null> {
	const cache: LatestCacheFile = await readLatestCache();
	const cached: LatestCacheEntry | undefined = cache[kind];
	const maxAgeMs: number = options.maxAgeMs ?? LATEST_CACHE_TTL_MS;
	if (!options.forceRefresh && isFreshCacheEntry(cached, maxAgeMs)) {
		return cached.version;
	}

	if (options.skipNetwork) {
		return cached?.version ?? null;
	}

	let latestVersion: string | null = null;
	try {
		latestVersion = await fetchLatest();
	} catch {
		return cached?.version ?? null;
	}
	if (latestVersion === null || latestVersion.trim() === "") {
		return cached?.version ?? null;
	}

	cache[kind] = {
		version: latestVersion.trim(),
		checkedAt: new Date().toISOString()
	};
	await writeJsonFile(getManagerPaths().updateCachePath, cache);
	return latestVersion.trim();
}

export async function readCachedLatestVersion(kind: LatestCacheKind): Promise<string | null> {
	const cache: LatestCacheFile = await readLatestCache();
	return cache[kind]?.version ?? null;
}

async function readLatestCache(): Promise<LatestCacheFile> {
	return (await readJsonFile<LatestCacheFile>(getManagerPaths().updateCachePath)) ?? {};
}

function isFreshCacheEntry(entry: LatestCacheEntry | undefined, maxAgeMs: number): entry is LatestCacheEntry {
	if (entry === undefined || entry.version.trim() === "") {
		return false;
	}

	const checkedAtMs: number = Date.parse(entry.checkedAt);
	if (!Number.isFinite(checkedAtMs)) {
		return false;
	}

	return Date.now() - checkedAtMs < maxAgeMs;
}
