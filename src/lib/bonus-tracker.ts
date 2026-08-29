import type { AccountBonus, FinancialAccount, FinancialAccountTransaction } from '$lib/types';

export interface WellsFargoBonusTier {
	thresholdCents: number;
	rewardCents: number;
	label: string;
}

export interface WellsFargoBusinessTracker {
	account: FinancialAccount;
	balanceCents: number | null;
	currentTier: WellsFargoBonusTier | null;
	nextTier: WellsFargoBonusTier | null;
	amountToNextTierCents: number | null;
	fundingDeadline: string | null;
	qualificationDeadline: string | null;
	latestPayoutDate: string | null;
	likelyQualifyingTransactions: FinancialAccountTransaction[];
}

export const WELLS_FARGO_BUSINESS_BONUS_TIERS: WellsFargoBonusTier[] = [
	{ thresholdCents: 250_000, rewardCents: 40_000, label: '$2,500 balance' },
	{ thresholdCents: 1_000_000, rewardCents: 55_000, label: '$10,000 balance' },
	{ thresholdCents: 2_500_000, rewardCents: 82_500, label: '$25,000 balance' }
];

function addDays(value: string | null, days: number): string | null {
	if (!value) return null;
	const date = new Date(`${value}T00:00:00Z`);
	if (!Number.isFinite(date.getTime())) return null;
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function normalizedTransactionText(transaction: FinancialAccountTransaction): string {
	return `${transaction.name} ${transaction.merchantName ?? ''}`
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, ' ')
		.trim();
}

export function isLikelyWellsFargoQualifyingTransaction(
	transaction: FinancialAccountTransaction,
	openedDate: string,
	qualificationDeadline: string
): boolean {
	if (
		transaction.pending ||
		transaction.amountCents === 0 ||
		transaction.date < openedDate ||
		transaction.date > qualificationDeadline
	) {
		return false;
	}

	const text = normalizedTransactionText(transaction);
	if (
		/\bZELLE\b|\bFEDNOW\b|\bRTP\b|REAL TIME PAYMENT|ORIGINAL CREDIT|\bOCT\b|ATM WITHDRAWAL|CASH WITHDRAWAL|INTERNAL TRANSFER|WELLS FARGO TRANSFER|WIRE OUT|ACH WITHDRAWAL|DEBIT CARD CREDIT/.test(
			text
		)
	) {
		return false;
	}

	if (/\bBILL PAY(?:MENT)?\b/.test(text)) return true;

	const primary = transaction.categoryPrimary?.toUpperCase() ?? '';
	const detailed = transaction.categoryDetailed?.toUpperCase() ?? '';
	if (transaction.amountCents < 0) {
		return (
			primary === 'INCOME' ||
			primary === 'TRANSFER_IN' ||
			/DEPOSIT|PAYCHECK|ACH CREDIT|WIRE TRANSFER IN/.test(`${text} ${detailed}`)
		);
	}

	if (
		['TRANSFER_IN', 'TRANSFER_OUT', 'CASH_ADVANCE', 'BANK_FEES', 'LOAN_PAYMENTS'].includes(primary)
	) {
		return false;
	}
	return Boolean(transaction.merchantName || detailed);
}

export function buildWellsFargoBusinessTracker(
	bonus: AccountBonus,
	account: FinancialAccount | null,
	transactions: FinancialAccountTransaction[]
): WellsFargoBusinessTracker | null {
	if (
		!account ||
		account.source !== 'plaid' ||
		account.accountType !== 'checking' ||
		account.ownerType !== 'business' ||
		bonus.rewardCents !== 82_500 ||
		!account.institution?.toLowerCase().includes('wells fargo')
	) {
		return null;
	}

	const balanceCents = account.currentBalanceCents;
	const currentTier =
		balanceCents === null
			? null
			: (WELLS_FARGO_BUSINESS_BONUS_TIERS.filter((tier) => balanceCents >= tier.thresholdCents).at(
					-1
				) ?? null);
	const nextTier =
		balanceCents === null
			? WELLS_FARGO_BUSINESS_BONUS_TIERS[0]
			: (WELLS_FARGO_BUSINESS_BONUS_TIERS.find((tier) => balanceCents < tier.thresholdCents) ??
				null);
	const qualificationDeadline = bonus.requirementDeadline ?? addDays(bonus.openedDate, 59);
	const likelyQualifyingTransactions =
		bonus.openedDate && qualificationDeadline
			? transactions.filter((transaction) =>
					isLikelyWellsFargoQualifyingTransaction(
						transaction,
						bonus.openedDate!,
						qualificationDeadline
					)
				)
			: [];

	return {
		account,
		balanceCents,
		currentTier,
		nextTier,
		amountToNextTierCents:
			nextTier && balanceCents !== null
				? Math.max(0, nextTier.thresholdCents - balanceCents)
				: (nextTier?.thresholdCents ?? null),
		fundingDeadline: addDays(bonus.openedDate, 29),
		qualificationDeadline,
		latestPayoutDate: bonus.expectedPayoutDate,
		likelyQualifyingTransactions
	};
}
