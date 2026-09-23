import {
	buildBuyTimingComparison,
	type BuyTimingCoverage,
	type BuyTimingRange,
	type BuyTimingResponse,
	type BuyTimingSchedule,
	type TimingPurchase
} from '$lib/buy-timing';
import { isCashSweepSecurity } from '$lib/investment-display';
import type { FinancialAccount, FinancialAccountTransaction } from '$lib/types';
import { adjustedMarketSeries, normalizeAdjustedMarketSymbol } from './adjusted-market-history';
import { AppError } from './errors';
import { getFinancialAccount, listFinancialAccountTransactions } from './financial-records';
import { spyBenchmarkSeries } from './market-history';

const SUPPORTED_HOLDING_TYPES = new Set(['equity', 'etf', 'mutual fund']);
const SUPPORTED_QUOTE_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND']);
const US_MARKET_TIMEZONES = new Set(['America/New_York', 'US/Eastern']);
const ACTIVITY_LIMIT = 10_000;
const MAX_SYMBOLS = 12;

interface ClassifiedBuy {
	date: string | null;
	symbol: string | null;
	amountCents: number;
	postedDate: boolean;
	reason: string | null;
}

function isoDate(value: string | null | undefined): value is string {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const timestamp = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function completedMarketDay(at: Date): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/New_York',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(at);
	const value = (type: string) => parts.find((part) => part.type === type)!.value;
	const date = `${value('year')}-${value('month')}-${value('day')}`;
	return Number(value('hour')) >= 16
		? date
		: new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

function rangeStart(endDate: string, range: BuyTimingRange): string {
	if (range === 'YTD') return `${endDate.slice(0, 4)}-01-01`;
	const months = { '1M': 1, '3M': 3, '1Y': 12, ALL: 24 }[range];
	const end = new Date(`${endDate}T00:00:00Z`);
	const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, 1));
	const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
	start.setUTCDate(Math.min(end.getUTCDate(), lastDay.getUTCDate()));
	return start.toISOString().slice(0, 10);
}

function classifyBuy(
	transaction: FinancialAccountTransaction,
	account: FinancialAccount
): ClassifiedBuy | null {
	const details = transaction.investmentDetails;
	if (details?.type.trim().toLowerCase() !== 'buy') return null;
	const symbol = details.tickerSymbol ? normalizeAdjustedMarketSymbol(details.tickerSymbol) : null;
	const postedDate = !isoDate(transaction.authorizedDate);
	const date = postedDate
		? isoDate(transaction.date)
			? transaction.date
			: null
		: transaction.authorizedDate!;
	const notional = Math.round((details.quantity * details.priceMicros) / 10_000);
	const feeKnown = details.feesCents !== null;
	const principal = feeKnown ? transaction.amountCents - details.feesCents! : notional;
	// Coverage dollar amounts are USD; foreign currency cents cannot be added to them.
	const amountCents =
		transaction.currency === 'USD' && Number.isSafeInteger(principal) && principal > 0
			? principal
			: 0;
	const result = (reason: string | null): ClassifiedBuy => ({
		date,
		symbol,
		amountCents,
		postedDate,
		reason
	});
	if (!date) return result('Missing purchase date');
	if (transaction.pending) return result('Pending purchase');
	if (details.subtype.trim().toLowerCase() !== 'buy')
		return result('Reinvestment or other buy activity');
	if (transaction.currency !== 'USD') return result('Non-USD purchase');
	if (
		isCashSweepSecurity(details.tickerSymbol, details.securityName) ||
		/\bmoney[\s-]*market\b/i.test(details.securityName ?? '')
	)
		return result('Cash sweep or money market');
	if (!symbol) return result('Unsupported or missing ticker');
	const holdings = account.holdings.filter(
		(holding) =>
			holding.tickerSymbol && normalizeAdjustedMarketSymbol(holding.tickerSymbol) === symbol
	);
	if (
		holdings.some(
			(holding) =>
				holding.currency !== 'USD' ||
				(holding.securityType !== null &&
					!SUPPORTED_HOLDING_TYPES.has(holding.securityType.trim().toLowerCase()))
		)
	)
		return result('Unsupported security type or currency');
	if (
		!Number.isFinite(details.quantity) ||
		details.quantity <= 0 ||
		!Number.isSafeInteger(details.priceMicros) ||
		details.priceMicros <= 0 ||
		!Number.isSafeInteger(transaction.amountCents) ||
		transaction.amountCents <= 0 ||
		!Number.isSafeInteger(notional) ||
		notional <= 0 ||
		!amountCents ||
		(feeKnown && (!Number.isSafeInteger(details.feesCents) || details.feesCents! < 0))
	)
		return result('Invalid purchase amount');
	// Contract multipliers and inconsistent provider amounts must not become equity purchases.
	const reportedPrincipal = feeKnown ? principal : transaction.amountCents;
	if (Math.abs(reportedPrincipal - notional) > Math.max(5, notional * 0.02))
		return result('Shares and price do not match purchase amount');
	return result(null);
}

