import type { AccountBalanceHistoryPoint } from './types';

export interface BenchmarkPrice {
	date: string;
	adjustedClose: number;
}

export type BenchmarkRange = '1M' | '3M' | 'YTD' | '1Y' | 'ALL';

export interface InvestmentComparisonPoint {
	date: string;
	accountReturnPercent: number;
	benchmarkReturnPercent: number;
	accountValueCents: number;
	benchmarkValueCents: number | null;
}

export type InvestmentComparison =
	| {
			status: 'available';
			points: InvestmentComparisonPoint[];
			summary: {
				accountReturnPercent: number;
				benchmarkReturnPercent: number;
				excessPercentagePoints: number;
				accountValueCents: number;
				benchmarkValueCents: number | null;
				differenceCents: number | null;
			};
			startDate: string;
			endDate: string;
			estimatedHistory: boolean;
			trimmedHistory: boolean;
	  }
	| {
			status: 'unavailable';
			reason:
				| 'unsupported_currency'
				| 'insufficient_history'
				| 'missing_contributions'
				| 'market_data_unavailable'
				| 'nonpositive_balance'
				| 'invalid_values';
	  };

type DatedHistoryPoint = AccountBalanceHistoryPoint & { date: string };
type UsablePoint = DatedHistoryPoint & {
	netContributionsCents: number;
	adjustedClose: number;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const marketDateFormat = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'America/New_York',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});
const marketHourFormat = new Intl.DateTimeFormat('en-US', {
	timeZone: 'America/New_York',
	hour: 'numeric',
	hourCycle: 'h23'
});

function validDay(day: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
	const timestamp = Date.parse(`${day}T00:00:00Z`);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === day;
}

