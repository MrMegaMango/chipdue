export type BuyTimingSchedule = 'monthly' | 'weekly' | 'biweekly';
export type BuyTimingRange = '1M' | '3M' | 'YTD' | '1Y' | 'ALL';

export interface TimingPurchase {
	symbol: string;
	date: string;
	amountCents: number;
}

export interface BuyTimingMarketSeries {
	symbol: string;
	prices: Array<{ date: string; adjustedClose: number }>;
}

export interface BuyTimingPoint {
	date: string;
	actualValueCents: number;
	scheduledValueCents: number;
}

export interface BuyTimingSecurityResult {
	symbol: string;
	buyCount: number;
	budgetCents: number;
	actualValueCents: number;
	scheduledValueCents: number;
	differenceCents: number;
}

export type BuyTimingComparison =
	| {
			status: 'available';
			startDate: string;
			endDate: string;
			schedule: BuyTimingSchedule;
			scheduleDates: string[];
			totalInvestedCents: number;
			actualValueCents: number;
			scheduledValueCents: number;
			differenceCents: number;
			differencePercent: number;
			points: BuyTimingPoint[];
			buyDates: Array<{ date: string; amountCents: number }>;
			securities: BuyTimingSecurityResult[];
	  }
	| { status: 'unavailable'; reason: string; message: string };

export interface BuyTimingCoverage {
	transactionCount: number;
	buyCount: number;
	includedBuyCount: number;
	postedDateBuyCount: number;
	excludedBuyCount: number;
	excludedAmountCents: number;
	exclusions: Array<{ reason: string; count: number; amountCents: number }>;
	activitySyncedAt: string | null;
	rangeStartDate: string;
	rangeEndDate: string;
	capped: boolean;
}

export interface BuyTimingResponse {
	comparison: BuyTimingComparison;
	coverage: BuyTimingCoverage;
	priceFetchedAt: string | null;
}

const DAY_MS = 86_400_000;

