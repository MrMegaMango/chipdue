import { AppError } from './errors';

const YAHOO_CHART_ORIGIN = 'https://query1.finance.yahoo.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SYMBOLS = 25;
const SYMBOL_PATTERN = /^[A-Z0-9.^-]{1,16}$/;
const BENCHMARK_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_BENCHMARK_CACHE_ENTRIES = 24;
const MAX_BENCHMARK_REQUESTS = 8;

type MarketFetch = typeof fetch;
let marketFetch: MarketFetch = fetch;

export interface HistoricalCloseSeries {
	symbol: string;
	closes: Map<string, number>;
}

export interface SpyBenchmarkSeries {
	symbol: 'SPY';
	name: 'S&P 500 (SPY)';
	prices: Array<{ date: string; adjustedClose: number }>;
	fetchedAt: string;
}

// Only fixed-symbol public market prices are retained, never account data or request headers.
const benchmarkCache = new Map<string, { expiresAt: number; value: SpyBenchmarkSeries }>();
const benchmarkRequests = new Map<string, Promise<SpyBenchmarkSeries>>();

function marketSymbol(symbol: string): string | null {
	const normalized = symbol.trim().toUpperCase().replaceAll('.', '-');
	return SYMBOL_PATTERN.test(normalized) ? normalized : null;
}

function isoDay(timestampSeconds: number): string | null {
	const date = new Date(timestampSeconds * 1000);
	return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

async function fetchSeries(
	symbol: string,
	startDate: string,
	endDate: string
): Promise<HistoricalCloseSeries> {
	const normalized = marketSymbol(symbol);
	if (!normalized) return { symbol, closes: new Map() };
	const period1 = Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000);
	const period2 = Math.floor(Date.parse(`${endDate}T00:00:00Z`) / 1000) + 86_400;
	const url = new URL(`/v8/finance/chart/${encodeURIComponent(normalized)}`, YAHOO_CHART_ORIGIN);
	url.searchParams.set('period1', String(period1));
	url.searchParams.set('period2', String(period2));
	url.searchParams.set('interval', '1d');
	url.searchParams.set('events', 'history');
	url.searchParams.set('includeAdjustedClose', 'false');
	let response: Response;
	try {
		response = await marketFetch(url, {
			headers: { accept: 'application/json' },
			redirect: 'error',
			signal: AbortSignal.timeout(12_000)
		});
	} catch {
		return { symbol, closes: new Map() };
	}
	if (!response.ok) return { symbol, closes: new Map() };
	const body = await response.text();
	if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
		throw new AppError(
			'MARKET_HISTORY_UNAVAILABLE',
			'Historical prices returned an unexpected response.',
			502
		);
	}
	try {
		const result = JSON.parse(body)?.chart?.result?.[0];
		const timestamps: unknown[] = Array.isArray(result?.timestamp) ? result.timestamp : [];
		const values: unknown[] = Array.isArray(result?.indicators?.quote?.[0]?.close)
			? result.indicators.quote[0].close
			: [];
		const closes = new Map<string, number>();
		for (let index = 0; index < timestamps.length; index += 1) {
			const timestamp = Number(timestamps[index]);
			const close = Number(values[index]);
			const day = isoDay(timestamp);
			if (day && Number.isFinite(close) && close >= 0 && close < 100_000_000)
				closes.set(day, close);
		}
		return { symbol, closes };
	} catch {
		return { symbol, closes: new Map() };
	}
}

export async function historicalCloseSeries(
	symbols: string[],
	startDate: string,
	endDate: string
): Promise<HistoricalCloseSeries[]> {
	const unique = [
		...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))
	].slice(0, MAX_SYMBOLS);
	return Promise.all(unique.map((symbol) => fetchSeries(symbol, startDate, endDate)));
}

function validIsoDate(value: string | null): value is string {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const timestamp = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function benchmarkUnavailable(): AppError {
	return new AppError(
		'MARKET_HISTORY_UNAVAILABLE',
		'SPY dividend-adjusted prices are temporarily unavailable. Please try again.',
		502
	);
}

function latestCompletedMarketDate(): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(new Date());
	const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
	const today = `${value('year')}-${value('month')}-${value('day')}`;
	if (Number(value('hour')) >= 16) return today;
	return new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

async function boundedMarketBody(response: Response): Promise<string> {
	const declaredLength = Number(response.headers.get('content-length'));
	if (declaredLength > MAX_RESPONSE_BYTES || !response.body) throw benchmarkUnavailable();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw benchmarkUnavailable();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, length).toString('utf8');
}

