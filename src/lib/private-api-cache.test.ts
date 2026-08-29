import { describe, expect, it, vi } from 'vitest';
import { createMemoryRequestCache } from './private-api-cache';

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
