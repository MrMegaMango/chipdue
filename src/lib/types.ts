export type CardSource = 'manual' | 'plaid';

export type TransactionHistoryStatus =
	| 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN'
	| 'NOT_READY'
	| 'INITIAL_UPDATE_COMPLETE'
	| 'HISTORICAL_UPDATE_COMPLETE';

export interface Card {
	id: string;
	source: CardSource;
	nickname: string;
	issuer: string | null;
	issuerLogoUrl: string | null;
	last4: string | null;
	currency: string;
	statementBalanceCents: number | null;
	minimumPaymentCents: number | null;
	currentBalanceCents: number | null;
	dueDate: string | null;
	statementDate: string | null;
	isOverdue: boolean | null;
	autopayEnabled: boolean;
	transactionHistoryEnabled: boolean;
	transactionHistoryStatus: TransactionHistoryStatus | null;
	plaidConnectionId: string | null;
	createdAt: string;
	updatedAt: string;
	lastSyncedAt: string | null;
}

export interface CardTransaction {
	id: string;
	name: string;
	merchantName: string | null;
	amountCents: number;
	currency: string;
	date: string;
	authorizedDate: string | null;
	pending: boolean;
	categoryPrimary: string | null;
	categoryDetailed: string | null;
}

export interface ManualCardInput {
	nickname: string;
	issuer?: string | null;
	last4?: string | null;
	currency?: string;
	statementBalanceCents?: number | null;
	minimumPaymentCents?: number | null;
	currentBalanceCents?: number | null;
	dueDate?: string | null;
	statementDate?: string | null;
	isOverdue?: boolean | null;
	autopayEnabled?: boolean;
}

export interface PlaidConnection {
	id: string;
	institutionName: string | null;
	status: 'healthy' | 'needs_update';
	lastSyncedAt: string | null;
	createdAt: string;
}
