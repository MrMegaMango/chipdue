import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	historicalCloseSeries,
	setMarketHistoryFetchForTests,
	spyBenchmarkSeries
} from './market-history';

afterEach(() => {
	setMarketHistoryFetchForTests();
	vi.useRealTimers();
});

function chartResponse(
	prices: unknown[] = [600, 606],
	dates: unknown[] = ['2026-05-01', '2026-05-04']
): Response {
	return new Response(
		JSON.stringify({
			chart: {
				result: [
					{
						timestamp: dates.map((date) =>
							typeof date === 'string' ? Date.parse(`${date}T13:30:00Z`) / 1000 : date
						),
						indicators: { quote: [{ close: [610, 618] }], adjclose: [{ adjclose: prices }] }
					}
				]
			}
		})
	);
}

describe('historical market closes', () => {
	it('requests only an allowlisted symbol and date range', async () => {
		let requestedUrl = '';
		setMarketHistoryFetchForTests(async (input) => {
			requestedUrl = String(input);
			return new Response(
				JSON.stringify({
					chart: {
						result: [
							{
								timestamp: [1_777_593_600],
								indicators: { quote: [{ close: [123.45] }] }
							}
						]
					}
				})
			);
		});

		const result = await historicalCloseSeries(['BRK.B'], '2026-05-01', '2026-05-02');

		expect(new URL(requestedUrl).origin).toBe('https://query1.finance.yahoo.com');
		expect(new URL(requestedUrl).pathname).toBe('/v8/finance/chart/BRK-B');
		expect(new URL(requestedUrl).searchParams.get('includeAdjustedClose')).toBe('false');
		expect(requestedUrl).not.toContain('account');
		expect(result[0].closes.get('2026-05-01')).toBe(123.45);
	});

	it('does not send invalid ticker text', async () => {
		let calls = 0;
		setMarketHistoryFetchForTests(async () => {
			calls += 1;
			return new Response('{}');
		});

		const result = await historicalCloseSeries(
			['../../private?token=secret'],
			'2026-05-01',
			'2026-05-02'
		);
		expect(calls).toBe(0);
		expect(result[0].closes.size).toBe(0);
	});
});

