export type BuyTimingSchedule = 'monthly' | 'weekly' | 'biweekly';
export type BuyTimingRange = '1M' | '3M' | 'YTD' | '1Y' | 'ALL';
export type BuyTimingWindow = 2 | 3 | 6;

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

export interface BuyTimingPurchaseResult extends TimingPurchase {
	beforeDates: string[];
	afterDates: string[];
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
			installmentsPerSide: BuyTimingWindow;
			scheduleDates: string[];
			scheduledPurchaseCount: number;
			totalInvestedCents: number;
			actualValueCents: number;
			scheduledValueCents: number;
			differenceCents: number;
			differencePercent: number;
			points: BuyTimingPoint[];
			buyDates: Array<{ date: string; amountCents: number }>;
			securities: BuyTimingSecurityResult[];
			purchases: BuyTimingPurchaseResult[];
	  }
	| { status: 'unavailable'; reason: string; message: string };

export interface BuyTimingCoverage {
	transactionCount: number;
	buyCount: number;
	includedBuyCount: number;
	postedDateBuyCount: number;
	excludedBuyCount: number;
	excludedAmountCents: number;
	pendingBuyCount: number;
	pendingAmountCents: number;
	nextCompleteAfterDate: string | null;
	installmentsPerSide: BuyTimingWindow;
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

export type CenteredPurchaseDates =
	| { status: 'ready'; beforeDates: string[]; afterDates: string[] }
	| { status: 'pending'; completeAfterDate: string }
	| { status: 'unavailable'; reason: string; message: string };

const DAY_MS = 86_400_000;

function validDate(date: string): boolean {
	if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
	const timestamp = Date.parse(`${date}T00:00:00Z`);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

function validSchedule(schedule: BuyTimingSchedule): boolean {
	return ['monthly', 'weekly', 'biweekly'].includes(schedule);
}

function validWindow(window: BuyTimingWindow): boolean {
	return [2, 3, 6].includes(window);
}

function unavailable(
	reason: string,
	message: string
): Extract<BuyTimingComparison, { status: 'unavailable' }> {
	return { status: 'unavailable', reason, message };
}

function symbolKey(symbol: string): string {
	return typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
}

/** Shift from the original purchase date, clamping calendar-month targets at month end. */
export function shiftBuyTimingDate(
	date: string,
	schedule: BuyTimingSchedule,
	offset: number
): string {
	if (!validDate(date) || !validSchedule(schedule) || !Number.isSafeInteger(offset)) {
		throw new RangeError('A valid date, schedule, and integer offset are required.');
	}
	const shifted = new Date(`${date}T00:00:00Z`);
	if (schedule === 'monthly') {
		const day = shifted.getUTCDate();
		shifted.setUTCDate(1);
		shifted.setUTCMonth(shifted.getUTCMonth() + offset);
		const lastDay = new Date(shifted);
		lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
		lastDay.setUTCDate(0);
		shifted.setUTCDate(Math.min(day, lastDay.getUTCDate()));
	} else {
		shifted.setUTCDate(shifted.getUTCDate() + offset * (schedule === 'weekly' ? 7 : 14));
	}
	if (!Number.isFinite(shifted.getTime()))
		throw new RangeError('The shifted date is out of range.');
	const result = shifted.toISOString().slice(0, 10);
	if (!validDate(result)) throw new RangeError('The shifted date is out of range.');
	return result;
}

/**
 * Plan each purchase independently. Half its budget precedes the recorded date
 * and half follows it. Holiday targets roll outward, never across the center.
 * asOfDate distinguishes an unfinished window from a stale market calendar.
 */
export function planCenteredPurchaseDates({
	date,
	calendar,
	schedule,
	installmentsPerSide,
	asOfDate
}: {
	date: string;
	calendar: string[];
	schedule: BuyTimingSchedule;
	installmentsPerSide: BuyTimingWindow;
	asOfDate: string;
}): CenteredPurchaseDates {
	if (!validDate(date) || !validDate(asOfDate) || date > asOfDate) {
		return unavailable('invalid_purchase', 'The purchase needs a valid completed date.');
	}
	if (!validSchedule(schedule)) {
		return unavailable('invalid_schedule', 'Choose a monthly, weekly, or biweekly schedule.');
	}
	if (!validWindow(installmentsPerSide)) {
		return unavailable('invalid_window', 'Choose two, three, or six installments on each side.');
	}
	if (calendar.some((day) => !validDate(day))) {
		return unavailable('invalid_calendar', 'The trading calendar could not be verified.');
	}
	const tradingDates = [...new Set(calendar)].filter((day) => day <= asOfDate).sort();
	if (!tradingDates.includes(date)) {
		return unavailable(
			'missing_purchase_price',
			`No completed market close matches the purchase on ${date}. Recorded purchase dates are never moved to another day.`
		);
	}
	const beforeDates: string[] = [];
	const afterDates: string[] = [];
	let finalTarget: string;
	try {
		finalTarget = shiftBuyTimingDate(date, schedule, installmentsPerSide);
		for (let offset = installmentsPerSide; offset >= 1; offset -= 1) {
			const target = shiftBuyTimingDate(date, schedule, -offset);
			const match = tradingDates.findLast((day) => day <= target);
			if (!match || match >= date || Date.parse(target) - Date.parse(match) > 7 * DAY_MS) {
				return unavailable(
					'missing_schedule_price',
					`The comparison needs a completed trading day on or just before ${target}.`
				);
			}
			beforeDates.push(match);
		}
	} catch {
		return unavailable(
			'invalid_range',
			'The centered purchase window is outside the supported dates.'
		);
	}
	// Do not present any part of a lot until its full symmetric window exists.
	if (finalTarget > asOfDate) return { status: 'pending', completeAfterDate: finalTarget };
	for (let offset = 1; offset <= installmentsPerSide; offset += 1) {
		const target = shiftBuyTimingDate(date, schedule, offset);
		const match = tradingDates.find((day) => day >= target);
		if (!match) {
			const nextWeekday = new Date(`${target}T00:00:00Z`);
			const weekday = nextWeekday.getUTCDay();
			if (weekday === 0 || weekday === 6) {
				nextWeekday.setUTCDate(nextWeekday.getUTCDate() + (weekday === 6 ? 2 : 1));
				if (nextWeekday.toISOString().slice(0, 10) > asOfDate) {
					return { status: 'pending', completeAfterDate: nextWeekday.toISOString().slice(0, 10) };
				}
			}
			return unavailable(
				'missing_schedule_price',
				`The completed trading calendar is missing the scheduled purchase on or after ${target}.`
			);
		}
		if (match <= date || Date.parse(match) - Date.parse(target) > 7 * DAY_MS) {
			return unavailable(
				'missing_schedule_price',
				`The comparison needs a completed trading day on or just after ${target}.`
			);
		}
		afterDates.push(match);
	}
	return { status: 'ready', beforeDates, afterDates };
}

function roundedValue(value: number): number | null {
	if (!Number.isFinite(value) || value < 0) return null;
	const rounded = Math.round(value);
	return Number.isSafeInteger(rounded) ? rounded : null;
}

/**
 * A centered, buys-only counterfactual. Each recorded purchase is compared with
 * equal installments of the same security totaling exactly the same dollars:
 * half before, half after, and none on the recorded buy date. Both paths start
 * with the full budget, earn no cash interest, and hold through a common end.
 * Adjusted-close ratios model distributions and splits, without execution fills.
 */
export function buildBuyTimingComparison({
	purchases,
	series,
	calendar,
	schedule,
	startDate,
	endDate,
	installmentsPerSide = 3
}: {
	purchases: TimingPurchase[];
	series: BuyTimingMarketSeries[];
	calendar: string[];
	schedule: BuyTimingSchedule;
	startDate: string;
	endDate: string;
	installmentsPerSide?: BuyTimingWindow;
}): BuyTimingComparison {
	if (!validDate(startDate) || !validDate(endDate) || endDate < startDate) {
		return unavailable('invalid_range', 'Choose a valid start and end date for the comparison.');
	}
	if (!validSchedule(schedule)) {
		return unavailable('invalid_schedule', 'Choose a monthly, weekly, or biweekly schedule.');
	}
	if (!validWindow(installmentsPerSide)) {
		return unavailable('invalid_window', 'Choose two, three, or six installments on each side.');
	}
	if (calendar.some((date) => !validDate(date))) {
		return unavailable('invalid_calendar', 'The trading calendar could not be verified.');
	}
	const completedCalendar = [...new Set(calendar)].filter((date) => date <= endDate).sort();
	if (purchases.some((purchase) => !validDate(purchase.date))) {
		return unavailable('invalid_purchase', 'A recorded purchase is missing a valid date.');
	}
	const scopedPurchases = purchases
		.filter((purchase) => purchase.date >= startDate && purchase.date <= endDate)
		.map((purchase) => ({ ...purchase, symbol: symbolKey(purchase.symbol) }));
	if (!scopedPurchases.length) {
		return unavailable(
			'insufficient_purchases',
			'At least one completed purchase window is needed.'
		);
	}
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
	const plannedPurchases: Array<TimingPurchase & { beforeDates: string[]; afterDates: string[] }> =
		[];
	for (const purchase of scopedPurchases) {
		const plan = planCenteredPurchaseDates({
			date: purchase.date,
			calendar: completedCalendar,
			schedule,
			installmentsPerSide,
			asOfDate: endDate
		});
		if (plan.status === 'unavailable') return plan;
		if (plan.status === 'pending') {
			return unavailable(
				'incomplete_window',
				`The full centered window for the ${purchase.date} purchase is not complete. It needs market data through at least ${plan.completeAfterDate}.`
			);
		}
		plannedPurchases.push({
			...purchase,
			beforeDates: plan.beforeDates,
			afterDates: plan.afterDates
		});
	}
	const firstExposureBySymbol = new Map<string, string>();
	for (const purchase of plannedPurchases) {
		const previous = firstExposureBySymbol.get(purchase.symbol);
		if (!previous || purchase.beforeDates[0] < previous)
			firstExposureBySymbol.set(purchase.symbol, purchase.beforeDates[0]);
	}
	const chartStartDate = [...firstExposureBySymbol.values()].sort()[0];
	const tradingDates = completedCalendar.filter((date) => date >= chartStartDate);
	const completedEndDate = tradingDates.at(-1)!;
	const tradingDateSet = new Set(tradingDates);
	const pricesBySymbol = new Map<string, Map<string, number>>();
	for (const market of series) {
		const symbol = symbolKey(market.symbol);
		const firstExposure = firstExposureBySymbol.get(symbol);
		if (!firstExposure) continue;
		const prices = pricesBySymbol.get(symbol) ?? new Map<string, number>();
		for (const price of market.prices) {
			if (!tradingDateSet.has(price.date) || price.date < firstExposure) continue;
			if (!Number.isFinite(price.adjustedClose) || price.adjustedClose <= 0) {
				return unavailable(
					'missing_prices',
					`A valid adjusted close is unavailable for ${symbol} on ${price.date}.`
				);
			}
			const existing = prices.get(price.date);
			if (existing !== undefined && existing !== price.adjustedClose) {
				return unavailable(
					'invalid_prices',
					`Conflicting adjusted closes were returned for ${symbol} on ${price.date}.`
				);
			}
			prices.set(price.date, price.adjustedClose);
		}
		pricesBySymbol.set(symbol, prices);
	}
	for (const [symbol, firstExposure] of firstExposureBySymbol) {
		const prices = pricesBySymbol.get(symbol);
		const missingDate = tradingDates.find((date) => date >= firstExposure && !prices?.has(date));
		if (missingDate) {
			return unavailable(
				'missing_prices',
				`An adjusted close is unavailable for ${symbol} on ${missingDate}. The comparison needs complete prices while each included security is invested.`
			);
		}
	}
	const points = tradingDates.map<BuyTimingPoint>((date) => ({
		date,
		actualValueCents: 0,
		scheduledValueCents: 0
	}));
	const purchaseResults: BuyTimingPurchaseResult[] = [];
	const securitiesBySymbol = new Map<string, BuyTimingSecurityResult>();
	const purchasesByDate = new Map<string, number>();
	const allScheduleDates = new Set<string>();
	const installmentsPerPurchase = installmentsPerSide * 2;
	for (const purchase of plannedPurchases) {
		const prices = pricesBySymbol.get(purchase.symbol)!;
		const scheduleCounts = new Map<string, number>();
		for (const date of [...purchase.beforeDates, ...purchase.afterDates]) {
			scheduleCounts.set(date, (scheduleCounts.get(date) ?? 0) + 1);
			allScheduleDates.add(date);
		}
		let actualUnits = 0;
		let scheduledUnits = 0;
		let scheduleCount = 0;
		let actualValueCents = purchase.amountCents;
		let scheduledValueCents = purchase.amountCents;
		for (const [index, date] of tradingDates.entries()) {
			if (date >= purchase.beforeDates[0]) {
				const price = prices.get(date)!;
				if (date === purchase.date) actualUnits = purchase.amountCents / price;
				const count = scheduleCounts.get(date) ?? 0;
				scheduledUnits += (count * purchase.amountCents) / installmentsPerPurchase / price;
				scheduleCount += count;
				const actualCash = date < purchase.date ? purchase.amountCents : 0;
				const scheduledCash =
					purchase.amountCents - (scheduleCount * purchase.amountCents) / installmentsPerPurchase;
				const actualValue = roundedValue(actualCash + actualUnits * price);
				const scheduledValue = roundedValue(scheduledCash + scheduledUnits * price);
				if (actualValue === null || scheduledValue === null) {
					return unavailable(
						'invalid_values',
						'The price and purchase values cannot support a finite comparison.'
					);
				}
				actualValueCents = actualValue;
				scheduledValueCents = scheduledValue;
			}
			points[index].actualValueCents += actualValueCents;
			points[index].scheduledValueCents += scheduledValueCents;
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
		purchaseResults.push({
			...purchase,
			actualValueCents,
			scheduledValueCents,
			differenceCents: actualValueCents - scheduledValueCents
		});
		purchasesByDate.set(
			purchase.date,
			(purchasesByDate.get(purchase.date) ?? 0) + purchase.amountCents
		);
		const security = securitiesBySymbol.get(purchase.symbol) ?? {
			symbol: purchase.symbol,
			buyCount: 0,
			budgetCents: 0,
			actualValueCents: 0,
			scheduledValueCents: 0,
			differenceCents: 0
		};
		security.buyCount += 1;
		security.budgetCents += purchase.amountCents;
		security.actualValueCents += actualValueCents;
		security.scheduledValueCents += scheduledValueCents;
		security.differenceCents = security.actualValueCents - security.scheduledValueCents;
		securitiesBySymbol.set(purchase.symbol, security);
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
		startDate: chartStartDate,
		endDate: completedEndDate,
		schedule,
		installmentsPerSide,
		scheduleDates: [...allScheduleDates].sort(),
		scheduledPurchaseCount: plannedPurchases.length * installmentsPerPurchase,
		totalInvestedCents,
		actualValueCents: latest.actualValueCents,
		scheduledValueCents: latest.scheduledValueCents,
		differenceCents,
		differencePercent,
		points,
		buyDates: [...purchasesByDate]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([date, amountCents]) => ({ date, amountCents })),
		securities: [...securitiesBySymbol.values()].sort(
			(left, right) =>
				right.budgetCents - left.budgetCents || left.symbol.localeCompare(right.symbol)
		),
		purchases: purchaseResults.sort(
			(left, right) =>
				left.date.localeCompare(right.date) || left.symbol.localeCompare(right.symbol)
		)
	};
}
