import { AppError } from './errors';

const MARKET_ORIGIN = 'https://query1.finance.yahoo.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SYMBOLS = 12;
const MAX_CONCURRENT_SYMBOLS = 4;
const MAX_ACTIVE_REQUESTS = 8;
const MAX_CACHE_ENTRIES = 32;
const CACHE_TTL_MS = 15 * 60 * 1_000;

export interface AdjustedMarketSeries {
	symbol: string;
	currency: string | null;
	instrumentType: string | null;
	exchangeTimezoneName: string | null;
	prices: Array<{ date: string; adjustedClose: number }>;
	fetchedAt: string;
}

type MarketFetch = typeof fetch;
let marketFetch: MarketFetch = fetch;
// These maps contain public quotes only. Account authorization and ticker
// selection belong to the caller; never put account data in either map.
const cache = new Map<string, { expiresAt: number; value: AdjustedMarketSeries }>();
const requests = new Map<string, Promise<AdjustedMarketSeries>>();

export function normalizeAdjustedMarketSymbol(symbol: string): string | null {
	if (typeof symbol !== 'string') return null;
	const normalized = symbol.trim().toUpperCase();
	if (!/^[A-Z]{1,5}(?:[.-][AB])?$/.test(normalized)) return null;
	return normalized.replace(/\.([AB])$/, '-$1');
}

function validDay(value: string): boolean {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const timestamp = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validateRange(startDate: string, endDate: string): void {
	if (!validDay(startDate) || !validDay(endDate) || startDate > endDate) {
		throw new AppError('INVALID_MARKET_DATE_RANGE', 'Choose a valid historical date range.', 400);
	}
	const maximumEnd = new Date(`${startDate}T00:00:00Z`);
	maximumEnd.setUTCFullYear(maximumEnd.getUTCFullYear() + 2);
	maximumEnd.setUTCMonth(maximumEnd.getUTCMonth() + 1);
	if (Date.parse(`${endDate}T00:00:00Z`) > maximumEnd.getTime()) {
		throw new AppError(
			'INVALID_MARKET_DATE_RANGE',
			'Historical comparisons support up to two years and one month.',
			400
		);
	}
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
	return Number(value('hour')) >= 16
		? today
		: new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function unavailable(symbol: string): AdjustedMarketSeries {
	return {
		symbol,
		currency: null,
		instrumentType: null,
		exchangeTimezoneName: null,
		prices: [],
		fetchedAt: new Date().toISOString()
	};
}

function copySeries(value: AdjustedMarketSeries): AdjustedMarketSeries {
	return { ...value, prices: value.prices.map((price) => ({ ...price })) };
}

async function boundedBody(response: Response): Promise<string> {
	if (!response.body) throw new Error('Missing market response');
	if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
		await response.body.cancel();
		throw new Error('Market response too large');
	}
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
				throw new Error('Market response too large');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, length).toString('utf8');
}

function metadataText(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= 80
		? value.trim()
		: null;
}

async function fetchSeries(
	symbol: string,
	startDate: string,
	endDate: string
): Promise<AdjustedMarketSeries> {
	const url = new URL(`/v8/finance/chart/${encodeURIComponent(symbol)}`, MARKET_ORIGIN);
	url.searchParams.set('period1', String(Date.parse(`${startDate}T00:00:00Z`) / 1_000));
	url.searchParams.set('period2', String(Date.parse(`${endDate}T00:00:00Z`) / 1_000 + 86_400));
	url.searchParams.set('interval', '1d');
	url.searchParams.set('events', 'history');
	url.searchParams.set('includeAdjustedClose', 'true');
	try {
		const response = await marketFetch(url, {
			headers: { accept: 'application/json' },
			redirect: 'error',
			signal: AbortSignal.timeout(12_000)
		});
		if (!response.ok) return unavailable(symbol);
		const body = JSON.parse(await boundedBody(response));
		if (body?.chart?.error) return unavailable(symbol);
		const result = body?.chart?.result?.[0];
		const meta = result?.meta;
		if (meta?.symbol !== undefined && normalizeAdjustedMarketSymbol(meta.symbol) !== symbol) {
			return unavailable(symbol);
		}
		const timestamps: unknown[] = Array.isArray(result?.timestamp) ? result.timestamp : [];
		const adjusted: unknown[] = Array.isArray(result?.indicators?.adjclose?.[0]?.adjclose)
			? result.indicators.adjclose[0].adjclose
			: [];
		const prices = new Map<string, number>();
		const completedThrough = latestCompletedMarketDate();
		for (let index = 0; index < timestamps.length; index += 1) {
			const timestamp = timestamps[index];
			const adjustedClose = adjusted[index];
			if (
				typeof timestamp !== 'number' ||
				!Number.isFinite(timestamp) ||
				typeof adjustedClose !== 'number' ||
				!Number.isFinite(adjustedClose) ||
				adjustedClose <= 0 ||
				adjustedClose >= 100_000_000
			)
				continue;
			const date = new Date(timestamp * 1_000);
			if (!Number.isFinite(date.getTime())) continue;
			const day = date.toISOString().slice(0, 10);
			if (day >= startDate && day <= endDate && day <= completedThrough) {
				prices.set(day, adjustedClose);
			}
		}
		return {
			symbol,
			currency: metadataText(meta?.currency)?.toUpperCase() ?? null,
			instrumentType: metadataText(meta?.instrumentType)?.toUpperCase() ?? null,
			exchangeTimezoneName: metadataText(meta?.exchangeTimezoneName),
			prices: [...prices]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([date, adjustedClose]) => ({ date, adjustedClose })),
			fetchedAt: new Date().toISOString()
		};
	} catch {
		return unavailable(symbol);
	}
}

async function cachedSeries(
	symbol: string,
	startDate: string,
	endDate: string
): Promise<AdjustedMarketSeries> {
	const key = `${symbol}:${startDate}:${endDate}`;
	for (const [cacheKey, entry] of cache) {
		if (entry.expiresAt <= Date.now()) cache.delete(cacheKey);
	}
	const cached = cache.get(key);
	if (cached) return copySeries(cached.value);
	const pending = requests.get(key);
	if (pending) return copySeries(await pending);
	if (requests.size >= MAX_ACTIVE_REQUESTS) return unavailable(symbol);
	const request = fetchSeries(symbol, startDate, endDate);
	requests.set(key, request);
	try {
		const value = await request;
		if (value.prices.length > 0) {
			while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
			cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
		}
		return copySeries(value);
	} finally {
		requests.delete(key);
	}
}

export async function adjustedMarketSeries(
	symbols: string[],
	startDate: string,
	endDate: string
): Promise<AdjustedMarketSeries[]> {
	validateRange(startDate, endDate);
	const normalized = symbols.map(normalizeAdjustedMarketSymbol);
	const unique = [...new Set(normalized)];
	if (unique.includes(null) || unique.length > MAX_SYMBOLS) {
		throw new AppError('INVALID_MARKET_SYMBOLS', 'Choose up to 12 supported US tickers.', 400);
	}
	const tickers = unique as string[];
	const result: AdjustedMarketSeries[] = new Array(tickers.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(MAX_CONCURRENT_SYMBOLS, tickers.length) }, async () => {
			while (next < tickers.length) {
				const index = next++;
				result[index] = await cachedSeries(tickers[index], startDate, endDate);
			}
		})
	);
	return result;
}

export function setAdjustedMarketHistoryFetchForTests(value?: MarketFetch): void {
	marketFetch = value ?? fetch;
	cache.clear();
	requests.clear();
}