function validDate(date: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
	const timestamp = Date.parse(`${date}T00:00:00Z`);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

function unavailable(reason: string, message: string): BuyTimingComparison {
	return { status: 'unavailable', reason, message };
}

function symbolKey(symbol: string): string {
	return symbol.trim().toUpperCase();
}

function mondayTimestamp(date: string): number {
	const timestamp = Date.parse(`${date}T00:00:00Z`);
	const weekday = new Date(timestamp).getUTCDay();
	return timestamp - ((weekday + 6) % 7) * DAY_MS;
}

/**
 * Buy at the first trading day in each calendar interval. The first interval
 * may be partial: it starts on the first trading day inside the chosen window.
 * Weekly and biweekly schedules use Monday boundaries; biweekly boundaries
 * remain anchored to the Monday of the first interval, including holidays.
 */
function scheduledDates(calendar: string[], schedule: BuyTimingSchedule): string[] {
	const firstMonday = mondayTimestamp(calendar[0]);
	const intervalDays = schedule === 'biweekly' ? 14 : 7;
	const firstByInterval = new Map<string, string>();
	for (const date of calendar) {
		const interval =
			schedule === 'monthly'
				? date.slice(0, 7)
				: String(
						Math.floor((Date.parse(`${date}T00:00:00Z`) - firstMonday) / (intervalDays * DAY_MS))
					);
		if (!firstByInterval.has(interval)) firstByInterval.set(interval, date);
	}
	return [...firstByInterval.values()];
}

function roundedValue(value: number): number | null {
	if (!Number.isFinite(value) || value < 0) return null;
	const rounded = Math.round(value);
	return Number.isSafeInteger(rounded) ? rounded : null;
}

/**
 * A buys-only counterfactual: both paths begin with the same cash budget, earn
 * no interest on idle cash, and hold every modeled purchase through the end.
 * Adjusted-close ratios model distributions and splits. Recorded purchase
 * dollars are taken as provided; this engine does not add fees or infer fills.
 */
export function buildBuyTimingComparison({
	purchases,
	series,
	calendar,
	schedule,
	startDate,
	endDate
}: {
	purchases: TimingPurchase[];
	series: BuyTimingMarketSeries[];
	calendar: string[];
	schedule: BuyTimingSchedule;
	startDate: string;
	endDate: string;
}): BuyTimingComparison {
	if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) {
		return unavailable('invalid_range', 'Choose a valid start and end date for the comparison.');
	}
	if (!['monthly', 'weekly', 'biweekly'].includes(schedule)) {
		return unavailable('invalid_schedule', 'Choose a monthly, weekly, or biweekly schedule.');
	}
	if (calendar.some((date) => !validDate(date))) {
		return unavailable('invalid_calendar', 'The trading calendar could not be verified.');
	}
	const tradingDates = [...new Set(calendar)]
		.filter((date) => date >= startDate && date <= endDate)
		.sort();
	if (tradingDates.length === 0) {
		return unavailable(
			'insufficient_market_days',
			'At least two completed trading days are needed.'
		);
	}
	const completedEndDate = tradingDates.at(-1)!;
	if (purchases.some((purchase) => !validDate(purchase.date))) {
		return unavailable('invalid_purchase', 'A recorded purchase is missing a valid date.');
	}
	const scopedPurchases = purchases
		// Keep the full requested budget even when the market feed is delayed.
		// A missing recent close must block comparison, never remove that purchase.
		.filter((purchase) => purchase.date >= startDate && purchase.date <= endDate)
		.map((purchase) => ({ ...purchase, symbol: symbolKey(purchase.symbol) }));
	if (
		scopedPurchases.some(
			(purchase) =>
				!purchase.symbol || !Number.isSafeInteger(purchase.amountCents) || purchase.amountCents <= 0
		)
	) {
		return unavailable(
			'invalid_purchase',
			'Every included purchase needs a security and a positive amount.'
		);
	}
	const totalInvestedCents = scopedPurchases.reduce(
		(total, purchase) => total + purchase.amountCents,
		0
	);
	if (!Number.isSafeInteger(totalInvestedCents)) {
		return unavailable(
			'invalid_values',
			'The purchase amounts are too large for a reliable comparison.'
		);
	}
	const purchasesByDate = new Map<string, number>();
	for (const purchase of scopedPurchases) {
		purchasesByDate.set(
			purchase.date,
			(purchasesByDate.get(purchase.date) ?? 0) + purchase.amountCents
		);
	}
	const tradingDateSet = new Set(tradingDates);
	const unmatchedPurchase = scopedPurchases.find((purchase) => !tradingDateSet.has(purchase.date));
	if (unmatchedPurchase) {
		return unavailable(
			'missing_purchase_price',
			`No completed market close matches the ${unmatchedPurchase.symbol} purchase on ${unmatchedPurchase.date}. Recorded purchase dates are never moved to another day.`
		);
	}
	if (tradingDates.length < 2) {
		return unavailable(
			'insufficient_market_days',
			'At least two completed trading days are needed.'
		);
	}
	if (purchasesByDate.size < 2) {
		return unavailable(
			'insufficient_purchases',
			'At least two distinct recorded buy dates are needed in this period.'
		);
	}
	const scheduleDates = scheduledDates(tradingDates, schedule);
	if (scheduleDates.length < 2) {
		return unavailable(
			'insufficient_schedule',
			'Choose a longer period with at least two scheduled purchases.'
		);
	}
	const scheduleDateSet = new Set(scheduleDates);
	const purchasesBySymbol = new Map<string, TimingPurchase[]>();
	for (const purchase of scopedPurchases) {
		const current = purchasesBySymbol.get(purchase.symbol) ?? [];
		current.push(purchase);
		purchasesBySymbol.set(purchase.symbol, current);
	}
	const pricesBySymbol = new Map<string, Map<string, number>>();
	for (const market of series) {
		const symbol = symbolKey(market.symbol);
		if (!purchasesBySymbol.has(symbol)) continue;
		const priceMap = pricesBySymbol.get(symbol) ?? new Map<string, number>();
		for (const price of market.prices) {
			if (!tradingDateSet.has(price.date)) continue;
			if (!Number.isFinite(price.adjustedClose) || price.adjustedClose <= 0) {
				return unavailable(
					'missing_prices',
					`A valid adjusted close is unavailable for ${symbol} on ${price.date}.`
				);
			}
			const existing = priceMap.get(price.date);
			if (existing !== undefined && existing !== price.adjustedClose) {
				return unavailable(
					'invalid_prices',
					`Conflicting adjusted closes were returned for ${symbol} on ${price.date}.`
				);
			}
			priceMap.set(price.date, price.adjustedClose);
		}
		pricesBySymbol.set(symbol, priceMap);
	}
	// Every security has scheduled exposure from the first day. Requiring all
	// daily closes avoids silently carrying prices or dropping an unfavorable lot.
	for (const symbol of purchasesBySymbol.keys()) {
		const prices = pricesBySymbol.get(symbol);
		const missingDate = tradingDates.find((date) => !prices?.has(date));
		if (missingDate) {
			return unavailable(
				'missing_prices',
				`An adjusted close is unavailable for ${symbol} on ${missingDate}. The comparison needs complete prices for every included security.`
			);
		}
	}

	const points = tradingDates.map<BuyTimingPoint>((date) => ({
		date,
		actualValueCents: 0,
		scheduledValueCents: 0
	}));
	const securities: BuyTimingSecurityResult[] = [];
	for (const [symbol, securityPurchases] of purchasesBySymbol) {
		const prices = pricesBySymbol.get(symbol)!;
		const budgetCents = securityPurchases.reduce(
			(total, purchase) => total + purchase.amountCents,
			0
		);
		const dailyPurchases = new Map<string, number>();
		for (const purchase of securityPurchases) {
			dailyPurchases.set(
				purchase.date,
				(dailyPurchases.get(purchase.date) ?? 0) + purchase.amountCents
			);
		}
		let actualUnits = 0;
		let scheduledUnits = 0;
		let actualSpent = 0;
		let scheduleCount = 0;
		let actualValueCents = budgetCents;
		let scheduledValueCents = budgetCents;
		for (const [index, date] of tradingDates.entries()) {
			const price = prices.get(date)!;
			const purchaseAmount = dailyPurchases.get(date) ?? 0;
			actualUnits += purchaseAmount / price;
			actualSpent += purchaseAmount;
			if (scheduleDateSet.has(date)) {
				scheduledUnits += budgetCents / scheduleDates.length / price;
				scheduleCount += 1;
			}
			const actualValue = roundedValue(budgetCents - actualSpent + actualUnits * price);
			// Derive cumulative spending from the count to avoid penny drift, and
			// ensure the full identical budget is deployed by the final installment.
			const scheduledSpent = (scheduleCount * budgetCents) / scheduleDates.length;
			const scheduledValue = roundedValue(budgetCents - scheduledSpent + scheduledUnits * price);
			if (actualValue === null || scheduledValue === null) {
				return unavailable(
					'invalid_values',
					'The price and purchase values cannot support a finite comparison.'
				);
			}
			actualValueCents = actualValue;
			scheduledValueCents = scheduledValue;
			points[index].actualValueCents += actualValue;
			points[index].scheduledValueCents += scheduledValue;
			if (
				!Number.isSafeInteger(points[index].actualValueCents) ||
				!Number.isSafeInteger(points[index].scheduledValueCents)
			) {
				return unavailable(
					'invalid_values',
					'The resulting values are too large for a reliable comparison.'
				);
			}
		}
		securities.push({
			symbol,
			buyCount: securityPurchases.length,
			budgetCents,
			actualValueCents,
			scheduledValueCents,
			differenceCents: actualValueCents - scheduledValueCents
		});
	}
	const latest = points.at(-1)!;
	const differenceCents = latest.actualValueCents - latest.scheduledValueCents;
	const differencePercent = (differenceCents / totalInvestedCents) * 100;
	if (!Number.isFinite(differencePercent)) {
		return unavailable(
			'invalid_values',
			'The resulting difference cannot support a reliable comparison.'
		);
	}
	return {
		status: 'available',
		startDate: tradingDates[0],
		endDate: completedEndDate,
		schedule,
		scheduleDates,
		totalInvestedCents,
		actualValueCents: latest.actualValueCents,
		scheduledValueCents: latest.scheduledValueCents,
		differenceCents,
		differencePercent,
		points,
		buyDates: [...purchasesByDate]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([date, amountCents]) => ({ date, amountCents })),
		securities: securities.sort(
			(left, right) =>
				right.budgetCents - left.budgetCents || left.symbol.localeCompare(right.symbol)
		)
	};
}
