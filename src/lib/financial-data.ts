import type { FinancialDataProvider, TransactionHistoryStatus } from '$lib/types';

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
