import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	adjustedMarketSeries,
	normalizeAdjustedMarketSymbol,
	setAdjustedMarketHistoryFetchForTests
} from './adjusted-market-history';

const start = '2026-09-01';
const end = '2026-09-22';
const timestamp = (day: string) => Date.parse(`${day}T13:30:00Z`) / 1_000;

function marketResponse(symbol = 'AAPL', overrides: Record<string, unknown> = {}): Response {
	return new Response(
		JSON.stringify({
			chart: {
				result: [
					{
						meta: {
							symbol,
							currency: 'USD',
							instrumentType: 'EQUITY',
							exchangeTimezoneName: 'America/New_York'
						},
						timestamp: [timestamp('2026-09-21')],
						indicators: { adjclose: [{ adjclose: [100] }], quote: [{ close: [200] }] },
						...overrides
					}
				]
			}
		})
	);
}

function symbolFromRequest(input: Parameters<typeof fetch>[0]): string {
	return new URL(String(input)).pathname.split('/').at(-1)!;
}

describe('adjusted market history', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-09-23T01:00:00Z'));
		setAdjustedMarketHistoryFetchForTests();
	});

	afterEach(() => {
		setAdjustedMarketHistoryFetchForTests();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('normalizes only US class-share suffixes and deduplicates before requesting', async () => {
		const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
			const url = new URL(String(input));
			expect(url.origin).toBe('https://query1.finance.yahoo.com');
			expect(url.searchParams.get('includeAdjustedClose')).toBe('true');
			expect(options).toMatchObject({ redirect: 'error', headers: { accept: 'application/json' } });
			expect(options?.signal).toBeInstanceOf(AbortSignal);
			return marketResponse(symbolFromRequest(input));
		});
		setAdjustedMarketHistoryFetchForTests(fetcher);
		const result = await adjustedMarketSeries([' brk.b ', 'BRK-B', 'aapl'], start, end);
		expect(result.map((series) => series.symbol)).toEqual(['BRK-B', 'AAPL']);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(normalizeAdjustedMarketSymbol('BF.A')).toBe('BF-A');
		for (const invalid of ['VOD.L', 'SHOP.TO', '^GSPC', 'BTC-USD', '../AAPL', 'ABCDEF']) {
			expect(normalizeAdjustedMarketSymbol(invalid)).toBeNull();
		}
	});

	it('rejects invalid dates, unsupported symbols, and more than 12 symbols before fetching', async () => {
		const fetcher = vi.fn();
		setAdjustedMarketHistoryFetchForTests(fetcher);
		for (const [first, last] of [
			['2026-02-30', end],
			[end, start],
			['2024-08-21', end],
			['bad', end]
		]) {
			await expect(adjustedMarketSeries(['AAPL'], first, last)).rejects.toMatchObject({
				status: 400
			});
		}
		await expect(adjustedMarketSeries(['VOD.L'], start, end)).rejects.toMatchObject({
			status: 400
		});
		await expect(adjustedMarketSeries('ABCDEFGHIJKLM'.split(''), start, end)).rejects.toMatchObject(
			{ status: 400 }
		);
		expect(fetcher).not.toHaveBeenCalled();
		expect(await adjustedMarketSeries([], start, end)).toEqual([]);
	});

	it('returns quote metadata and strictly positive numeric adjusted closes within the requested range', async () => {
		setAdjustedMarketHistoryFetchForTests(async () =>
			marketResponse('AAPL', {
				meta: {
					symbol: 'AAPL',
					currency: 'usd',
					instrumentType: 'equity',
					exchangeTimezoneName: 'America/New_York'
				},
				timestamp: [
					'2026-09-01',
					null,
					...Array.from({ length: 8 }, (_, index) =>
						timestamp(`2026-09-${String(index + 1).padStart(2, '0')}`)
					),
					timestamp('2026-08-31')
				],
				indicators: {
					adjclose: [{ adjclose: [100, 100, null, 0, -1, '10', false, 100_000_000, 105, 106, 99] }]
				}
			})
		);
		expect(await adjustedMarketSeries(['AAPL'], start, end)).toEqual([
			{
				symbol: 'AAPL',
				currency: 'USD',
				instrumentType: 'EQUITY',
				exchangeTimezoneName: 'America/New_York',
				prices: [
					{ date: '2026-09-07', adjustedClose: 105 },
					{ date: '2026-09-08', adjustedClose: 106 }
				],
				fetchedAt: '2026-09-23T01:00:00.000Z'
			}
		]);
	});

	it('never substitutes raw closes for missing adjusted prices and does not cache empty results', async () => {
		const fetcher = vi.fn(async () =>
			marketResponse('AAPL', { indicators: { quote: [{ close: [200] }] } })
		);
		setAdjustedMarketHistoryFetchForTests(fetcher);
		for (let index = 0; index < 2; index++) {
			expect((await adjustedMarketSeries(['AAPL'], start, end))[0].prices).toEqual([]);
		}
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('keeps missing or malformed quote metadata unknown', async () => {
		setAdjustedMarketHistoryFetchForTests(async () =>
			marketResponse('AAPL', {
				meta: { currency: 123, instrumentType: '', exchangeTimezoneName: false }
			})
		);
		expect((await adjustedMarketSeries(['AAPL'], start, end))[0]).toMatchObject({
			currency: null,
			instrumentType: null,
			exchangeTimezoneName: null,
			prices: [{ date: '2026-09-21', adjustedClose: 100 }]
		});
	});

	it('treats malformed responses, upstream errors, and mismatched symbols as unavailable', async () => {
		for (const response of [
			new Response('not JSON'),
			new Response(null),
			new Response('{}', { status: 503 }),
			new Response(JSON.stringify({ chart: { error: { code: 'Not Found' } } })),
			marketResponse('MSFT')
		]) {
			setAdjustedMarketHistoryFetchForTests(async () => response);
			expect((await adjustedMarketSeries(['AAPL'], start, end))[0]).toMatchObject({
				currency: null,
				instrumentType: null,
				exchangeTimezoneName: null,
				prices: []
			});
		}
	});

	it('omits the unfinished New York market session until its close', async () => {
		const fetcher = async () =>
			marketResponse('AAPL', {
				timestamp: [timestamp('2026-09-21'), timestamp('2026-09-22')],
				indicators: { adjclose: [{ adjclose: [100, 102] }] }
			});
		vi.setSystemTime(new Date('2026-09-22T19:59:00Z'));
		setAdjustedMarketHistoryFetchForTests(fetcher);
		expect((await adjustedMarketSeries(['AAPL'], start, end))[0].prices).toHaveLength(1);
		vi.setSystemTime(new Date('2026-09-22T20:00:00Z'));
		setAdjustedMarketHistoryFetchForTests(fetcher);
		expect((await adjustedMarketSeries(['AAPL'], start, end))[0].prices).toHaveLength(2);
	});

	it('coalesces identical requests and isolates returned objects from callers and the cache', async () => {
		let release!: (response: Response) => void;
		const fetcher = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				})
		);
		setAdjustedMarketHistoryFetchForTests(fetcher);
		const first = adjustedMarketSeries(['AAPL'], start, end);
		const second = adjustedMarketSeries(['AAPL'], start, end);
		expect(fetcher).toHaveBeenCalledTimes(1);
		release(marketResponse());
		const [left, right] = await Promise.all([first, second]);
		left[0].prices[0].adjustedClose = 999;
		left[0].currency = 'CAD';
		expect(right[0].prices[0].adjustedClose).toBe(100);
		const [cached] = await adjustedMarketSeries(['AAPL'], start, end);
		expect(cached).toMatchObject({ currency: 'USD', prices: [{ adjustedClose: 100 }] });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it('expires public quote cache entries after 15 minutes', async () => {
		const fetcher = vi.fn(async () => marketResponse());
		setAdjustedMarketHistoryFetchForTests(fetcher);
		await adjustedMarketSeries(['AAPL'], start, end);
		vi.setSystemTime(new Date('2026-09-23T01:14:59Z'));
		await adjustedMarketSeries(['AAPL'], start, end);
		expect(fetcher).toHaveBeenCalledTimes(1);
		vi.setSystemTime(new Date('2026-09-23T01:15:00Z'));
		await adjustedMarketSeries(['AAPL'], start, end);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('caps public quote cache storage at 32 entries', async () => {
		const fetcher = vi.fn(async () => marketResponse());
		setAdjustedMarketHistoryFetchForTests(fetcher);
		const dates = Array.from({ length: 33 }, (_, index) =>
			new Date(Date.parse('2026-08-01T00:00:00Z') + index * 86_400_000).toISOString().slice(0, 10)
		);
		for (const day of dates) await adjustedMarketSeries(['AAPL'], day, end);
		await adjustedMarketSeries(['AAPL'], dates.at(-1)!, end);
		expect(fetcher).toHaveBeenCalledTimes(33);
		await adjustedMarketSeries(['AAPL'], dates[0], end);
		expect(fetcher).toHaveBeenCalledTimes(34);
	});

	it('limits each batch to four simultaneous upstream calls', async () => {
		let active = 0;
		let maximum = 0;
		const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
			active += 1;
			maximum = Math.max(maximum, active);
			await Promise.resolve();
			active -= 1;
			return marketResponse(symbolFromRequest(input));
		});
		setAdjustedMarketHistoryFetchForTests(fetcher);
		const result = await adjustedMarketSeries('ABCDEFGHIJKL'.split(''), start, end);
		expect(result).toHaveLength(12);
		expect(result.every((series) => series.prices.length === 1)).toBe(true);
		expect(maximum).toBe(4);
	});

	it('limits active requests across independent batches to eight', async () => {
		const releases: Array<() => void> = [];
		const fetcher = vi.fn(
			(input: Parameters<typeof fetch>[0]) =>
				new Promise<Response>((resolve) => {
					releases.push(() => resolve(marketResponse(symbolFromRequest(input))));
				})
		);
		setAdjustedMarketHistoryFetchForTests(fetcher);
		const batches = ['ABCD', 'EFGH', 'IJKL'].map((symbols) =>
			adjustedMarketSeries(symbols.split(''), start, end)
		);
		expect(fetcher).toHaveBeenCalledTimes(8);
		releases.forEach((release) => release());
		const result = (await Promise.all(batches)).flat();
		expect(result.filter((series) => series.prices.length === 1)).toHaveLength(8);
		expect(result.filter((series) => series.prices.length === 0)).toHaveLength(4);
	});

	it.each(['declared', 'streamed'])(
		'bounds %s response bytes and cancels oversized bodies',
		async (mode) => {
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
				},
				cancel
			});
			setAdjustedMarketHistoryFetchForTests(
				async () =>
					new Response(body, {
						headers: mode === 'declared' ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {}
					})
			);
			expect((await adjustedMarketSeries(['AAPL'], start, end))[0].prices).toEqual([]);
			expect(cancel).toHaveBeenCalledOnce();
		}
	);

	it('applies a 12-second timeout and leaves failed requests retryable', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		const fetcher = vi
			.fn<typeof fetch>()
			.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
			.mockResolvedValueOnce(marketResponse());
		setAdjustedMarketHistoryFetchForTests(fetcher);
		expect((await adjustedMarketSeries(['AAPL'], start, end))[0].prices).toEqual([]);
		expect((await adjustedMarketSeries(['AAPL'], start, end))[0].prices).toHaveLength(1);
		expect(timeout).toHaveBeenCalledWith(12_000);
	});
});
