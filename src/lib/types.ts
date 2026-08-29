export type CardSource = 'manual' | 'plaid';

export type CardRewardType = 'points' | 'miles' | 'cash_back';

export type CardRewardCategoryMatch =
	| 'dining'
	| 'groceries'
	| 'gas'
	| 'travel'
	| 'transit'
	| 'entertainment'
	| 'drugstores'
	| 'streaming'
	| 'online_shopping'
	| 'home_improvement'
	| 'utilities';

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
	rewardProgramName: string | null;
	rewardValueCents: number | null;
	rewardType: CardRewardType | null;
	rewardBaseRate: number | null;
	rewardCategories: CardRewardCategory[];
	transactionHistoryEnabled: boolean;
	transactionHistoryStatus: TransactionHistoryStatus | null;
	plaidConnectionId: string | null;
	createdAt: string;
	updatedAt: string;
	lastSyncedAt: string | null;
}

export interface CardRewardCategory {
	id: string;
	name: string;
	multiplier: number | null;
	matchCategory: CardRewardCategoryMatch | null;
}

export interface CardTransactionRewardEstimate {
	type: CardRewardType;
	amount: number;
	rate: number;
	categoryName: string | null;
	currency: string;
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
	rewardEstimate: CardTransactionRewardEstimate | null;
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

export interface CardRewardsInput {
	rewardProgramName?: string | null;
	rewardValueCents?: number | null;
	rewardType?: CardRewardType | null;
	rewardBaseRate?: number | null;
	rewardCategories?: Array<{
		id?: string;
		name: string;
		multiplier: number;
		matchCategory?: CardRewardCategoryMatch | null;
	}>;
}

export type FinancialAccountType =
	'checking' | 'savings' | 'brokerage' | 'cash_management' | 'other';

export type FinancialAccountOwner = 'personal' | 'business';
export type FinancialAccountStatus = 'planned' | 'active' | 'closed';
export type FinancialAccountSource = 'manual' | 'plaid';

export interface InvestmentHolding {
	name: string;
	tickerSymbol: string | null;
	securityType: string | null;
	quantity: number;
	priceMicros: number;
	valueCents: number | null;
	costBasisCents: number | null;
	currency: string;
	priceAsOf: string | null;
}

export interface FinancialAccount {
	id: string;
	source: FinancialAccountSource;
	nickname: string;
	institution: string | null;
	accountType: FinancialAccountType;
	ownerType: FinancialAccountOwner;
	status: FinancialAccountStatus;
	last4: string | null;
	currency: string;
	currentBalanceCents: number | null;
	costBasisCents: number | null;
	holdings: InvestmentHolding[];
	transactionHistoryEnabled: boolean;
	transactionHistoryStatus: TransactionHistoryStatus | null;
	openedDate: string | null;
	notes: string | null;
	plaidConnectionId: string | null;
	lastSyncedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export type FinancialAccountTransaction = Omit<CardTransaction, 'rewardEstimate'>;

export type BonusStatus =
	'planned' | 'active' | 'qualified' | 'pending' | 'paid' | 'closed' | 'abandoned';

export interface BonusRequirement {
	id: string;
	label: string;
	completed: boolean;
}

export interface AccountBonus {
	id: string;
	accountId: string | null;
	name: string;
	institution: string | null;
	rewardCents: number | null;
	currency: string;
	status: BonusStatus;
	openedDate: string | null;
	requirementDeadline: string | null;
	expectedPayoutDate: string | null;
	paidDate: string | null;
	safeToCloseDate: string | null;
	requirements: BonusRequirement[];
	notes: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface PlaidConnection {
	id: string;
	institutionName: string | null;
	status: 'healthy' | 'needs_update';
	lastSyncedAt: string | null;
	createdAt: string;
}
