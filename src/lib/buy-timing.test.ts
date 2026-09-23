import { describe, expect, it } from 'vitest';
import {
	buildBuyTimingComparison,
	type BuyTimingMarketSeries,
	type BuyTimingSchedule,
	type TimingPurchase
} from './buy-timing';

function calendarBetween(start: string, end: string, holidays: string[] = []): string[] {
	const dates: string[] = [];
	for (let time = Date.parse(start); time <= Date.parse(end); time += 86_400_000) {
		const day = new Date(time);
		const date = day.toISOString().slice(0, 10);
		if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && !holidays.includes(date))
			dates.push(date);
	}
	return dates;
}

function market(
	symbol: string,
	calendar: string[],
	overrides: Record<string, number> = {},
	basePrice = 100
): BuyTimingMarketSeries {
	return {
		symbol,
		prices: calendar.map((date) => ({ date, adjustedClose: overrides[date] ?? basePrice }))
	};
}

const startDate = '2026-01-05';
const endDate = '2026-01-16';
const calendar = calendarBetween(startDate, endDate);
const purchases: TimingPurchase[] = [
	{ symbol: 'AAA', date: '2026-01-07', amountCents: 10_000 },
	{ symbol: 'AAA', date: '2026-01-14', amountCents: 10_000 }
];

function compare(series: BuyTimingMarketSeries[] = [market('AAA', calendar)], buys = purchases) {
	return buildBuyTimingComparison({
		purchases: buys,
		series,
		calendar,
		schedule: 'weekly',
		startDate,
		endDate
	});
}

