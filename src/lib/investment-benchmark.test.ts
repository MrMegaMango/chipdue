import { describe, expect, it } from 'vitest';
import type { AccountBalanceHistoryPoint } from './types';
import { buildInvestmentComparison, type BenchmarkPrice } from './investment-benchmark';

function point(
	date: string,
	balanceCents: number,
	netContributionsCents: number | null,
	source: AccountBalanceHistoryPoint['source'] = 'estimated'
): AccountBalanceHistoryPoint {
	return { recordedAt: `${date}T20:00:00.000Z`, balanceCents, netContributionsCents, source };
}

function prices(...entries: Array<[string, number]>): BenchmarkPrice[] {
	return entries.map(([date, adjustedClose]) => ({ date, adjustedClose }));
}

describe('investment comparison with SPY', () => {
	it('compares matching periods and removes contributions before linking returns', () => {
		const result = buildInvestmentComparison(
			[
				point('2026-09-01', 10_000, 8_000),
				point('2026-09-02', 21_000, 18_000),
				point('2026-09-03', 22_050, 18_000)
			],
			prices(['2026-09-01', 100], ['2026-09-02', 105], ['2026-09-03', 110.25]),
			'ALL'
		);
		expect(result.status).toBe('available');
		if (result.status !== 'available') return;
		expect(result.startDate).toBe('2026-09-01');
		expect(result.endDate).toBe('2026-09-03');
		expect(result.points[0].accountReturnPercent).toBe(0);
		expect(result.summary.accountReturnPercent).toBeCloseTo(15.5);
		expect(result.summary.benchmarkReturnPercent).toBeCloseTo(10.25);
		expect(result.summary.excessPercentagePoints).toBeCloseTo(5.25);
		expect(result.summary.benchmarkValueCents).toBe(21_525);
		expect(result.summary.differenceCents).toBe(525);
		expect(result.estimatedHistory).toBe(true);
		expect(result.trimmedHistory).toBe(false);
	});

	it('does not count a deposit or withdrawal as investment performance', () => {
		const result = buildInvestmentComparison(
			[
				point('2026-09-01', 10_000, 10_000),
				point('2026-09-02', 20_000, 20_000),
				point('2026-09-03', 5_000, 5_000)
			],
			prices(['2026-09-01', 100], ['2026-09-02', 100], ['2026-09-03', 100]),
			'ALL'
		);
		expect(result).toMatchObject({
			status: 'available',
			summary: { accountReturnPercent: 0, benchmarkValueCents: 5_000, differenceCents: 0 }
		});
	});

	it('restarts at the latest contiguous contribution history instead of bridging a gap', () => {
		const result = buildInvestmentComparison(
			[
				point('2026-09-01', 10_000, 10_000),
				point('2026-09-02', 11_000, 10_000),
				point('2026-09-03', 30_000, null),
				point('2026-09-04', 40_000, 35_000),
				point('2026-09-08', 42_000, 35_000)
			],
			prices(
				['2026-09-01', 100],
				['2026-09-02', 101],
				['2026-09-03', 102],
				['2026-09-04', 103],
				['2026-09-08', 104]
			),
			'ALL'
		);
		expect(result).toMatchObject({
			status: 'available',
			startDate: '2026-09-04',
			endDate: '2026-09-08',
			trimmedHistory: true
		});
		if (result.status === 'available') expect(result.summary.accountReturnPercent).toBeCloseTo(5);
	});

	it('keeps the last complete segment when newer observations have unknown contributions', () => {
		const result = buildInvestmentComparison(
			[
				point('2026-09-01', 10_000, 10_000),
				point('2026-09-02', 11_000, 10_000),
				point('2026-09-03', 30_000, null, 'observed'),
				point('2026-09-04', 31_000, 30_000, 'observed')
			],
			prices(['2026-09-01', 100], ['2026-09-02', 101], ['2026-09-03', 102], ['2026-09-04', 103]),
			'ALL'
		);
		expect(result).toMatchObject({
			status: 'available',
			startDate: '2026-09-01',
			endDate: '2026-09-02',
			trimmedHistory: true
		});
	});

	it('never carries a stale SPY price to an unmatched account date', () => {
		const result = buildInvestmentComparison(
			[point('2026-09-01', 10_000, 10_000), point('2026-09-02', 11_000, 10_000)],
			prices(['2026-08-31', 100], ['2026-09-01', 101]),
			'ALL'
		);
		expect(result).toEqual({ status: 'unavailable', reason: 'market_data_unavailable' });
	});

	it('keeps comparison continuous over known weekend snapshots and their cash flows', () => {
		const result = buildInvestmentComparison(
			[
				point('2026-09-04', 10_000, 10_000),
				point('2026-09-05', 15_000, 15_000, 'observed'),
				point('2026-09-06', 15_000, 15_000, 'observed'),
				point('2026-09-08', 15_500, 15_000)
			],
			prices(['2026-09-04', 100], ['2026-09-08', 105]),
			'ALL'
		);
		expect(result).toMatchObject({
			status: 'available',
			startDate: '2026-09-04',
			endDate: '2026-09-08',
			trimmedHistory: false,
			summary: { benchmarkValueCents: 15_500, differenceCents: 0 }
		});
		if (result.status === 'available') expect(result.summary.accountReturnPercent).toBeCloseTo(5);
	});

	it('still breaks on a weekend snapshot with unknown contributions', () => {
		const result = buildInvestmentComparison(
			[
				point('2026-09-04', 10_000, 10_000),
				point('2026-09-05', 15_000, null, 'observed'),
				point('2026-09-08', 15_500, 15_000)
			],
			prices(['2026-09-04', 100], ['2026-09-08', 105]),
			'ALL'
		);
		expect(result).toEqual({ status: 'unavailable', reason: 'missing_contributions' });
	});

	it('does not substitute raw prices or zero values for missing adjusted closes', () => {
		const history = [point('2026-09-01', 10_000, 10_000), point('2026-09-02', 11_000, 10_000)];
		for (const invalid of [0, -1, NaN, Infinity, null as unknown as number]) {
			expect(
				buildInvestmentComparison(
					history,
					prices(['2026-09-01', invalid], ['2026-09-02', 100]),
					'ALL'
				)
			).toEqual({ status: 'unavailable', reason: 'market_data_unavailable' });
		}
	});

	it('uses market calendar dates and the latest observation within each day', () => {
		const result = buildInvestmentComparison(
			[
				point('2026-09-01', 10_000, 10_000, 'observed'),
				point('2026-09-02', 11_000, 10_000, 'observed'),
				{
					...point('2026-09-02', 12_000, 10_000, 'observed'),
					recordedAt: '2026-09-03T01:00:00.000Z'
				}
			],
			prices(['2026-09-01', 100], ['2026-09-02', 110]),
			'ALL'
		);
		expect(result).toMatchObject({
			status: 'available',
			endDate: '2026-09-02',
			estimatedHistory: false,
			summary: { accountValueCents: 12_000 }
		});
		if (result.status === 'available') {
			expect(result.points).toHaveLength(2);
			expect(result.summary.accountReturnPercent).toBeCloseTo(20);
		}
	});

	it('prefers a reconstructed close over same-day intraday or unknown-contribution observations', () => {
		for (const observation of [
			{ ...point('2026-09-02', 12_000, 10_000, 'observed'), recordedAt: '2026-09-02T19:00:00Z' },
			{ ...point('2026-09-02', 12_000, null, 'observed'), recordedAt: '2026-09-03T01:00:00Z' }
		]) {
			// Exercise both input orders: source priority cannot depend on array order.
			for (const sameDay of [
				[observation, point('2026-09-02', 11_000, 10_000)],
				[point('2026-09-02', 11_000, 10_000), observation]
			]) {
				const result = buildInvestmentComparison(
					[point('2026-09-01', 10_000, 10_000), ...sameDay],
					prices(['2026-09-01', 100], ['2026-09-02', 105]),
					'ALL'
				);
				expect(result).toMatchObject({
					status: 'available',
					estimatedHistory: true,
					summary: { accountValueCents: 11_000 }
				});
			}
		}
	});

	it('preserves a later complete after-close observation over a reconstruction', () => {
		const result = buildInvestmentComparison(
			[
				point('2026-09-01', 10_000, 10_000),
				point('2026-09-02', 11_000, 10_000),
				{ ...point('2026-09-02', 12_000, 10_500, 'observed'), recordedAt: '2026-09-03T01:00:00Z' }
			],
			prices(['2026-09-01', 100], ['2026-09-02', 105]),
			'ALL'
		);
		expect(result).toMatchObject({
			status: 'available',
			summary: { accountValueCents: 12_000 }
		});
		if (result.status === 'available') expect(result.summary.accountReturnPercent).toBeCloseTo(15);
	});

	it('anchors YTD to the last nearby prior-year close', () => {
		const result = buildInvestmentComparison(
			[
				point('2025-12-30', 9_000, 9_000),
				point('2025-12-31', 10_000, 9_000),
				point('2026-01-02', 10_500, 9_000),
				point('2026-09-02', 11_000, 9_000)
			],
			prices(['2025-12-30', 90], ['2025-12-31', 100], ['2026-01-02', 101], ['2026-09-02', 105]),
			'YTD'
		);
		expect(result).toMatchObject({
			status: 'available',
			startDate: '2025-12-31',
			endDate: '2026-09-02',
			trimmedHistory: false
		});
		if (result.status === 'available') expect(result.summary.accountReturnPercent).toBeCloseTo(10);
	});

	it('does not expand a one-month range to a sparse observation months earlier', () => {
		const result = buildInvestmentComparison(
			[point('2026-01-02', 10_000, 10_000), point('2026-09-02', 11_000, 10_000)],
			prices(['2026-01-02', 100], ['2026-09-02', 105]),
			'1M'
		);
		expect(result).toEqual({ status: 'unavailable', reason: 'insufficient_history' });
	});

	it('does not link through a nonpositive balance or pre-flow valuation', () => {
		for (const history of [
			[point('2026-09-01', 0, 0), point('2026-09-02', 1_000, 1_000)],
			[point('2026-09-01', 10_000, 10_000), point('2026-09-02', 1_000, 11_000)]
		]) {
			expect(
				buildInvestmentComparison(history, prices(['2026-09-01', 100], ['2026-09-02', 105]), 'ALL')
			).toEqual({ status: 'unavailable', reason: 'nonpositive_balance' });
		}
	});

	it('omits hypothetical dollars if withdrawals would require a negative SPY holding', () => {
		const result = buildInvestmentComparison(
			[point('2026-09-01', 10_000, 10_000), point('2026-09-02', 1_000, 0)],
			prices(['2026-09-01', 100], ['2026-09-02', 90]),
			'ALL'
		);
		expect(result).toMatchObject({
			status: 'available',
			summary: { benchmarkValueCents: null, differenceCents: null }
		});
		if (result.status === 'available') {
			expect(result.summary.accountReturnPercent).toBeCloseTo(10);
			expect(result.summary.benchmarkReturnPercent).toBeCloseTo(-10);
		}
	});

	it('requires contribution history and a matching benchmark currency', () => {
		const history = [point('2026-09-01', 10_000, null), point('2026-09-02', 11_000, null)];
		const benchmark = prices(['2026-09-01', 100], ['2026-09-02', 105]);
		expect(buildInvestmentComparison(history, benchmark, 'ALL')).toEqual({
			status: 'unavailable',
			reason: 'missing_contributions'
		});
		expect(buildInvestmentComparison(history, benchmark, 'ALL', 'CAD')).toEqual({
			status: 'unavailable',
			reason: 'unsupported_currency'
		});
	});

	it('never returns nonfinite percentages when values overflow the calculation', () => {
		const result = buildInvestmentComparison(
			[point('2026-09-01', 10_000, 10_000), point('2026-09-02', 11_000, 10_000)],
			prices(['2026-09-01', Number.MIN_VALUE], ['2026-09-02', 100]),
			'ALL'
		);
		expect(result).toEqual({ status: 'unavailable', reason: 'invalid_values' });
	});

	it('rejects nonfinite compounded account returns as well as benchmark ratios', () => {
		const history = Array.from({ length: 170 }, (_, index) => {
			const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
			return point(date, 10_000, 10_000 - index * 990_000);
		});
		const benchmark = history.map((entry) => ({
			date: entry.recordedAt.slice(0, 10),
			adjustedClose: 100
		}));
		expect(buildInvestmentComparison(history, benchmark, 'ALL')).toEqual({
			status: 'unavailable',
			reason: 'invalid_values'
		});
	});
});