async function fetchSpyBenchmark(startDate: string, endDate: string): Promise<SpyBenchmarkSeries> {
	const url = new URL('/v8/finance/chart/SPY', YAHOO_CHART_ORIGIN);
	url.searchParams.set('period1', String(Date.parse(`${startDate}T00:00:00Z`) / 1000));
	url.searchParams.set('period2', String(Date.parse(`${endDate}T00:00:00Z`) / 1000 + 86_400));
	url.searchParams.set('interval', '1d');
	url.searchParams.set('events', 'history');
	url.searchParams.set('includeAdjustedClose', 'true');
	try {
		const response = await marketFetch(url, {
			headers: { accept: 'application/json' },
			redirect: 'error',
			signal: AbortSignal.timeout(12_000)
		});
		if (!response.ok) throw benchmarkUnavailable();
		const result = JSON.parse(await boundedMarketBody(response))?.chart?.result?.[0];
		const timestamps: unknown[] = Array.isArray(result?.timestamp) ? result.timestamp : [];
		const values: unknown[] = Array.isArray(result?.indicators?.adjclose?.[0]?.adjclose)
			? result.indicators.adjclose[0].adjclose
			: [];
		const prices = new Map<string, number>();
		const completedThrough = latestCompletedMarketDate();
		for (let index = 0; index < timestamps.length; index += 1) {
			const timestamp = timestamps[index];
			const close = values[index];
			if (
				typeof timestamp !== 'number' ||
				!Number.isFinite(timestamp) ||
				typeof close !== 'number' ||
				!Number.isFinite(close) ||
				close <= 0 ||
				close >= 100_000_000
			)
				continue;
			const date = isoDay(timestamp);
			if (date && date >= startDate && date <= endDate && date <= completedThrough)
				prices.set(date, close);
		}
		if (!prices.size) throw benchmarkUnavailable();
		return {
			symbol: 'SPY',
			name: 'S&P 500 (SPY)',
			prices: [...prices]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([date, adjustedClose]) => ({ date, adjustedClose })),
			fetchedAt: new Date().toISOString()
		};
	} catch {
		throw benchmarkUnavailable();
	}
}

function copyBenchmark(value: SpyBenchmarkSeries): SpyBenchmarkSeries {
	return { ...value, prices: value.prices.map((price) => ({ ...price })) };
}

export async function spyBenchmarkSeries(
	startDate: string | null,
	endDate: string | null
): Promise<SpyBenchmarkSeries> {
	if (!validIsoDate(startDate) || !validIsoDate(endDate) || endDate < startDate) {
		throw new AppError(
			'INVALID_BENCHMARK_DATE_RANGE',
			'Choose a valid start and end date in YYYY-MM-DD format.',
			400
		);
	}
	const maximumEnd = new Date(`${startDate}T00:00:00Z`);
	maximumEnd.setUTCFullYear(maximumEnd.getUTCFullYear() + 10);
	if (Date.parse(`${endDate}T00:00:00Z`) > maximumEnd.getTime()) {
		throw new AppError(
			'INVALID_BENCHMARK_DATE_RANGE',
			'Choose a date range of 10 years or less.',
			400
		);
	}
	const key = `${startDate}:${endDate}`;
	for (const [cachedKey, cached] of benchmarkCache) {
		if (cached.expiresAt <= Date.now()) benchmarkCache.delete(cachedKey);
	}
	const cached = benchmarkCache.get(key);
	if (cached) return copyBenchmark(cached.value);
	const pending = benchmarkRequests.get(key);
	if (pending) return copyBenchmark(await pending);
	if (benchmarkRequests.size >= MAX_BENCHMARK_REQUESTS) throw benchmarkUnavailable();
	const request = fetchSpyBenchmark(startDate, endDate);
	benchmarkRequests.set(key, request);
	try {
		const value = await request;
		while (benchmarkCache.size >= MAX_BENCHMARK_CACHE_ENTRIES) {
			const oldestKey = benchmarkCache.keys().next().value;
			if (oldestKey) benchmarkCache.delete(oldestKey);
		}
		benchmarkCache.set(key, { expiresAt: Date.now() + BENCHMARK_CACHE_TTL_MS, value });
		return copyBenchmark(value);
	} finally {
		benchmarkRequests.delete(key);
	}
}

export function setMarketHistoryFetchForTests(value?: MarketFetch): void {
	marketFetch = value ?? fetch;
	benchmarkCache.clear();
	benchmarkRequests.clear();
}
