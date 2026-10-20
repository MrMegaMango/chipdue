import { describe, expect, it, vi } from 'vitest';
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
