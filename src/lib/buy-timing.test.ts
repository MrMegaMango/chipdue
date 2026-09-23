import { describe, expect, it } from 'vitest';
import {
	buildBuyTimingComparison,
	planCenteredPurchaseDates,
	shiftBuyTimingDate,
	type BuyTimingMarketSeries,
	type BuyTimingSchedule,
	type BuyTimingWindow,
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
	dates: string[],
	overrides: Record<string, number> = {},
	basePrice = 100
): BuyTimingMarketSeries {
	return {
		symbol,
		prices: dates.map((date) => ({ date, adjustedClose: overrides[date] ?? basePrice }))
	};
}

const calendar = calendarBetween('2025-08-01', '2026-06-30');
const startDate = '2026-03-01';
const endDate = '2026-06-30';
const purchase: TimingPurchase = { symbol: 'AAA', date: '2026-03-18', amountCents: 10_000 };
const beforeDates = ['2026-02-25', '2026-03-04', '2026-03-11'];
const afterDates = ['2026-03-25', '2026-04-01', '2026-04-08'];

function compare(overrides: Partial<Parameters<typeof buildBuyTimingComparison>[0]> = {}) {
	return buildBuyTimingComparison({
		purchases: [purchase],
		series: [market('AAA', calendar)],
		calendar,
		schedule: 'weekly',
		startDate,
		endDate,
		...overrides
	});
}

function plan(overrides: Partial<Parameters<typeof planCenteredPurchaseDates>[0]> = {}) {
	return planCenteredPurchaseDates({
		date: purchase.date,
		calendar,
		schedule: 'weekly',
		installmentsPerSide: 3,
		asOfDate: endDate,
		...overrides
	});
}

describe('centered purchase date planning', () => {
	it('places equal counts strictly before and after each purchase, with no center installment', () => {
		expect(plan()).toEqual({ status: 'ready', beforeDates, afterDates });
	});

	it.each(['weekly', 'biweekly', 'monthly'] as BuyTimingSchedule[])(
		'supports two, three, and six installments per side with %s dates',
		(schedule) => {
			const wideCalendar = calendarBetween('2025-01-01', '2027-01-01');
			for (const installmentsPerSide of [2, 3, 6] as BuyTimingWindow[]) {
				const result = plan({
					calendar: wideCalendar,
					schedule,
					installmentsPerSide,
					asOfDate: '2026-12-31'
				});
				expect(result.status).toBe('ready');
				if (result.status !== 'ready') continue;
				expect(result.beforeDates).toHaveLength(installmentsPerSide);
				expect(result.afterDates).toHaveLength(installmentsPerSide);
				expect(result.beforeDates.every((date) => date < purchase.date)).toBe(true);
				expect(result.afterDates.every((date) => date > purchase.date)).toBe(true);
			}
		}
	);

	it('rolls before holidays backward and after holidays forward', () => {
		expect(
			plan({ calendar: calendar.filter((date) => !['2026-03-04', '2026-03-25'].includes(date)) })
		).toEqual({
			status: 'ready',
			beforeDates: ['2026-02-25', '2026-03-03', '2026-03-11'],
			afterDates: ['2026-03-26', '2026-04-01', '2026-04-08']
		});
	});

	it('clamps each monthly target from the original day and rolls weekends outward', () => {
		expect(plan({ date: '2026-03-31', schedule: 'monthly' })).toEqual({
			status: 'ready',
			beforeDates: ['2025-12-31', '2026-01-30', '2026-02-27'],
			afterDates: ['2026-04-30', '2026-06-01', '2026-06-30']
		});
	});

	it('sorts and deduplicates calendar input without mutating it', () => {
		const unsorted = [...calendar].reverse().concat(calendar[0]);
		const original = [...unsorted];
		expect(plan({ calendar: unsorted })).toEqual(plan());
		expect(unsorted).toEqual(original);
	});

	it('requires the exact actual buy date and never moves a weekend purchase', () => {
		expect(plan({ date: '2026-03-21' })).toMatchObject({
			status: 'unavailable',
			reason: 'missing_purchase_price'
		});
		expect(plan({ calendar: calendar.filter((date) => date !== purchase.date) })).toMatchObject({
			status: 'unavailable',
			reason: 'missing_purchase_price'
		});
	});

	it('refuses missing preceding history', () => {
		expect(plan({ calendar: calendar.filter((date) => date >= '2026-03-01') })).toMatchObject({
			status: 'unavailable',
			reason: 'missing_schedule_price'
		});
	});

	it.each(['before', 'after'])(
		'does not roll more than seven days across a %s calendar gap',
		(side) => {
			const dates = calendar.filter((date) =>
				side === 'before'
					? date < '2026-02-17' || date > '2026-02-25'
					: date < '2026-04-08' || date > '2026-04-15'
			);
			expect(plan({ calendar: dates })).toMatchObject({
				status: 'unavailable',
				reason: 'missing_schedule_price'
			});
		}
	);

	it('marks the entire lot pending when its final target is in the future', () => {
		expect(plan({ asOfDate: '2026-04-06' })).toEqual({
			status: 'pending',
			completeAfterDate: '2026-04-08'
		});
	});

	it('does not accept future calendar dates as completed observations', () => {
		expect(plan({ asOfDate: '2026-03-20' })).toEqual({
			status: 'pending',
			completeAfterDate: '2026-04-08'
		});
	});

	it('marks an uncompleted weekend roll pending until the next weekday', () => {
		expect(
			plan({
				date: '2026-03-31',
				schedule: 'monthly',
				installmentsPerSide: 2,
				asOfDate: '2026-05-31'
			})
		).toEqual({ status: 'pending', completeAfterDate: '2026-06-01' });
	});

	it('does not disguise a stale calendar as a future window', () => {
		expect(plan({ calendar: calendar.filter((date) => date <= '2026-04-03') })).toMatchObject({
			status: 'unavailable',
			reason: 'missing_schedule_price'
		});
	});

	it('does not disguise a missing completed weekday or past weekend roll as pending', () => {
		expect(
			plan({ calendar: calendar.filter((date) => date <= '2026-04-07'), asOfDate: '2026-04-08' })
		).toMatchObject({ status: 'unavailable', reason: 'missing_schedule_price' });
		expect(
			plan({
				date: '2026-03-31',
				schedule: 'monthly',
				installmentsPerSide: 2,
				calendar: calendar.filter((date) => date <= '2026-05-29'),
				asOfDate: '2026-06-02'
			})
		).toMatchObject({ status: 'unavailable', reason: 'missing_schedule_price' });
	});

	it.each([
		{ date: '2026-02-30', reason: 'invalid_purchase' },
		{ asOfDate: '2026-01-01', reason: 'invalid_purchase' },
		{ schedule: 'daily' as BuyTimingSchedule, reason: 'invalid_schedule' },
		{ installmentsPerSide: 4 as BuyTimingWindow, reason: 'invalid_window' },
		{ calendar: ['wrong'], reason: 'invalid_calendar' }
	])('rejects invalid planner inputs ($reason)', ({ reason, ...overrides }) => {
		expect(plan(overrides)).toMatchObject({ status: 'unavailable', reason });
	});
});

