export type FinancialDataProvider = 'plaid';
export type FinancialRecordSource = 'manual' | 'connected';
export type CardSource = FinancialRecordSource;

export type CardRewardType = 'points' | 'miles' | 'cash_back';

export type CardRewardCategoryMatch =
	| 'dining'
	| 'groceries'
	| 'gas'
	| 'travel'
	| 'flights_hotels'
	| 'transit'
	| 'entertainment'
	| 'drugstores'
	| 'streaming'
	| 'online_shopping'
	| 'home_improvement'
	| 'utilities';

export type TransactionHistoryStatus = 'unknown' | 'preparing' | 'current' | 'historical_complete';

export interface Card {
	id: string;
	source: CardSource;
	nickname: string;
	providerProductName: string | null;
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
	rewardSource: 'automatic' | 'manual' | null;
	rewardProfileName: string | null;
	rewardCalculation: 'static' | 'venmo_spend_ranked' | null;
	transactionHistoryEnabled: boolean;
	transactionHistoryStatus: TransactionHistoryStatus | null;
	connectionId: string | null;
	connectionProvider: FinancialDataProvider | null;
	createdAt: string;
	updatedAt: string;
	lastSyncedAt: string | null;
}

export interface CardRewardCategory {
	id: string;
	name: string;
	multiplier: number | null;
	matchCategory: CardRewardCategoryMatch | null;
	annualSpendCapCents: number | null;
}

export interface CardRewardCategorySpend {
	categoryId: string;
	year: number;
	spentCents: number;
	capCents: number;
	remainingCents: number;
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
export type FinancialAccountSource = FinancialRecordSource;
export type FinancialAccountApySource = 'provider' | 'published' | 'manual';

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

export interface AccountBalanceHistoryPoint {
	recordedAt: string;
	balanceCents: number;
	netContributionsCents: number | null;
	source: 'observed' | 'estimated';
}

export interface BrokerageOrder {
	id: string;
	provider: 'etrade';
	symbol: string;
	description: string | null;
	action: string;
	quantity: number;
	filledQuantity: number;
	status: string;
	priceType: string;
	limitPriceMicros: number | null;
	stopPriceMicros: number | null;
	term: string;
	marketSession: string;
	placedAt: string | null;
}

export type BrokerageOrdersAvailability =
	'available' | 'not_configured' | 'authorization_required' | 'account_not_found';

export interface BrokerageOrdersResponse {
	availability: BrokerageOrdersAvailability;
	provider: 'etrade';
	orders: BrokerageOrder[];
	refreshedAt: string | null;
}

export interface BrokerageHistoryEstimateResponse {
	availability: BrokerageOrdersAvailability | 'activity_required';
	provider: 'etrade' | 'plaid';
	account: FinancialAccount | null;
	estimatedPointCount: number;
	startDate: string | null;
	endDate: string | null;
	unpricedSymbols: string[];
	refreshedAt: string | null;
}

export interface FinancialAccount {
	id: string;
	source: FinancialAccountSource;
	nickname: string;
	institution: string | null;
	institutionLogoUrl: string | null;
	accountType: FinancialAccountType;
	ownerType: FinancialAccountOwner;
	status: FinancialAccountStatus;
	hidden: boolean;
	last4: string | null;
	currency: string;
	currentBalanceCents: number | null;
	apyBasisPoints: number | null;
	apySource: FinancialAccountApySource | null;
	apyUpdatedAt: string | null;
	costBasisCents: number | null;
	netContributionsCents: number | null;
	balanceHistory: AccountBalanceHistoryPoint[];
	holdings: InvestmentHolding[];
	transactionHistoryEnabled: boolean;
	transactionHistoryStatus: TransactionHistoryStatus | null;
	openedDate: string | null;
	notes: string | null;
	connectionId: string | null;
	connectionProvider: FinancialDataProvider | null;
	lastSyncedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface InvestmentTransactionDetails {
	type: string;
	subtype: string;
	securityName: string | null;
	tickerSymbol: string | null;
	quantity: number;
	priceMicros: number;
	feesCents: number | null;
}

export type FinancialAccountTransaction = Omit<CardTransaction, 'rewardEstimate'> & {
	investmentDetails?: InvestmentTransactionDetails;
};

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
	offerTemplateId: string | null;
	offerDateOverrideConfirmed: boolean;
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

export interface FinancialConnection {
	id: string;
	provider: FinancialDataProvider;
	institutionName: string | null;
	status: 'healthy' | 'needs_update';
	lastSyncedAt: string | null;
	createdAt: string;
}

export interface FinancialProviderStatus {
	provider: FinancialDataProvider;
	displayName: string;
	configured: boolean;
	connectionCount: number;
	lastSyncedAt: string | null;
}
