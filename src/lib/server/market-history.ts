import { AppError } from './errors';

const YAHOO_CHART_ORIGIN = 'https://query1.finance.yahoo.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SYMBOLS = 25;
const SYMBOL_PATTERN = /^[A-Z0-9.^-]{1,16}$/;

type MarketFetch = typeof fetch;
let marketFetch: MarketFetch = fetch;

export interface HistoricalCloseSeries {
	symbol: string;
	closes: Map<string, number>;
}

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

export function setMarketHistoryFetchForTests(value?: MarketFetch): void {
	marketFetch = value ?? fetch;
}
