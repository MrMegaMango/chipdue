const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STATUS_MAX_AGE_MS = 5 * 60 * 1000;
const pacificDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });

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
	localDate: string;
	request: Promise<unknown>;
};

export type MemoryRequestCache = {
	clear(): void;
	delete(key: string): void;
	alias<T>(source: string, target: string, select: (value: T) => unknown): void;
	get<T>(key: string, load: () => Promise<T>, maxAgeMs?: number): Promise<T>;
};

export function createMemoryRequestCache(now: () => number = Date.now): MemoryRequestCache {
	const entries = new Map<string, CacheEntry>();
	let generation = 0;

	return {
		clear(): void {
			generation += 1;
			entries.clear();
		},
		delete(key: string): void {
			entries.delete(key);
		},
		alias<T>(source: string, target: string, select: (value: T) => unknown): void {
			const entry = entries.get(source);
			const localDate = pacificDate.format(now());
			if (!entry || entry.expiresAt <= now() || entry.localDate !== localDate) return;
			const existing = entries.get(target);
			if (existing && existing.expiresAt > now() && existing.localDate === localDate) return;
			entries.set(target, {
				expiresAt: entry.expiresAt,
				localDate: entry.localDate,
				request: entry.request.then((value) => select(value as T))
			});
		},
		async get<T>(key: string, load: () => Promise<T>, maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<T> {
			const startedGeneration = generation;
			const current = entries.get(key);
			const localDate = pacificDate.format(now());
			const request =
				current && current.expiresAt > now() && current.localDate === localDate
					? current.request
					: load();
			if (request !== current?.request) {
				entries.set(key, { expiresAt: now() + maxAgeMs, localDate, request });
			}
			try {
				const value = await request;
				if (startedGeneration !== generation) {
					throw new DOMException('The private cache was cleared.', 'AbortError');
				}
				return value as T;
			} catch (error) {
				if (entries.get(key)?.request === request) entries.delete(key);
				if (startedGeneration !== generation) {
					throw new DOMException('The private cache was cleared.', 'AbortError');
				}
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
let privateDataRevision: string | null = null;
let privateDataDate: string | null = null;

function maxAgeFor(key: string): number {
	// Session, provider setup, and explicitly requested live orders keep their short lifetime.
	return /\/api\/(?:auth|plaid|connections|etrade)(?:\/|\?|$)|\/orders(?:\?|$)/.test(key)
		? STATUS_MAX_AGE_MS
		: DEFAULT_MAX_AGE_MS;
}

export function reusePrivateApiGet<T>(
	key: string,
	load: () => Promise<T>,
	maxAgeMs = maxAgeFor(key)
): Promise<T> {
	return privateApiCache ? privateApiCache.get(key, load, maxAgeMs) : load();
}

export function clearPrivateApiCache(): void {
	privateApiCache?.clear();
	conditionalApiCache?.clear();
	privateDataRevision = null;
	privateDataDate = null;
}

// Session checks carry the saved-record revision, so a completed bank pull invalidates
// financial results without downloading them on every navigation or polling the page.
export function rememberPrivateDataRevision(revision: string | null): boolean {
	if (!revision) return false;
	const localDate = pacificDate.format(Date.now());
	const changed =
		privateDataRevision !== null &&
		(privateDataRevision !== revision || privateDataDate !== localDate);
	if (changed) clearPrivateApiCache();
	privateDataRevision = revision;
	privateDataDate = localDate;
	return changed;
}

export function aliasPrivateApiGet<T>(
	source: string,
	target: string,
	select: (value: T) => unknown
): void {
	privateApiCache?.alias(source, target, select);
}

export function forgetPrivateApiGet(key: string): void {
	privateApiCache?.delete(key);
}

export async function revalidatePrivateApiGet<T>(
	key: string,
	load: (etag: string | null) => Promise<Response>
): Promise<T> {
	return reusePrivateApiGet(key, () =>
		conditionalApiCache
			? conditionalApiCache.get<T>(key, load)
			: load(null).then((response) => response.json() as Promise<T>)
	);
}