function historyByDay(history: AccountBalanceHistoryPoint[]): DatedHistoryPoint[] {
	const daily = new Map<string, DatedHistoryPoint>();
	for (const point of history) {
		const timestamp = Date.parse(point.recordedAt);
		if (!Number.isFinite(timestamp)) continue;
		// Historical estimates already describe a market close. Observations must use
		// the market's calendar day, rather than rolling into tomorrow after 5pm PDT.
		const date =
			point.source === 'estimated'
				? point.recordedAt.slice(0, 10)
				: marketDateFormat.format(new Date(timestamp));
		if (!validDay(date)) continue;
		const existing = daily.get(date);
		if (existing) {
			if (preferReconstructedClose(existing, point)) continue;
			if (preferReconstructedClose(point, existing)) {
				daily.set(date, { ...point, date });
				continue;
			}
		}
		if (!existing || timestamp >= Date.parse(existing.recordedAt)) {
			daily.set(date, { ...point, date });
		}
	}
	return [...daily.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function preferReconstructedClose(
	close: AccountBalanceHistoryPoint,
	observation: AccountBalanceHistoryPoint
): boolean {
	if (
		close.source !== 'estimated' ||
		observation.source !== 'observed' ||
		!Number.isSafeInteger(close.netContributionsCents) ||
		!Number.isSafeInteger(close.balanceCents) ||
		close.balanceCents <= 0
	) {
		return false;
	}
	// An intraday snapshot is not a close. An after-close snapshot with complete
	// contributions may contain a correction and keeps the normal latest priority.
	return (
		Number(marketHourFormat.format(new Date(observation.recordedAt))) < 16 ||
		(observation.balanceCents > 0 && !Number.isSafeInteger(observation.netContributionsCents))
	);
}

function historyForRange(history: DatedHistoryPoint[], range: BenchmarkRange): DatedHistoryPoint[] {
	if (range === 'ALL' || history.length === 0) return history;
	const endDate = history.at(-1)!.date;
	const cutoff =
		range === 'YTD'
			? `${endDate.slice(0, 4)}-01-01`
			: new Date(
					Date.parse(`${endDate}T00:00:00Z`) -
						(range === '1M' ? 30 : range === '3M' ? 90 : 365) * DAY_MS
				)
					.toISOString()
					.slice(0, 10);
	const firstInRange = history.findIndex((point) => point.date >= cutoff);
	if (firstInRange <= 0) return firstInRange === 0 ? history : [];
	const previous = history[firstInRange - 1];
	// A nearby prior close anchors weekends, holidays, and the start of the year.
	// Never expand a short range by months merely because observations are sparse.
	const priorAge = Date.parse(`${cutoff}T00:00:00Z`) - Date.parse(`${previous.date}T00:00:00Z`);
	return history.slice(priorAge <= 7 * DAY_MS ? firstInRange - 1 : firstInRange);
}

/**
 * Approximate time-weighted returns, with each change in cumulative external
 * contributions applied at the end of its valuation interval. Matching SPY
 * adjusted closes include dividend reinvestment. We never infer a zero flow
 * from missing contribution data or carry a market price to another date.
 */
export function buildInvestmentComparison(
	history: AccountBalanceHistoryPoint[],
	prices: BenchmarkPrice[],
	range: BenchmarkRange,
	currency = 'USD'
): InvestmentComparison {
	if (currency !== 'USD') return { status: 'unavailable', reason: 'unsupported_currency' };
	const scopedHistory = historyForRange(historyByDay(history), range);
	if (scopedHistory.length < 2) return { status: 'unavailable', reason: 'insufficient_history' };
	const priceByDate = new Map(
		prices
			.filter(
				(price) =>
					validDay(price.date) && Number.isFinite(price.adjustedClose) && price.adjustedClose > 0
			)
			.map((price) => [price.date, price.adjustedClose])
	);
	if (priceByDate.size === 0) return { status: 'unavailable', reason: 'market_data_unavailable' };

	const segments: UsablePoint[][] = [];
	let segment: UsablePoint[] = [];
	let missingContributions = false;
	let missingPrices = false;
	let nonpositiveBalance = false;
	let skippedWeekends = 0;
	function finishSegment() {
		if (segment.length >= 2) segments.push(segment);
		segment = [];
	}
	for (const point of scopedHistory) {
		const adjustedClose = priceByDate.get(point.date);
		const hasContributions =
			point.netContributionsCents !== null && Number.isSafeInteger(point.netContributionsCents);
		const hasBalance = Number.isSafeInteger(point.balanceCents) && point.balanceCents > 0;
		const weekday = new Date(`${point.date}T00:00:00Z`).getUTCDay();
		if (
			adjustedClose === undefined &&
			hasContributions &&
			hasBalance &&
			(weekday === 0 || weekday === 6)
		) {
			// There is no SPY close on weekends. The next matching close includes
			// the cumulative flow change; missing contributions still break below.
			skippedWeekends += 1;
			continue;
		}
		if (!hasContributions || !hasBalance || adjustedClose === undefined) {
			missingContributions ||= !hasContributions;
			nonpositiveBalance ||= !hasBalance;
			missingPrices ||= adjustedClose === undefined;
			finishSegment();
			continue;
		}
		const usable = { ...point, netContributionsCents: point.netContributionsCents!, adjustedClose };
		const previous = segment.at(-1);
		if (
			previous &&
			point.balanceCents - (usable.netContributionsCents - previous.netContributionsCents) <= 0
		) {
			// A complete loss followed by new capital cannot be linked through a
			// nonpositive pre-flow valuation. A later comparison can start here.
			nonpositiveBalance = true;
			finishSegment();
		}
		segment.push(usable);
	}
	finishSegment();
	const selected = segments.at(-1);
	if (!selected) {
		return {
			status: 'unavailable',
			reason: missingContributions
				? 'missing_contributions'
				: nonpositiveBalance
					? 'nonpositive_balance'
					: missingPrices
						? 'market_data_unavailable'
						: 'insufficient_history'
		};
	}

	const first = selected[0];
	let accountGrowth = 1;
	let benchmarkValue: number | null = first.balanceCents;
	const points = selected.map<InvestmentComparisonPoint>((point, index) => {
		if (index > 0) {
			const previous = selected[index - 1];
			const flow = point.netContributionsCents - previous.netContributionsCents;
			accountGrowth *= (point.balanceCents - flow) / previous.balanceCents;
			if (benchmarkValue !== null) {
				benchmarkValue = benchmarkValue * (point.adjustedClose / previous.adjustedClose) + flow;
				// An exhausted benchmark cannot finance further withdrawals without
				// borrowing. Keep the return comparison, but omit hypothetical dollars.
				if (benchmarkValue < 0 || !Number.isSafeInteger(Math.round(benchmarkValue))) {
					benchmarkValue = null;
				}
			}
		}
		return {
			date: point.date,
			accountReturnPercent: (accountGrowth - 1) * 100,
			benchmarkReturnPercent: (point.adjustedClose / first.adjustedClose - 1) * 100,
			accountValueCents: point.balanceCents,
			benchmarkValueCents: benchmarkValue === null ? null : Math.round(benchmarkValue)
		};
	});
	const latest = points.at(-1)!;
	if (
		points.some(
			(point) =>
				!Number.isFinite(point.accountReturnPercent) ||
				!Number.isFinite(point.benchmarkReturnPercent)
		) ||
		!Number.isFinite(latest.accountReturnPercent - latest.benchmarkReturnPercent)
	) {
		return { status: 'unavailable', reason: 'invalid_values' };
	}
	return {
		status: 'available',
		points,
		summary: {
			accountReturnPercent: latest.accountReturnPercent,
			benchmarkReturnPercent: latest.benchmarkReturnPercent,
			excessPercentagePoints: latest.accountReturnPercent - latest.benchmarkReturnPercent,
			accountValueCents: latest.accountValueCents,
			benchmarkValueCents: latest.benchmarkValueCents,
			differenceCents:
				latest.benchmarkValueCents === null
					? null
					: latest.accountValueCents - latest.benchmarkValueCents
		},
		startDate: first.date,
		endDate: selected.at(-1)!.date,
		estimatedHistory: selected.some((point) => point.source === 'estimated'),
		trimmedHistory: selected.length !== scopedHistory.length - skippedWeekends
	};
}
