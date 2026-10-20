const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

export class PrivateApiError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

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

type ConditionalRequestCache = {
	clear(): void;
	get<T>(key: string, load: (etag: string | null) => Promise<Response>): Promise<T>;
};

// Keep the body in this tab's memory while the server checks only its revision.
// HTTP and persistent browser caches remain disabled for private responses.
export function createConditionalRequestCache(): ConditionalRequestCache {
	const entries = new Map<string, { etag: string; value: unknown }>();
	const pending = new Map<string, Promise<unknown>>();
	let generation = 0;

	return {
		clear(): void {
			generation += 1;
			entries.clear();
			pending.clear();
		},
		async get<T>(key: string, load: (etag: string | null) => Promise<Response>): Promise<T> {
			const inFlight = pending.get(key);
			if (inFlight) return inFlight as Promise<T>;
			const cached = entries.get(key);
			const startedGeneration = generation;
			const assertCurrent = () => {
				if (startedGeneration !== generation) {
					throw new DOMException('The private cache was cleared.', 'AbortError');
				}
			};
			const request = (async (): Promise<T> => {
				let response: Response;
				try {
					response = await load(cached?.etag ?? null);
				} catch (error) {
					assertCurrent();
					throw error;
				}
				assertCurrent();
				if (response.status === 304) {
					if (!cached) throw new Error('No cached result is available.');
					return cached.value as T;
				}
				if (!response.ok) {
					throw new PrivateApiError(response.status, `Request failed (${response.status})`);
				}
				const value = (await response.json()) as T;
				assertCurrent();
				const etag = response.headers.get('etag');
				if (etag) entries.set(key, { etag, value });
				else entries.delete(key);
				return value;
			})();
			pending.set(key, request);
			try {
				return await request;
			} finally {
				if (pending.get(key) === request) pending.delete(key);
			}
		}
	};
}

// The server renders these pages too. Keep private response reuse strictly inside one browser tab.
const privateApiCache = typeof window === 'undefined' ? null : createMemoryRequestCache();
const conditionalApiCache = typeof window === 'undefined' ? null : createConditionalRequestCache();

export function reusePrivateApiGet<T>(
	key: string,
	load: () => Promise<T>,
	maxAgeMs = DEFAULT_MAX_AGE_MS
): Promise<T> {
	return privateApiCache ? privateApiCache.get(key, load, maxAgeMs) : load();
}

export function clearPrivateApiCache(): void {
	privateApiCache?.clear();
	conditionalApiCache?.clear();
}

export async function revalidatePrivateApiGet<T>(
	key: string,
	load: (etag: string | null) => Promise<Response>
): Promise<T> {
	return conditionalApiCache
		? conditionalApiCache.get<T>(key, load)
		: ((await (await load(null)).json()) as T);
}