describe('SPY dividend-adjusted benchmark', () => {
	it('requests only SPY and dates, and preserves adjusted instead of raw closes', async () => {
		const fetchMock = vi.fn(async () => chartResponse());
		setMarketHistoryFetchForTests(fetchMock);

		const result = await spyBenchmarkSeries('2026-05-01', '2026-05-04');
		const [url, options] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.origin).toBe('https://query1.finance.yahoo.com');
		expect(url.pathname).toBe('/v8/finance/chart/SPY');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			period1: String(Date.parse('2026-05-01T00:00:00Z') / 1000),
			period2: String(Date.parse('2026-05-05T00:00:00Z') / 1000),
			interval: '1d',
			events: 'history',
			includeAdjustedClose: 'true'
		});
		expect(options.headers).toEqual({ accept: 'application/json' });
		expect(options.redirect).toBe('error');
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(result).toEqual({
			symbol: 'SPY',
			name: 'S&P 500 (SPY)',
			prices: [
				{ date: '2026-05-01', adjustedClose: 600 },
				{ date: '2026-05-04', adjustedClose: 606 }
			],
			fetchedAt: expect.any(String)
		});
	});

	it('drops null, string, zero, negative and out-of-range values without coercion', async () => {
		setMarketHistoryFetchForTests(async () =>
			chartResponse(
				[600, null, '603', 0, -1, 100_000_000, 607, 599, 900],
				[
					'2026-05-01',
					'2026-05-04',
					'2026-05-05',
					'2026-05-06',
					'2026-05-07',
					'2026-05-08',
					'2026-05-11',
					'2026-04-30',
					null
				]
			)
		);
		const result = await spyBenchmarkSeries('2026-05-01', '2026-05-11');
		expect(result.prices).toEqual([
			{ date: '2026-05-01', adjustedClose: 600 },
			{ date: '2026-05-11', adjustedClose: 607 }
		]);
	});

	it.each([
		{ quote: [{ close: [600, 606] }] },
		{ quote: [{ close: [600, 606] }], adjclose: [{ adjclose: [null, null] }] },
		{ adjclose: [{ adjclose: [0, -10] }] }
	])('does not substitute raw prices when adjusted data is missing: %j', async (indicators) => {
		setMarketHistoryFetchForTests(
			async () =>
				new Response(
					JSON.stringify({
						chart: { result: [{ timestamp: [1_777_593_600, 1_777_852_800], indicators }] }
					})
				)
		);
		await expect(spyBenchmarkSeries('2026-05-01', '2026-05-04')).rejects.toMatchObject({
			code: 'MARKET_HISTORY_UNAVAILABLE',
			status: 502
		});
	});

	it.each([
		[null, '2026-05-04'],
		['2026-05-01', null],
		['2026-02-30', '2026-05-04'],
		['2026-5-01', '2026-05-04'],
		['2026-05-01T00:00:00Z', '2026-05-04'],
		['2026-05-04', '2026-05-01'],
		['2016-05-01', '2026-05-02'],
		['account=private', '2026-05-04']
	])('rejects invalid date range %s to %s before fetching', async (start, end) => {
		const fetchMock = vi.fn(async () => chartResponse());
		setMarketHistoryFetchForTests(fetchMock);
		await expect(spyBenchmarkSeries(start, end)).rejects.toMatchObject({
			code: 'INVALID_BENCHMARK_DATE_RANGE',
			status: 400
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('accepts a full ten-year range', async () => {
		setMarketHistoryFetchForTests(async () => chartResponse());
		await expect(spyBenchmarkSeries('2016-05-04', '2026-05-04')).resolves.toMatchObject({
			symbol: 'SPY'
		});
	});

	it('excludes the current trading session until the New York close, including during DST', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-04T19:59:00Z'));
		setMarketHistoryFetchForTests(async () => chartResponse());
		expect((await spyBenchmarkSeries('2026-05-01', '2026-05-04')).prices).toEqual([
			{ date: '2026-05-01', adjustedClose: 600 }
		]);
		vi.setSystemTime(new Date('2026-05-04T20:16:00Z'));
		expect((await spyBenchmarkSeries('2026-05-01', '2026-05-04')).prices).toHaveLength(2);
	});

	it('coalesces requests and keeps cached values isolated from callers for fifteen minutes', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-05T10:00:00Z'));
		const fetchMock = vi.fn(async () => chartResponse());
		setMarketHistoryFetchForTests(fetchMock);
		const [first, concurrent] = await Promise.all([
			spyBenchmarkSeries('2026-05-01', '2026-05-04'),
			spyBenchmarkSeries('2026-05-01', '2026-05-04')
		]);
		first.prices[0].adjustedClose = 1;
		first.prices.push({ date: 'private-account-data', adjustedClose: 2 });
		concurrent.prices[1].adjustedClose = 3;
		vi.advanceTimersByTime(14 * 60 * 1000);
		const cached = await spyBenchmarkSeries('2026-05-01', '2026-05-04');
		expect(cached.prices).toEqual([
			{ date: '2026-05-01', adjustedClose: 600 },
			{ date: '2026-05-04', adjustedClose: 606 }
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60 * 1000);
		await spyBenchmarkSeries('2026-05-01', '2026-05-04');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('does not cache a failed request and permits an immediate retry', async () => {
		const fetchMock = vi
			.fn(async () => chartResponse())
			.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
		setMarketHistoryFetchForTests(fetchMock);
		const failures = await Promise.allSettled([
			spyBenchmarkSeries('2026-05-01', '2026-05-04'),
			spyBenchmarkSeries('2026-05-01', '2026-05-04')
		]);
		expect(failures.every((result) => result.status === 'rejected')).toBe(true);
		await expect(spyBenchmarkSeries('2026-05-01', '2026-05-04')).resolves.toMatchObject({
			symbol: 'SPY'
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it.each(['oversized', 'invalid-json', 'network-error'])(
		'safely rejects %s responses',
		async (kind) => {
			setMarketHistoryFetchForTests(async () => {
				if (kind === 'network-error') throw new Error('upstream-internal-details');
				return new Response(kind === 'oversized' ? 'x'.repeat(2 * 1024 * 1024 + 1) : 'invalid');
			});
			await expect(spyBenchmarkSeries('2026-05-01', '2026-05-04')).rejects.toMatchObject({
				code: 'MARKET_HISTORY_UNAVAILABLE',
				status: 502,
				message: 'SPY dividend-adjusted prices are temporarily unavailable. Please try again.'
			});
		}
	);

	it('bounds the public-price cache instead of retaining every requested date range', async () => {
		const fetchMock = vi.fn(async () => chartResponse());
		setMarketHistoryFetchForTests(fetchMock);
		for (let day = 1; day <= 25; day += 1) {
			await spyBenchmarkSeries(`2026-04-${String(day).padStart(2, '0')}`, '2026-05-04');
		}
		await spyBenchmarkSeries('2026-04-01', '2026-05-04');
		expect(fetchMock).toHaveBeenCalledTimes(26);
	});
});
