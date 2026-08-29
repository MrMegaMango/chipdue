import type { AccountBalanceHistoryPoint, FinancialAccount } from '$lib/types';
import type { EtradePosition, EtradeTransaction } from './etrade';
import type { HistoricalCloseSeries } from './market-history';

const CASH_SECURITY = /cash|money.?market/i;
const UNSUPPORTED_SECURITY = /option|future|bond/i;

export interface BrokerageHistoryEstimate {
	points: AccountBalanceHistoryPoint[];
	unpricedSymbols: string[];
}

function transactionShareDelta(transaction: EtradeTransaction): number {
	if (
		!transaction.symbol ||
		!transaction.quantity ||
		UNSUPPORTED_SECURITY.test(transaction.securityType)
	)
		return 0;
	const kind = transaction.transactionType.toLowerCase();
	if (/buy|bought|purchase|reinvest/.test(kind)) return Math.abs(transaction.quantity);
	if (/sell|sold|redemption/.test(kind)) return -Math.abs(transaction.quantity);
	return 0;
}

function isExternalCashFlow(transaction: EtradeTransaction): boolean {
	return /deposit|withdraw|transfer|wire|ach|contribution|distribution/.test(
		transaction.transactionType.toLowerCase()
	);
}

function cents(value: number): number {
	const result = Math.round(value * 100);
	return Number.isSafeInteger(result) ? result : 0;
}

export function reconstructBrokerageHistory(
	account: FinancialAccount,
	positions: EtradePosition[],
	cashBalance: number,
	transactions: EtradeTransaction[],
	series: HistoricalCloseSeries[],
	startDate: string,
	endDate: string
): BrokerageHistoryEstimate {
	const prices = new Map(series.map((item) => [item.symbol.toUpperCase(), item.closes]));
	const priceEntries = new Map(
		series.map((item) => [
			item.symbol.toUpperCase(),
			[...item.closes.entries()].sort(([left], [right]) => left.localeCompare(right))
		])
	);
	const priceOnDay = (symbol: string, day: string): number | undefined => {
		const entries = priceEntries.get(symbol) ?? [];
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			if (entries[index][0] <= day) return entries[index][1];
		}
		return undefined;
	};
	const eligiblePositions = positions.filter(
		(position) =>
			position.symbol &&
			!CASH_SECURITY.test(`${position.securityType} ${position.symbol}`) &&
			!UNSUPPORTED_SECURITY.test(position.securityType)
	);
	const quantities = new Map<string, number>();
	for (const position of eligiblePositions) {
		quantities.set(position.symbol.toUpperCase(), position.quantity);
	}
	const relevantTransactions = transactions
		.filter((transaction) => transaction.date >= startDate && transaction.date <= endDate)
		.slice()
		.sort((left, right) => right.date.localeCompare(left.date));
	for (const transaction of relevantTransactions) {
		if (transaction.symbol && transactionShareDelta(transaction) !== 0) {
			const symbol = transaction.symbol.toUpperCase();
			if (!quantities.has(symbol)) quantities.set(symbol, 0);
		}
	}

	const marketDates = [...new Set(series.flatMap((item) => [...item.closes.keys()]))]
		.filter((day) => day >= startDate && day <= endDate)
		.sort((left, right) => right.localeCompare(left));
	const currentPositionValue = eligiblePositions.reduce(
		(total, position) => total + position.marketValue,
		0
	);
	const accountValue =
		(account.currentBalanceCents ?? cents(currentPositionValue + cashBalance)) / 100;
	const residualValue = accountValue - currentPositionValue - cashBalance;
	let cash = cashBalance;
	let netContributions =
		account.netContributionsCents === null ? null : account.netContributionsCents / 100;
	let transactionIndex = 0;
	const points: AccountBalanceHistoryPoint[] = [];

	for (const day of marketDates) {
		while (
			transactionIndex < relevantTransactions.length &&
			relevantTransactions[transactionIndex].date > day
		) {
			const transaction = relevantTransactions[transactionIndex];
			cash -= transaction.amount;
			if (netContributions !== null && isExternalCashFlow(transaction)) {
				netContributions -= transaction.amount;
			}
			const delta = transactionShareDelta(transaction);
			if (transaction.symbol && delta !== 0) {
				const symbol = transaction.symbol.toUpperCase();
				quantities.set(symbol, (quantities.get(symbol) ?? 0) - delta);
			}
			transactionIndex += 1;
		}

		let securitiesValue = 0;
		for (const [symbol, quantity] of quantities) {
			const price = priceOnDay(symbol, day);
			if (price !== undefined) {
				securitiesValue += quantity * price;
			}
		}
		const balanceCents = cents(securitiesValue + cash + residualValue);
		points.push({
			recordedAt: `${day}T20:00:00.000Z`,
			balanceCents,
			netContributionsCents: netContributions === null ? null : cents(netContributions),
			source: 'estimated'
		});
	}

	const unsupportedSymbols = [
		...positions
			.filter((position) => UNSUPPORTED_SECURITY.test(position.securityType))
			.map((position) => position.symbol.toUpperCase()),
		...transactions
			.filter((transaction) => UNSUPPORTED_SECURITY.test(transaction.securityType))
			.flatMap((transaction) => (transaction.symbol ? [transaction.symbol.toUpperCase()] : []))
	];
	const unpricedSymbols = [...new Set([...quantities.keys(), ...unsupportedSymbols])]
		.filter((symbol) => unsupportedSymbols.includes(symbol) || !prices.get(symbol)?.size)
		.sort();
	return { points: points.reverse(), unpricedSymbols };
}