export async function accountBuyTiming(
	accountId: string,
	range: BuyTimingRange = 'ALL',
	schedule: BuyTimingSchedule = 'monthly'
): Promise<BuyTimingResponse> {
	// Resolve ownership before reading activity or disclosing symbols to the price provider.
	const account = await getFinancialAccount(accountId);
	const now = new Date();
	const coverage: BuyTimingCoverage = {
		transactionCount: 0,
		buyCount: 0,
		includedBuyCount: 0,
		postedDateBuyCount: 0,
		excludedBuyCount: 0,
		excludedAmountCents: 0,
		exclusions: [],
		activitySyncedAt: account.lastSyncedAt,
		rangeStartDate: rangeStart(completedMarketDay(now), range),
		rangeEndDate: completedMarketDay(now),
		capped: false
	};
	let priceFetchedAt: string | null = null;
	const unavailable = (reason: string, message: string): BuyTimingResponse => ({
		comparison: { status: 'unavailable', reason, message },
		coverage,
		priceFetchedAt
	});
	if (
		account.source !== 'connected' ||
		account.connectionProvider !== 'plaid' ||
		account.accountType !== 'brokerage' ||
		!account.transactionHistoryEnabled
	)
		return unavailable(
			'activity_required',
			'Sync investment activity for this connected brokerage.'
		);
	if (account.currency !== 'USD')
		return unavailable('unsupported_currency', 'Buy timing currently supports USD accounts.');
	const activity = await listFinancialAccountTransactions(account.id, ACTIVITY_LIMIT);
	coverage.transactionCount = activity.transactions.length;
	coverage.capped = activity.transactions.length >= ACTIVITY_LIMIT;
	coverage.activitySyncedAt = activity.lastSyncedAt ?? account.lastSyncedAt;
	const syncedAt = Date.parse(coverage.activitySyncedAt ?? '');
	if (!Number.isFinite(syncedAt))
		return unavailable(
			'activity_required',
			'Sync investment activity to establish the comparison dates.'
		);
	coverage.rangeEndDate = completedMarketDay(new Date(Math.min(syncedAt, now.getTime())));
	coverage.rangeStartDate = rangeStart(coverage.rangeEndDate, range);
	const inRange = activity.transactions
		.map((transaction) => classifyBuy(transaction, account))
		.filter((buy): buy is ClassifiedBuy => buy !== null)
		.filter(
			(buy) =>
				buy.date === null ||
				(buy.date >= coverage.rangeStartDate && buy.date <= coverage.rangeEndDate)
		);
	coverage.buyCount = inRange.length;
	const unsafeSymbols = new Map(
		inRange
			.filter(
				(buy) =>
					buy.symbol &&
					(buy.reason === 'Unsupported security type or currency' ||
						buy.reason === 'Shares and price do not match purchase amount' ||
						buy.reason === 'Cash sweep or money market')
			)
			.map((buy) => [buy.symbol!, buy.reason!] as const)
	);
	const excluded = new Map<string, { reason: string; count: number; amountCents: number }>();
	const exclude = (buy: ClassifiedBuy, reason: string) => {
		coverage.excludedBuyCount += 1;
		coverage.excludedAmountCents += buy.amountCents;
		const previous = excluded.get(reason) ?? { reason, count: 0, amountCents: 0 };
		previous.count += 1;
		previous.amountCents += buy.amountCents;
		excluded.set(reason, previous);
		coverage.exclusions = [...excluded.values()];
	};
	let eligible = inRange.filter((buy) => {
		const reason = buy.reason ?? (buy.symbol ? unsafeSymbols.get(buy.symbol) : undefined);
		if (reason) exclude(buy, reason);
		return !reason;
	});
	const updateIncluded = () => {
		coverage.includedBuyCount = eligible.length;
		coverage.postedDateBuyCount = eligible.filter((buy) => buy.postedDate).length;
	};
	updateIncluded();
	if (!eligible.length)
		return unavailable(
			'no_eligible_buys',
			'No supported purchases were found in the available synced activity.'
		);
	const symbols = [...new Set(eligible.map((buy) => buy.symbol!))];
	if (symbols.length > MAX_SYMBOLS)
		return unavailable(
			'too_many_symbols',
			'Choose a shorter range with no more than 12 purchased securities.'
		);
	const results = await Promise.allSettled([
		adjustedMarketSeries(symbols, coverage.rangeStartDate, coverage.rangeEndDate),
		spyBenchmarkSeries(coverage.rangeStartDate, coverage.rangeEndDate)
	]);
	let marketUnavailable = false;
	for (const result of results) {
		if (result.status === 'rejected') {
			if (result.reason instanceof AppError && result.reason.code === 'MARKET_HISTORY_UNAVAILABLE')
				marketUnavailable = true;
			else throw result.reason;
		}
	}
	if (marketUnavailable)
		return unavailable(
			'prices_unavailable',
			'Historical market prices are temporarily unavailable.'
		);
	const [marketResult, calendarResult] = results;
	if (marketResult.status !== 'fulfilled' || calendarResult.status !== 'fulfilled')
		return unavailable(
			'prices_unavailable',
			'Historical market prices are temporarily unavailable.'
		);
	const series = marketResult.value;
	const calendar = calendarResult.value;
	const fetchedDates = [...series.map((item) => item.fetchedAt), calendar.fetchedAt]
		.filter((date) => Number.isFinite(Date.parse(date)))
		.sort();
	priceFetchedAt = fetchedDates[0] ?? null;
	const excludedSymbols = new Map<string, string>();
	for (const symbol of symbols) {
		const market = series.find((item) => item.symbol === symbol);
		if (
			market?.currency &&
			market.instrumentType &&
			market.exchangeTimezoneName &&
			(market.currency !== 'USD' ||
				!SUPPORTED_QUOTE_TYPES.has(market.instrumentType) ||
				!US_MARKET_TIMEZONES.has(market.exchangeTimezoneName))
		) {
			excludedSymbols.set(symbol, 'Unsupported or unverified market data');
			continue;
		}
		if (!market || !market.prices.length)
			return unavailable(
				'prices_unavailable',
				'A purchased security is missing historical prices. The comparison was not calculated.'
			);
		if (
			market.currency !== 'USD' ||
			!SUPPORTED_QUOTE_TYPES.has(market.instrumentType ?? '') ||
			!US_MARKET_TIMEZONES.has(market.exchangeTimezoneName ?? '')
		)
			excludedSymbols.set(symbol, 'Unsupported or unverified market data');
	}
	eligible = eligible.filter((buy) => {
		const reason = excludedSymbols.get(buy.symbol!);
		if (reason) exclude(buy, reason);
		return !reason;
	});
	updateIncluded();
	if (!eligible.length)
		return unavailable(
			'no_supported_securities',
			'Market data could not verify supported USD securities for these purchases.'
		);
	coverage.rangeStartDate = eligible.map((buy) => buy.date!).sort()[0];
	const purchases: TimingPurchase[] = eligible.map((buy) => ({
		symbol: buy.symbol!,
		date: buy.date!,
		amountCents: buy.amountCents
	}));
	return {
		comparison: buildBuyTimingComparison({
			purchases,
			series: series.filter((item) => !excludedSymbols.has(item.symbol)),
			calendar: calendar.prices.map((point) => point.date),
			schedule,
			startDate: coverage.rangeStartDate,
			endDate: coverage.rangeEndDate
		}),
		coverage,
		priceFetchedAt
	};
}
