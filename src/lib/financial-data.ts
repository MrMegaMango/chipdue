import type { FinancialDataProvider, TransactionHistoryStatus } from '#lib/types.ts';

export function sumMoneyByCurrency(
	values: ReadonlyArray<{ currency: string; amountCents: number | null }>
): Array<{ currency: string; amountCents: number }> {
	const totals = new Map<string, number>();
	for (const { currency, amountCents } of values) {
		if (amountCents === null) continue;
		totals.set(currency, (totals.get(currency) ?? 0) + amountCents);
	}
	return [...totals]
		.map(([currency, amountCents]) => ({ currency, amountCents }))
		.sort((a, b) => {
			if (a.currency === b.currency) return 0;
			if (a.currency === 'USD') return -1;
			if (b.currency === 'USD') return 1;
			return a.currency.localeCompare(b.currency);
		});
}

export const FINANCIAL_PROVIDER_NAMES = Object.freeze({
	plaid: 'Plaid'
} satisfies Record<FinancialDataProvider, string>);

export function financialProviderName(provider: FinancialDataProvider | null): string {
	return provider ? FINANCIAL_PROVIDER_NAMES[provider] : 'Connected provider';
}

type LegacyTransactionHistoryStatus =
	| 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN'
	| 'NOT_READY'
	| 'INITIAL_UPDATE_COMPLETE'
	| 'HISTORICAL_UPDATE_COMPLETE';

export type StoredTransactionHistoryStatus =
	TransactionHistoryStatus | LegacyTransactionHistoryStatus;

export function normalizeTransactionHistoryStatus(
	status: StoredTransactionHistoryStatus
): TransactionHistoryStatus {
	switch (status) {
		case 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN':
			return 'unknown';
		case 'NOT_READY':
			return 'preparing';
		case 'INITIAL_UPDATE_COMPLETE':
			return 'current';
		case 'HISTORICAL_UPDATE_COMPLETE':
			return 'historical_complete';
		default:
			return status;
	}
}