describe('date offsets', () => {
	it('uses seven and fourteen calendar day spacing across year boundaries', () => {
		expect(shiftBuyTimingDate('2026-01-05', 'weekly', -2)).toBe('2025-12-22');
		expect(shiftBuyTimingDate('2025-12-22', 'biweekly', 2)).toBe('2026-01-19');
	});

	it('clamps calendar months correctly including leap years and negative offsets', () => {
		expect(shiftBuyTimingDate('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
		expect(shiftBuyTimingDate('2024-03-31', 'monthly', -1)).toBe('2024-02-29');
		expect(shiftBuyTimingDate('2026-01-31', 'monthly', 2)).toBe('2026-03-31');
		expect(shiftBuyTimingDate('2026-01-31', 'monthly', 0)).toBe('2026-01-31');
	});

	it('rejects malformed dates, unsupported schedules, fractional offsets, and overflow', () => {
		expect(() => shiftBuyTimingDate('2026-02-30', 'monthly', 1)).toThrow(RangeError);
		expect(() => shiftBuyTimingDate('2026-01-01', 'daily' as BuyTimingSchedule, 1)).toThrow(
			RangeError
		);
		expect(() => shiftBuyTimingDate('2026-01-01', 'monthly', 1.5)).toThrow(RangeError);
		expect(() => shiftBuyTimingDate('2026-01-01', 'monthly', Number.MAX_SAFE_INTEGER)).toThrow(
			RangeError
		);
	});
});

describe('per-purchase centered comparison', () => {
	it.each([
		{ buyPrice: 50, actualValueCents: 20_000, differenceCents: 10_000, differencePercent: 100 },
		{ buyPrice: 200, actualValueCents: 5_000, differenceCents: -5_000, differencePercent: -50 },
		{ buyPrice: 100, actualValueCents: 10_000, differenceCents: 0, differencePercent: 0 }
	])(
		'one mature buy at $buyPrice produces a known better, worse, or neutral outcome',
		({ buyPrice, actualValueCents, differenceCents, differencePercent }) => {
			const result = compare({ series: [market('AAA', calendar, { [purchase.date]: buyPrice })] });
			expect(result).toMatchObject({
				status: 'available',
				installmentsPerSide: 3,
				startDate: beforeDates[0],
				endDate,
				totalInvestedCents: 10_000,
				actualValueCents,
				scheduledValueCents: 10_000,
				differenceCents,
				differencePercent,
				scheduledPurchaseCount: 6,
				scheduleDates: [...beforeDates, ...afterDates],
				purchases: [
					{
						...purchase,
						beforeDates,
						afterDates,
						actualValueCents,
						scheduledValueCents: 10_000,
						differenceCents
					}
				]
			});
		}
	);

	it('spends exactly half before and half after with equal fractional installments', () => {
		const overrides = Object.fromEntries([
			...beforeDates.map((date) => [date, 50]),
			...afterDates.map((date) => [date, 200])
		]);
		const result = compare({
			purchases: [{ ...purchase, amountCents: 10_001 }],
			series: [market('AAA', calendar, overrides)]
		});
		expect(result).toMatchObject({
			status: 'available',
			totalInvestedCents: 10_001,
			actualValueCents: 10_001,
			scheduledValueCents: 12_501,
			differenceCents: -2_500
		});
		if (result.status !== 'available') return;
		// Before the center, half the dollars have bought at 50 and half remain cash.
		expect(result.points.find((point) => point.date === '2026-03-17')).toMatchObject({
			actualValueCents: 10_001,
			scheduledValueCents: 15_002
		});
	});

	it('keeps unequal lots neutral in a flat market, including all cash before each exposure', () => {
		const result = compare({
			purchases: [
				{ ...purchase, amountCents: 3_001 },
				{ ...purchase, date: '2026-04-15', amountCents: 17_000 }
			]
		});
		expect(result.status).toBe('available');
		if (result.status !== 'available') return;
		expect(
			result.points.every(
				(point) => point.actualValueCents === 20_001 && point.scheduledValueCents === 20_001
			)
		).toBe(true);
		expect(result.totalInvestedCents).toBe(20_001);
		expect(result.scheduledPurchaseCount).toBe(12);
	});

	it('centers each lot independently and preserves each security and lot budget', () => {
		const buys = [
			{ ...purchase, amountCents: 10_000 },
			{ ...purchase, date: '2026-04-15', amountCents: 20_000 },
			{ ...purchase, symbol: 'BBB', amountCents: 2_000 }
		];
		const result = compare({
			purchases: buys,
			series: [
				market('AAA', calendar, { [purchase.date]: 50, '2026-04-15': 200 }),
				market('BBB', calendar, { [purchase.date]: 200 })
			]
		});
		expect(result).toMatchObject({
			status: 'available',
			totalInvestedCents: 32_000,
			actualValueCents: 31_000,
			scheduledPurchaseCount: 18,
			securities: [
				{ symbol: 'AAA', budgetCents: 30_000, buyCount: 2 },
				{ symbol: 'BBB', budgetCents: 2_000, buyCount: 1 }
			],
			buyDates: [
				{ date: purchase.date, amountCents: 12_000 },
				{ date: '2026-04-15', amountCents: 20_000 }
			]
		});
		if (result.status !== 'available') return;
		const second = result.purchases.find((lot) => lot.date === '2026-04-15')!;
		expect(second.beforeDates).toEqual(['2026-03-25', '2026-04-01', '2026-04-08']);
		expect(second.afterDates).toEqual(['2026-04-22', '2026-04-29', '2026-05-06']);
		expect(result.purchases.reduce((sum, lot) => sum + lot.amountCents, 0)).toBe(
			result.totalInvestedCents
		);
		expect(result.purchases.reduce((sum, lot) => sum + lot.scheduledValueCents, 0)).toBe(
			result.scheduledValueCents
		);
		expect(result.securities.reduce((sum, security) => sum + security.differenceCents, 0)).toBe(
			result.differenceCents
		);
	});

	it('counts overlapping scheduled installments separately while deduplicating displayed dates', () => {
		const result = compare({ purchases: [purchase, { ...purchase, amountCents: 8_000 }] });
		expect(result).toMatchObject({
			status: 'available',
			totalInvestedCents: 18_000,
			scheduledPurchaseCount: 12,
			scheduleDates: [...beforeDates, ...afterDates]
		});
	});

	it('does not mix a partial future window into completed results', () => {
		const result = compare({
			purchases: [purchase, { ...purchase, date: '2026-06-23', amountCents: 50_000 }]
		});
		expect(result).toMatchObject({ status: 'unavailable', reason: 'incomplete_window' });
		expect(result).not.toHaveProperty('actualValueCents');
	});

	it('selects lots inside the requested period but includes their preceding prices in the chart', () => {
		const result = compare({
			purchases: [
				{ ...purchase, date: '2026-02-18', amountCents: 90_000 },
				purchase,
				{ ...purchase, date: '2026-07-01', amountCents: 90_000 }
			]
		});
		expect(result).toMatchObject({
			status: 'available',
			startDate: '2026-02-25',
			totalInvestedCents: 10_000,
			scheduledPurchaseCount: 6
		});
	});

	it('ends both paths on the last completed market day through the requested end', () => {
		const result = compare({ endDate: '2026-06-28' });
		expect(result).toMatchObject({ status: 'available', endDate: '2026-06-26' });
	});

	it('does not need prices before a particular security first becomes exposed', () => {
		const laterDates = calendar.filter((date) => date >= '2026-03-25');
		const result = compare({
			purchases: [purchase, { symbol: 'NEW', date: '2026-04-15', amountCents: 5_000 }],
			series: [market('AAA', calendar), market('NEW', laterDates)]
		});
		expect(result).toMatchObject({
			status: 'available',
			totalInvestedCents: 15_000,
			differenceCents: 0
		});
	});

	it.each(['2026-03-18', '2026-03-25', '2026-05-18'])(
		'blocks a missing required adjusted close on %s without carrying or skipping it',
		(missingDate) => {
			expect(
				compare({
					series: [
						market(
							'AAA',
							calendar.filter((date) => date !== missingDate)
						)
					]
				})
			).toMatchObject({ status: 'unavailable', reason: 'missing_prices' });
		}
	);

	it('uses adjusted-price ratios without applying a second split or dividend adjustment', () => {
		const result = compare({
			series: [market('AAA', calendar, { [purchase.date]: 90, [endDate]: 108.9 }, 99)]
		});
		expect(result).toMatchObject({
			status: 'available',
			actualValueCents: 12_100,
			scheduledValueCents: 11_000,
			differenceCents: 1_100
		});
	});

	it('normalizes symbols and is independent of input order without mutating arrays', () => {
		const input = {
			purchases: [{ ...purchase, symbol: ' aaa ' }],
			series: [market('AAA', calendar)],
			calendar: [...calendar].reverse()
		};
		const original = structuredClone(input);
		expect(compare(input)).toEqual(compare());
		expect(input).toEqual(original);
	});

	it('rejects conflicting adjusted closes and ignores unrelated securities', () => {
		expect(
			compare({
				series: [
					market('AAA', calendar),
					{ symbol: 'AAA', prices: [{ date: purchase.date, adjustedClose: 50 }] }
				]
			})
		).toMatchObject({ status: 'unavailable', reason: 'invalid_prices' });
		expect(
			compare({
				series: [
					market('AAA', calendar),
					{ symbol: 'OTHER', prices: [{ date: purchase.date, adjustedClose: NaN }] }
				]
			})
		).toEqual(compare());
	});

	it.each([0, -1, NaN, Infinity])('rejects invalid adjusted closes: %s', (adjustedClose) => {
		expect(
			compare({ series: [market('AAA', calendar, { [purchase.date]: adjustedClose })] })
		).toMatchObject({ status: 'unavailable', reason: 'missing_prices' });
	});

	it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid principal cents: %s', (amountCents) => {
		expect(compare({ purchases: [{ ...purchase, amountCents }] })).toMatchObject({
			status: 'unavailable',
			reason: 'invalid_purchase'
		});
	});

	it('rejects overflow in budget totals and modeled values', () => {
		expect(
			compare({ purchases: [{ ...purchase, amountCents: Number.MAX_SAFE_INTEGER }, purchase] })
		).toMatchObject({ status: 'unavailable', reason: 'invalid_values' });
		expect(
			compare({ series: [market('AAA', calendar, { [purchase.date]: Number.MIN_VALUE })] })
		).toMatchObject({ status: 'unavailable', reason: 'invalid_values' });
	});

	it.each([
		{ startDate: 'bad', reason: 'invalid_range' },
		{ endDate: '2026-02-28', reason: 'invalid_range' },
		{ schedule: 'daily' as BuyTimingSchedule, reason: 'invalid_schedule' },
		{ installmentsPerSide: 4 as BuyTimingWindow, reason: 'invalid_window' },
		{ calendar: ['bad'], reason: 'invalid_calendar' },
		{ purchases: [], reason: 'insufficient_purchases' },
		{ purchases: [{ ...purchase, date: '2026-02-30' }], reason: 'invalid_purchase' },
		{ purchases: [{ ...purchase, symbol: ' ' }], reason: 'invalid_purchase' }
	])('rejects invalid comparison inputs ($reason)', ({ reason, ...overrides }) => {
		expect(compare(overrides)).toMatchObject({ status: 'unavailable', reason });
	});
});
