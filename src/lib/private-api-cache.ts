const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

type CacheEntry = {
	expiresAt: number;
	request: Promise<unknown>;
};

export type MemoryRequestCache = {
	clear(): void;
	get<T>(key: string, load: () => Promise<T>, maxAgeMs?: number): Promise<T>;
};

export function createMemoryRequestCache(now: () => number = Date.now): MemoryRequestCache {
	const entries = new Map<string, CacheEntry>();

	return {
		clear(): void {
			entries.clear();
		},
		async get<T>(key: string, load: () => Promise<T>, maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<T> {
			const current = entries.get(key);
			if (current && current.expiresAt > now()) return current.request as Promise<T>;

			const request = load();
			entries.set(key, { expiresAt: now() + maxAgeMs, request });
			try {
				return await request;
			} catch (error) {
				if (entries.get(key)?.request === request) entries.delete(key);
				throw error;
			}
		}
	};
}

// The server renders these pages too. Keep private response reuse strictly inside one browser tab.
const privateApiCache = typeof window === 'undefined' ? null : createMemoryRequestCache();

export function reusePrivateApiGet<T>(
	key: string,
	load: () => Promise<T>,
	maxAgeMs = DEFAULT_MAX_AGE_MS
): Promise<T> {
	return privateApiCache ? privateApiCache.get(key, load, maxAgeMs) : load();
}

export function clearPrivateApiCache(): void {
	privateApiCache?.clear();
}
