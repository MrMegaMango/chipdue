import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createConditionalRequestCache,
	createMemoryRequestCache,
	PrivateApiError
} from './private-api-cache';

describe('memory-only private API cache', () => {
	it('reuses resolved and in-flight requests until they expire', async () => {
		let now = 1_000;
		const cache = createMemoryRequestCache(() => now);
		const load = vi.fn(async () => ({ value: load.mock.calls.length }));

		const first = cache.get('/api/accounts', load, 500);
		const duplicate = cache.get('/api/accounts', load, 500);
		expect(await first).toEqual({ value: 1 });
		expect(await duplicate).toEqual({ value: 1 });
		expect(load).toHaveBeenCalledTimes(1);

		now = 1_501;
		expect(await cache.get('/api/accounts', load, 500)).toEqual({ value: 2 });
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('clears cached responses explicitly', async () => {
		const cache = createMemoryRequestCache();
		const load = vi.fn(async () => 'fresh');

		await cache.get('/api/cards', load);
		cache.clear();
		await cache.get('/api/cards', load);

		expect(load).toHaveBeenCalledTimes(2);
	});

	it('does not retain failed requests', async () => {
		const cache = createMemoryRequestCache();
		const load = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error('temporary failure'))
			.mockResolvedValueOnce('recovered');

		await expect(cache.get('/api/bonuses', load)).rejects.toThrow('temporary failure');
		await expect(cache.get('/api/bonuses', load)).resolves.toBe('recovered');
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('shares dashboard sections without extending the original snapshot expiry', async () => {
		let now = 0;
		const cache = createMemoryRequestCache(() => now);
		const snapshot = { cards: ['saved card'] };
		await cache.get('/api/dashboard', async () => snapshot, 1_000);
		now = 600;
		cache.alias<typeof snapshot>('/api/dashboard', '/api/cards', (value) => value.cards);
		const loadCards = vi.fn(async () => ['fresh card']);
		expect(await cache.get('/api/cards', loadCards)).toEqual(['saved card']);
		expect(loadCards).not.toHaveBeenCalled();

		now = 999;
		cache.alias<typeof snapshot>('/api/dashboard', '/api/cards', (value) => value.cards);
		now = 1_000;
		expect(await cache.get('/api/cards', loadCards)).toEqual(['fresh card']);
		expect(loadCards).toHaveBeenCalledOnce();
	});

	it('does not replace a current page response with an older dashboard alias', async () => {
		const cache = createMemoryRequestCache();
		const snapshot = { cards: ['older dashboard card'] };
		await cache.get('/api/dashboard', async () => snapshot);
		await cache.get('/api/cards', async () => ['current card']);
		cache.alias<typeof snapshot>('/api/dashboard', '/api/cards', (value) => value.cards);
		const loadCards = vi.fn(async () => ['unneeded request']);
		expect(await cache.get('/api/cards', loadCards)).toEqual(['current card']);
		expect(loadCards).not.toHaveBeenCalled();
	});

	it('discards in-flight responses and their aliases after clearing private data', async () => {
		const cache = createMemoryRequestCache();
		const response = Promise.withResolvers<{ cards: string[] }>();
		const oldRequest = cache.get('/api/dashboard', () => response.promise);
		cache.alias<{ cards: string[] }>('/api/dashboard', '/api/cards', (value) => value.cards);
		const oldAlias = cache.get('/api/cards', async () => ['unexpected']);
		const rejected = Promise.all([
			expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' }),
			expect(oldAlias).rejects.toMatchObject({ name: 'AbortError' })
		]);

		cache.clear();
		const freshLoad = vi.fn(async () => ['new session card']);
		await cache.get('/api/cards', freshLoad);
		response.resolve({ cards: ['old session card'] });
		await rejected;
		cache.alias<{ cards: string[] }>('/api/dashboard', '/api/cards', (value) => value.cards);
		expect(await cache.get('/api/cards', freshLoad)).toEqual(['new session card']);
		expect(freshLoad).toHaveBeenCalledOnce();
	});

	it('suppresses a late unauthorized error without evicting a newer session result', async () => {
		const cache = createMemoryRequestCache();
		const response = Promise.withResolvers<string>();
		const oldRequest = cache.get('/api/accounts', () => response.promise);
		const rejected = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });
		cache.clear();
		const freshLoad = vi.fn(async () => 'new session');
		await cache.get('/api/accounts', freshLoad);
		response.reject(new PrivateApiError(401, 'Expired old session'));
		await rejected;
		expect(await cache.get('/api/accounts', freshLoad)).toBe('new session');
		expect(freshLoad).toHaveBeenCalledOnce();
	});

	it('forgets one failed dashboard snapshot without discarding other page data', async () => {
		const cache = createMemoryRequestCache();
		const loadAccounts = vi.fn(async () => ['account']);
		const loadDashboard = vi
			.fn<() => Promise<{ ok: boolean }>>()
			.mockResolvedValueOnce({ ok: false })
			.mockResolvedValueOnce({ ok: true });
		await cache.get('/api/accounts', loadAccounts);
		await cache.get('/api/dashboard', loadDashboard);
		cache.delete('/api/dashboard');
		expect(await cache.get('/api/dashboard', loadDashboard)).toEqual({ ok: true });
		await cache.get('/api/accounts', loadAccounts);
		expect(loadDashboard).toHaveBeenCalledTimes(2);
		expect(loadAccounts).toHaveBeenCalledOnce();
	});
});

describe('browser private API reuse', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-03T18:00:00Z'));
		vi.stubGlobal('window', {});
		vi.resetModules();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it('reuses financial data across navigation beyond five minutes, with a daily safety expiry', async () => {
		// This Pacific date lasts 25 hours, so the 24-hour cap expires before midnight.
		vi.setSystemTime(new Date('2026-11-01T07:00:00Z'));
		const { reusePrivateApiGet } = await import('./private-api-cache');
		const load = vi.fn(async () => ({ version: load.mock.calls.length }));
		const initial = await reusePrivateApiGet('/api/accounts', load);
		vi.advanceTimersByTime(6 * 60 * 1000);
		expect(await reusePrivateApiGet('/api/accounts', load)).toBe(initial);
		vi.advanceTimersByTime(23 * 60 * 60 * 1000);
		expect(await reusePrivateApiGet('/api/accounts', load)).toBe(initial);
		expect(load).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(54 * 60 * 1000);
		expect(await reusePrivateApiGet('/api/accounts', load)).toEqual({ version: 2 });
	});

	it.each(['2026-11-04T07:59:00Z', '2026-07-04T06:59:00Z'])(
		'refreshes finances and date-dependent tracking at Pacific midnight after %s',
		async (beforeMidnight) => {
			vi.setSystemTime(new Date(beforeMidnight));
			const { reusePrivateApiGet, revalidatePrivateApiGet, rememberPrivateDataRevision } =
				await import('./private-api-cache');
			const accounts = vi.fn(async () => ({ version: accounts.mock.calls.length }));
			const tracking = vi.fn<(etag: string | null) => Promise<Response>>(
				async (): Promise<Response> =>
					Response.json(
						{ version: tracking.mock.calls.length },
						{ headers: { etag: `W/"tracking-day-${tracking.mock.calls.length}"` } }
					)
			);
			rememberPrivateDataRevision('unchanged-records');
			await reusePrivateApiGet('/api/accounts', accounts);
			await revalidatePrivateApiGet('/api/bonuses/tracking', tracking);
			vi.advanceTimersByTime(30_000);
			await reusePrivateApiGet('/api/accounts', accounts);
			await revalidatePrivateApiGet('/api/bonuses/tracking', tracking);
			expect(accounts).toHaveBeenCalledOnce();
			expect(tracking).toHaveBeenCalledOnce();

			vi.advanceTimersByTime(30_000);
			expect(await reusePrivateApiGet('/api/accounts', accounts)).toEqual({ version: 2 });
			expect(await revalidatePrivateApiGet('/api/bonuses/tracking', tracking)).toEqual({
				version: 2
			});
			expect(tracking.mock.calls).toEqual([[null], ['W/"tracking-day-1"']]);
		}
	);

	it('notifies mounted pages at Pacific midnight even when their saved records are unchanged', async () => {
		vi.setSystemTime(new Date('2026-11-04T07:59:00Z'));
		const { rememberPrivateDataRevision, reusePrivateApiGet } = await import('./private-api-cache');
		const load = vi.fn(async () => 'current finances');
		expect(rememberPrivateDataRevision('same-records')).toBe(false);
		await reusePrivateApiGet('/api/accounts', load);
		vi.advanceTimersByTime(30_000);
		expect(rememberPrivateDataRevision('same-records')).toBe(false);
		vi.advanceTimersByTime(30_000);
		expect(rememberPrivateDataRevision('same-records')).toBe(true);
		expect(rememberPrivateDataRevision('same-records')).toBe(false);
		await reusePrivateApiGet('/api/accounts', load);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it.each([
		'/api/auth/session',
		'/api/connections',
		'/api/plaid/status',
		'/api/etrade/status',
		'/api/accounts/account-id/orders'
	])('keeps the five-minute lifetime for %s', async (url) => {
		const { reusePrivateApiGet } = await import('./private-api-cache');
		const load = vi.fn(async () => ({ version: load.mock.calls.length }));
		const initial = await reusePrivateApiGet(url, load);
		vi.advanceTimersByTime(5 * 60 * 1000 - 1);
		expect(await reusePrivateApiGet(url, load)).toBe(initial);
		vi.advanceTimersByTime(1);
		expect(await reusePrivateApiGet(url, load)).toEqual({ version: 2 });
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('checks tracking once across repeated page visits until its memory entry expires', async () => {
		const { revalidatePrivateApiGet } = await import('./private-api-cache');
		const load = vi
			.fn<(etag: string | null) => Promise<Response>>()
			.mockResolvedValueOnce(
				Response.json({ paid: true }, { headers: { etag: 'W/"saved-revision"' } })
			)
			.mockResolvedValueOnce(new Response(null, { status: 304 }));
		const first = revalidatePrivateApiGet('/api/bonuses/tracking', load);
		const duplicate = revalidatePrivateApiGet('/api/bonuses/tracking', load);
		const initial = await first;
		expect(await duplicate).toBe(initial);
		vi.advanceTimersByTime(6 * 60 * 1000);
		expect(await revalidatePrivateApiGet('/api/bonuses/tracking', load)).toBe(initial);
		expect(load.mock.calls).toEqual([[null]]);
		vi.advanceTimersByTime((24 * 60 - 6) * 60 * 1000);
		expect(await revalidatePrivateApiGet('/api/bonuses/tracking', load)).toBe(initial);
		expect(load.mock.calls).toEqual([[null], ['W/"saved-revision"']]);
	});

	it('invalidates both financial and tracking results only when the saved revision changes', async () => {
		const { reusePrivateApiGet, revalidatePrivateApiGet, rememberPrivateDataRevision } =
			await import('./private-api-cache');
		const accounts = vi.fn(async () => ({ version: accounts.mock.calls.length }));
		const tracking = vi.fn<(etag: string | null) => Promise<Response>>(
			async (): Promise<Response> =>
				Response.json(
					{ version: tracking.mock.calls.length },
					{ headers: { etag: 'W/"tracking"' } }
				)
		);
		expect(rememberPrivateDataRevision('records-1')).toBe(false);
		await reusePrivateApiGet('/api/accounts', accounts);
		await revalidatePrivateApiGet('/api/bonuses/tracking', tracking);
		vi.advanceTimersByTime(6 * 60 * 1000);
		expect(rememberPrivateDataRevision(null)).toBe(false);
		expect(rememberPrivateDataRevision('records-1')).toBe(false);
		expect(await reusePrivateApiGet('/api/accounts', accounts)).toEqual({ version: 1 });
		expect(await revalidatePrivateApiGet('/api/bonuses/tracking', tracking)).toEqual({
			version: 1
		});
		expect(accounts).toHaveBeenCalledOnce();
		expect(tracking).toHaveBeenCalledOnce();

		expect(rememberPrivateDataRevision('records-2')).toBe(true);
		expect(await reusePrivateApiGet('/api/accounts', accounts)).toEqual({ version: 2 });
		expect(await revalidatePrivateApiGet('/api/bonuses/tracking', tracking)).toEqual({
			version: 2
		});
		expect(tracking.mock.calls).toEqual([[null], [null]]);
		expect(rememberPrivateDataRevision('records-2')).toBe(false);
	});

	it('invalidates an in-flight tracking request when a completed bank pull changes the revision', async () => {
		const { revalidatePrivateApiGet, rememberPrivateDataRevision } =
			await import('./private-api-cache');
		rememberPrivateDataRevision('records-1');
		const response = Promise.withResolvers<Response>();
		const oldRequest = revalidatePrivateApiGet('/api/bonuses/tracking', () => response.promise);
		const rejected = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });
		rememberPrivateDataRevision('records-2');
		const freshLoad = vi.fn<(etag: string | null) => Promise<Response>>(async () =>
			Response.json({ paid: true }, { headers: { etag: 'W/"new-tracking"' } })
		);
		await revalidatePrivateApiGet('/api/bonuses/tracking', freshLoad);
		response.resolve(Response.json({ paid: false }, { headers: { etag: 'W/"old-tracking"' } }));
		await rejected;
		expect(await revalidatePrivateApiGet('/api/bonuses/tracking', freshLoad)).toEqual({
			paid: true
		});
		expect(freshLoad).toHaveBeenCalledOnce();
		expect(freshLoad).toHaveBeenCalledWith(null);
	});
});

describe('conditional private API cache', () => {
	function result(value: unknown, etag = 'W/"revision-1"') {
		return Response.json(value, { headers: { etag } });
	}

	it('keeps the same result until the server revision changes', async () => {
		const cache = createConditionalRequestCache();
		const load = vi
			.fn<(etag: string | null) => Promise<Response>>()
			.mockResolvedValueOnce(result({ paid: false }))
			.mockResolvedValueOnce(new Response(null, { status: 304 }))
			.mockResolvedValueOnce(result({ paid: true }, 'W/"revision-2"'))
			.mockResolvedValueOnce(new Response(null, { status: 304 }));

		const initial = await cache.get('/tracking', load);
		expect(await cache.get('/tracking', load)).toBe(initial);
		expect(await cache.get('/tracking', load)).toEqual({ paid: true });
		expect(await cache.get('/tracking', load)).toEqual({ paid: true });
		expect(load.mock.calls).toEqual([
			[null],
			['W/"revision-1"'],
			['W/"revision-1"'],
			['W/"revision-2"']
		]);
	});

	it('shares concurrent checks without sharing an individual caller abort signal', async () => {
		const cache = createConditionalRequestCache();
		const response = Promise.withResolvers<Response>();
		const load = vi.fn(() => response.promise);
		const first = cache.get('/tracking', load);
		const second = cache.get('/tracking', load);
		response.resolve(result({ value: 1 }));
		expect(await first).toEqual({ value: 1 });
		expect(await second).toEqual({ value: 1 });
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('does not restore or return an old result after a mutation or sign-out clears the cache', async () => {
		const cache = createConditionalRequestCache();
		const response = Promise.withResolvers<Response>();
		const oldRequest = cache.get('/tracking', () => response.promise);
		const rejected = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });
		cache.clear();
		const freshLoad = vi.fn(async () => result({ value: 'new' }, 'W/"new"'));
		await cache.get('/tracking', freshLoad);
		response.resolve(result({ value: 'old' }));
		await rejected;
		const recheck = vi.fn(async () => new Response(null, { status: 304 }));
		expect(await cache.get('/tracking', recheck)).toEqual({ value: 'new' });
		expect(freshLoad).toHaveBeenCalledWith(null);
		expect(recheck).toHaveBeenCalledWith('W/"new"');
	});

	it('does not return a cached body when a conditional request loses authorization', async () => {
		const cache = createConditionalRequestCache();
		await cache.get('/tracking', async () => result({ value: 'private' }));
		await expect(
			cache.get('/tracking', async () => new Response(null, { status: 401 }))
		).rejects.toThrow('Request failed (401)');
		cache.clear();
		const nextSession = vi.fn(async () => result({ value: 'other session' }));
		expect(await cache.get('/tracking', nextSession)).toEqual({ value: 'other session' });
		expect(nextSession).toHaveBeenCalledWith(null);
	});

	it('lets each page handle session expiry when navigation shares an in-flight check', async () => {
		const cache = createConditionalRequestCache();
		const response = Promise.withResolvers<Response>();
		const load = vi.fn(() => response.promise);
		const firstPage = vi.fn();
		const activePage = vi.fn();
		const check = (expired: () => void) =>
			cache.get('/tracking', load).catch((error: unknown) => {
				if (error instanceof PrivateApiError && error.status === 401) expired();
			});
		const first = check(firstPage);
		const next = check(activePage);
		response.resolve(new Response(null, { status: 401 }));
		await Promise.all([first, next]);
		expect(load).toHaveBeenCalledTimes(1);
		expect(firstPage).toHaveBeenCalledOnce();
		expect(activePage).toHaveBeenCalledOnce();
	});

	it('ignores an old session error after the cache has been cleared', async () => {
		const cache = createConditionalRequestCache();
		const response = Promise.withResolvers<Response>();
		const oldRequest = cache.get('/tracking', () => response.promise);
		const rejected = expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });
		cache.clear();
		response.reject(new PrivateApiError(401, 'Expired old session'));
		await rejected;
	});

	it('retries failures and requires a cached body before accepting 304', async () => {
		const cache = createConditionalRequestCache();
		await expect(
			cache.get('/tracking', async () => new Response(null, { status: 304 }))
		).rejects.toThrow('No cached result');
		await cache.get('/tracking', async () => result({ value: 1 }));
		await expect(
			cache.get('/tracking', async () => {
				throw new Error('offline');
			})
		).rejects.toThrow('offline');
		const retry = vi.fn(async () => new Response(null, { status: 304 }));
		expect(await cache.get('/tracking', retry)).toEqual({ value: 1 });
		expect(retry).toHaveBeenCalledWith('W/"revision-1"');
	});

	it('clears both cache types through the existing mutation and logout hook', async () => {
		vi.stubGlobal('window', {});
		vi.resetModules();
		try {
			const { reusePrivateApiGet, revalidatePrivateApiGet, clearPrivateApiCache } =
				await import('./private-api-cache');
			const load = vi.fn(async () => ({ value: 1 }));
			await reusePrivateApiGet('/accounts', load);
			await revalidatePrivateApiGet('/tracking', async () => result({ value: 1 }));
			clearPrivateApiCache();
			await reusePrivateApiGet('/accounts', load);
			const recheck = vi.fn(async () => result({ value: 2 }));
			await revalidatePrivateApiGet('/tracking', recheck);
			expect(load).toHaveBeenCalledTimes(2);
			expect(recheck).toHaveBeenCalledWith(null);
		} finally {
			vi.unstubAllGlobals();
			vi.resetModules();
		}
	});
});
