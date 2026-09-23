import { afterEach, describe, expect, it, vi } from 'vitest';
import { setMarketHistoryFetchForTests } from '$lib/server/market-history';
import { GET } from './+server';

afterEach(() => setMarketHistoryFetchForTests());

function requestBenchmark(query: string): Promise<Response> | Response {
	return GET({
		url: new URL(`http://localhost/api/investments/benchmark?${query}`),
		request: new Request(`http://localhost/api/investments/benchmark?${query}`, {
			headers: { cookie: 'session=private-cookie', authorization: 'Bearer private-token' }
		})
	} as never);
}

describe('investment benchmark endpoint', () => {
	it('returns only public adjusted prices with private response headers', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						chart: {
							result: [
								{
									timestamp: [1_777_593_600],
									indicators: { adjclose: [{ adjclose: [600] }] }
								}
							]
						}
					})
				)
		);
		setMarketHistoryFetchForTests(fetchMock);
		const response = await requestBenchmark('start=2026-05-01&end=2026-05-04');
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
		expect(response.headers.get('pragma')).toBe('no-cache');
		expect(await response.json()).toEqual({
			symbol: 'SPY',
			name: 'S&P 500 (SPY)',
			prices: [{ date: '2026-05-01', adjustedClose: 600 }],
			fetchedAt: expect.any(String)
		});
		const [url, options] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(String(url)).not.toContain('private');
		expect(options.headers).toEqual({ accept: 'application/json' });
	});

	it.each([
		'start=2026-05-01',
		'start=2026-05-01&end=2026-05-04&ticker=QQQ',
		'start=2026-05-01&end=2026-05-04&accountId=private',
		'start=2026-05-01&start=2026-04-01&end=2026-05-04',
		'start=2026-02-30&end=2026-05-04'
	])('rejects unsupported parameters or invalid dates: %s', async (query) => {
		const fetchMock = vi.fn();
		setMarketHistoryFetchForTests(fetchMock);
		const response = await requestBenchmark(query);
		expect(response.status).toBe(400);
		expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reports provider failures without disclosing upstream details', async () => {
		setMarketHistoryFetchForTests(async () => {
			throw new Error('upstream-internal-details');
		});
		const response = await requestBenchmark('start=2026-05-01&end=2026-05-04');
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: {
				code: 'MARKET_HISTORY_UNAVAILABLE',
				message: 'SPY dividend-adjusted prices are temporarily unavailable. Please try again.'
			}
		});
	});
});
