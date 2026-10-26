import type {
	AccountBonus,
	Card,
	FinancialAccount,
	FinancialAccountTransaction,
	TransactionHistoryStatus
} from './types';

export const EMERGENCY_TRANSACTION_LIMIT = 100;

export interface EmergencyActivity {
	id: string;
	kind: 'card' | 'account';
	name: string;
	lastSyncedAt: string | null;
	status: TransactionHistoryStatus;
	transactions: FinancialAccountTransaction[];
}

export interface EmergencySnapshot {
	version: 1;
	capturedAt: string;
	cards: Card[];
	accounts: FinancialAccount[];
	bonuses: AccountBonus[];
	activity: EmergencyActivity[];
	transactionLimit: number;
}

export interface EmergencySession {
	configured: boolean;
	authenticated: boolean;
	sessionRef: string | null;
}