describe('buy-date comparison with a fixed schedule', () => {
	it.each([
		{ buyPrice: 50, actualValueCents: 40_000, differenceCents: 20_000, differencePercent: 100 },
		{ buyPrice: 200, actualValueCents: 10_000, differenceCents: -10_000, differencePercent: -50 },
		{ buyPrice: 100, actualValueCents: 20_000, differenceCents: 0, differencePercent: 0 }
	])(
		'calculates known better, worse, and flat outcomes at buy price $buyPrice',
		({ buyPrice, actualValueCents, differenceCents, differencePercent }) => {
			const result = compare([
				market('AAA', calendar, { '2026-01-07': buyPrice, '2026-01-14': buyPrice })
			]);
			expect(result).toMatchObject({
				status: 'available',
				totalInvestedCents: 20_000,
				actualValueCents,
				scheduledValueCents: 20_000,
				differenceCents,
				differencePercent,
				scheduleDates: ['2026-01-05', '2026-01-12']
			});
			if (result.status === 'available') {
				expect(result.points[0]).toEqual({
					date: startDate,
					actualValueCents: 20_000,
					scheduledValueCents: 20_000
				});
				expect(result.points.at(-1)).toMatchObject({
					actualValueCents,
					scheduledValueCents: 20_000
				});
			}
		}
	);

	it('includes idle cash so unequal purchase amounts never look like gains in a flat market', () => {
		const result = compare(undefined, [
			{ ...purchases[0], amountCents: 3_000 },
			{ ...purchases[1], amountCents: 17_000 }
		]);
		expect(result.status).toBe('available');
		if (result.status !== 'available') return;
		expect(
			result.points.every(
				(point) => point.actualValueCents === 20_000 && point.scheduledValueCents === 20_000
			)
		).toBe(true);
		expect(result.differenceCents).toBe(0);
	});

	it('preserves each security budget and aggregates buy-date markers without losing buy counts', () => {
		const result = compare(
			[
				market('AAA', calendar, { '2026-01-07': 50 }),
				market('BBB', calendar, { '2026-01-07': 200 })
			],
			[
				{ symbol: 'AAA', date: '2026-01-07', amountCents: 10_000 },
				{ symbol: 'BBB', date: '2026-01-07', amountCents: 2_000 },
				{ symbol: 'AAA', date: '2026-01-14', amountCents: 20_000 },
				{ symbol: 'BBB', date: '2026-01-14', amountCents: 8_000 }
			]
		);
		expect(result).toMatchObject({
			status: 'available',
			totalInvestedCents: 40_000,
			actualValueCents: 49_000,
			scheduledValueCents: 40_000,
			differenceCents: 9_000,
			differencePercent: 22.5,
			buyDates: [
				{ date: '2026-01-07', amountCents: 12_000 },
				{ date: '2026-01-14', amountCents: 28_000 }
			],
			securities: [
				{
					symbol: 'AAA',
					buyCount: 2,
					budgetCents: 30_000,
					actualValueCents: 40_000,
					scheduledValueCents: 30_000,
					differenceCents: 10_000
				},
				{
					symbol: 'BBB',
					buyCount: 2,
					budgetCents: 10_000,
					actualValueCents: 9_000,
					scheduledValueCents: 10_000,
					differenceCents: -1_000
				}
			]
		});
	});

	it('uses adjusted-close ratios without applying a second dividend or split adjustment', () => {
		const result = compare([
			market('AAA', calendar, {
				'2026-01-07': 90,
				'2026-01-12': 99,
				'2026-01-14': 99,
				'2026-01-16': 108.9
			})
		]);
		expect(result).toMatchObject({
			status: 'available',
			actualValueCents: 23_100,
			scheduledValueCents: 21_890,
			differenceCents: 1_210,
			differencePercent: 6.05
		});
	});

	it('takes purchase dollars as supplied and does not use fees or execution fills', () => {
		const withExtraFields = purchases.map((purchase) => ({
			...purchase,
			feesCents: 900,
			quantity: 1_000,
			priceMicros: 1
		}));
		expect(compare(undefined, withExtraFields)).toEqual(compare());
	});

	it.each([
		{
			schedule: 'monthly',
			start: '2026-01-20',
			end: '2026-03-05',
			holidays: [] as string[],
			expected: ['2026-01-20', '2026-02-02', '2026-03-02']
		},
		{
			schedule: 'weekly',
			start: '2026-01-06',
			end: '2026-01-20',
			holidays: ['2026-01-19'],
			expected: ['2026-01-06', '2026-01-12', '2026-01-20']
		},
		{
			schedule: 'biweekly',
			start: '2026-01-06',
			end: '2026-02-03',
			holidays: ['2026-01-19'],
			expected: ['2026-01-06', '2026-01-20', '2026-02-02']
		}
	])(
		'uses calendar $schedule boundaries, including a partial first interval and market holidays',
		({ schedule, start, end, holidays, expected }) => {
			const dates = calendarBetween(start, end, holidays);
			const result = buildBuyTimingComparison({
				purchases: [
					{ symbol: 'AAA', date: dates[0], amountCents: 100 },
					{ symbol: 'AAA', date: dates.at(-1)!, amountCents: 101 }
				],
				series: [market('AAA', dates)],
				calendar: dates,
				schedule: schedule as BuyTimingSchedule,
				startDate: start,
				endDate: end
			});
			expect(result).toMatchObject({
				status: 'available',
				scheduleDates: expected,
				differenceCents: 0
			});
		}
	);

	it('uses the last completed close while excluding only purchases outside the requested period', () => {
		const result = buildBuyTimingComparison({
			purchases: [
				...purchases,
				{ symbol: 'OLD', date: '2026-01-02', amountCents: 999_999 },
				{ symbol: 'NEW', date: '2026-01-21', amountCents: 999_999 }
			],
			series: [market('AAA', calendar)],
			calendar: [...calendar].reverse().concat(calendar[0]),
			schedule: 'weekly',
			startDate,
			endDate: '2026-01-20'
		});
		expect(result).toMatchObject({
			status: 'available',
			startDate,
			endDate: '2026-01-16',
			totalInvestedCents: 20_000
		});
	});

	it.each([
		{ purchaseDate: '2026-09-21', requestedEnd: '2026-09-21' },
		{ purchaseDate: '2026-09-19', requestedEnd: '2026-09-20' }
	])(
		'blocks an in-period purchase after the last available market close ($purchaseDate)',
		({ purchaseDate, requestedEnd }) => {
			const dates = calendarBetween('2026-09-14', '2026-09-18');
			const result = buildBuyTimingComparison({
				purchases: [
					{ symbol: 'AAA', date: '2026-09-15', amountCents: 10_000 },
					{ symbol: 'AAA', date: purchaseDate, amountCents: 90_000 }
				],
				series: [market('AAA', dates)],
				calendar: dates,
				schedule: 'weekly',
				startDate: dates[0],
				endDate: requestedEnd
			});
			expect(result).toMatchObject({ status: 'unavailable', reason: 'missing_purchase_price' });
			if (result.status === 'unavailable') expect(result.message).toContain(purchaseDate);
		}
	);

	it('never rolls an actual weekend purchase to a nearby close', () => {
		const result = compare(
			[market('AAA', [...calendar, '2026-01-10'])],
			[{ ...purchases[0], date: '2026-01-10' }, purchases[1]]
		);
		expect(result).toMatchObject({ status: 'unavailable', reason: 'missing_purchase_price' });
	});

	it.each(['2026-01-07', '2026-01-05', '2026-01-16', '2026-01-08'])(
		'blocks missing actual, scheduled, end, or chart-day prices (%s)',
		(missingDate) => {
			const missing = market(
				'AAA',
				calendar.filter((date) => date !== missingDate)
			);
			expect(compare([missing])).toMatchObject({ status: 'unavailable', reason: 'missing_prices' });
		}
	);

	it('does not silently drop a security with missing prices from a multi-security result', () => {
		const result = compare(
			[market('AAA', calendar)],
			[...purchases, { symbol: 'BBB', date: '2026-01-07', amountCents: 30_000 }]
		);
		expect(result).toMatchObject({ status: 'unavailable', reason: 'missing_prices' });
	});

	it('requires two actual dates and two scheduled dates', () => {
		expect(
			compare(undefined, [purchases[0], { ...purchases[0], amountCents: 20_000 }])
		).toMatchObject({ status: 'unavailable', reason: 'insufficient_purchases' });
		expect(
			buildBuyTimingComparison({
				purchases,
				series: [market('AAA', calendar)],
				calendar,
				schedule: 'monthly',
				startDate,
				endDate
			})
		).toMatchObject({ status: 'unavailable', reason: 'insufficient_schedule' });
	});

	it('preserves pennies with fractional installments and reconciles security rows to totals', () => {
		const dates = calendarBetween('2026-01-20', '2026-03-05');
		const result = buildBuyTimingComparison({
			purchases: [
				{ symbol: 'AAA', date: '2026-01-20', amountCents: 101 },
				{ symbol: 'BBB', date: '2026-02-20', amountCents: 103 }
			],
			series: [market('AAA', dates, {}, 3), market('BBB', dates, {}, 7)],
			calendar: dates,
			schedule: 'monthly',
			startDate: dates[0],
			endDate: dates.at(-1)!
		});
		expect(result).toMatchObject({
			status: 'available',
			totalInvestedCents: 204,
			actualValueCents: 204,
			scheduledValueCents: 204,
			differenceCents: 0
		});
		if (result.status !== 'available') return;
		expect(
			result.points.every(
				(point) => point.actualValueCents === 204 && point.scheduledValueCents === 204
			)
		).toBe(true);
		expect(
			result.securities.reduce((total, security) => total + security.actualValueCents, 0)
		).toBe(result.actualValueCents);
		expect(
			result.securities.reduce((total, security) => total + security.scheduledValueCents, 0)
		).toBe(result.scheduledValueCents);
	});

	it.each([0, -1, NaN, Infinity, null as unknown as number])(
		'rejects invalid adjusted prices (%s)',
		(price) => {
			const invalid = market('AAA', calendar);
			invalid.prices[2].adjustedClose = price;
			expect(compare([invalid])).toMatchObject({ status: 'unavailable', reason: 'missing_prices' });
		}
	);

	it('rejects conflicting duplicate quotes rather than depending on input order', () => {
		const conflicting = market('AAA', calendar);
		conflicting.prices.push({ date: startDate, adjustedClose: 1 });
		expect(compare([conflicting])).toMatchObject({
			status: 'unavailable',
			reason: 'invalid_prices'
		});
	});

	it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid principal (%s)',
		(amountCents) => {
			expect(compare(undefined, [{ ...purchases[0], amountCents }, purchases[1]])).toMatchObject({
				status: 'unavailable',
				reason: 'invalid_purchase'
			});
		}
	);

	it('rejects overflowing principal, units, and ending values instead of emitting Infinity', () => {
		expect(
			compare(
				undefined,
				purchases.map((purchase) => ({ ...purchase, amountCents: Number.MAX_SAFE_INTEGER }))
			)
		).toMatchObject({ status: 'unavailable', reason: 'invalid_values' });
		expect(compare([market('AAA', calendar, { '2026-01-07': Number.MIN_VALUE })])).toMatchObject({
			status: 'unavailable',
			reason: 'invalid_values'
		});
		expect(compare([market('AAA', calendar, { '2026-01-16': Number.MAX_VALUE })])).toMatchObject({
			status: 'unavailable',
			reason: 'invalid_values'
		});
	});

	it('does not mutate the supplied purchases, price series, or calendar', () => {
		const input = {
			purchases: structuredClone(purchases),
			series: [market('AAA', calendar)],
			calendar: [...calendar],
			schedule: 'weekly' as const,
			startDate,
			endDate
		};
		const original = structuredClone(input);
		expect(buildBuyTimingComparison(input).status).toBe('available');
		expect(input).toEqual(original);
	});
});
