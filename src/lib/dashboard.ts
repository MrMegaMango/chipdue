import type {
	AccountBonus,
	Card,
	CardRewardCategorySpend,
	CardTransaction,
	FinancialAccount,
	FinancialProviderStatus,
	TransactionHistoryStatus
} from './types';

export const DASHBOARD_ACTIVITY_LIMIT = 500;

export type DashboardResult<T> =
	{ ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export interface DashboardCards {
	cards: Card[];
	connections: {
		providers: FinancialProviderStatus[];
		connected: number;
		lastSyncedAt: string | null;
	};
}

export interface DashboardWorkspace {
	accounts: FinancialAccount[];
	bonuses: AccountBonus[];
}

export interface DashboardCardActivity {
	transactions: CardTransaction[];
	rewardCategorySpending: CardRewardCategorySpend[];
	status: TransactionHistoryStatus;
	lastSyncedAt: string | null;
}

export interface DashboardResponse {
	cards: DashboardResult<DashboardCards>;
	workspace: DashboardResult<DashboardWorkspace>;
	recentActivity: Record<string, DashboardResult<DashboardCardActivity>>;
}
