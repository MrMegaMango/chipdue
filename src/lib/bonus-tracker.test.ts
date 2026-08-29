import { describe, expect, it } from 'vitest';
import type { AccountBonus, FinancialAccount, FinancialAccountTransaction } from '$lib/types';
import {
	buildWellsFargoBusinessTracker,
	isLikelyWellsFargoQualifyingTransaction
} from './bonus-tracker';

const account: FinancialAccount = {
	id: '00000000-0000-4000-8000-000000000001',
	source: 'plaid',
	nickname: 'Business checking',
	institution: 'Wells Fargo',
	accountType: 'checking',
	ownerType: 'business',
	status: 'active',
	last4: '1234',
	currency: 'USD',
	currentBalanceCents: 1_250_000,
	costBasisCents: null,
	holdings: [],
	transactionHistoryEnabled: true,
	transactionHistoryStatus: 'HISTORICAL_UPDATE_COMPLETE',
	openedDate: '2026-08-27',
	notes: null,
	plaidConnectionId: '00000000-0000-4000-8000-000000000002',
	lastSyncedAt: '2026-08-28T12:00:00.000Z',
	createdAt: '2026-08-27T12:00:00.000Z',
	updatedAt: '2026-08-28T12:00:00.000Z'
};

const bonus: AccountBonus = {
	id: '00000000-0000-4000-8000-000000000003',
	accountId: account.id,
	name: 'Wells Fargo business checking bonus (up to $825)',
	institution: 'Wells Fargo',
	rewardCents: 82_500,
	currency: 'USD',
	status: 'active',
	openedDate: '2026-08-27',
	requirementDeadline: '2026-10-25',
	expectedPayoutDate: '2026-11-24',
	paidDate: null,
	safeToCloseDate: '2026-11-25',
	requirements: [],
	notes: null,
	createdAt: '2026-08-28T12:00:00.000Z',
	updatedAt: '2026-08-28T12:00:00.000Z'
};

function transaction(
	changes: Partial<FinancialAccountTransaction> = {}
): FinancialAccountTransaction {
	return {
		id: '00000000-0000-4000-8000-000000000004',
		name: 'Coffee shop',
		merchantName: 'Coffee shop',
		amountCents: 1_234,
		currency: 'USD',
		date: '2026-08-28',
		authorizedDate: '2026-08-28',
		pending: false,
		categoryPrimary: 'FOOD_AND_DRINK',
		categoryDetailed: 'FOOD_AND_DRINK_COFFEE',
		...changes
	};
}

describe('Wells Fargo business bonus tracker', () => {
	it('calculates the conservative campaign deadlines and current balance tier', () => {
		const tracker = buildWellsFargoBusinessTracker(bonus, account, []);
		expect(tracker).toMatchObject({
			fundingDeadline: '2026-09-25',
			qualificationDeadline: '2026-10-25',
			latestPayoutDate: '2026-11-24',
			currentTier: { rewardCents: 55_000 },
			nextTier: { thresholdCents: 2_500_000, rewardCents: 82_500 },
			amountToNextTierCents: 1_250_000
		});
	});

	it('counts likely posted purchases, deposits, and Bill Pay activity conservatively', () => {
		const candidates = [
			transaction(),
			transaction({
				id: '00000000-0000-4000-8000-000000000005',
				name: 'Mobile deposit',
				merchantName: null,
				amountCents: -250_000,
				categoryPrimary: 'TRANSFER_IN',
				categoryDetailed: 'TRANSFER_IN_DEPOSIT'
			}),
			transaction({
				id: '00000000-0000-4000-8000-000000000006',
				name: 'Wells Fargo Bill Pay',
				merchantName: null,
				categoryPrimary: 'LOAN_PAYMENTS',
				categoryDetailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
			}),
			transaction({ name: 'Zelle transfer', merchantName: null, categoryPrimary: 'TRANSFER_IN' }),
			transaction({ name: 'ATM withdrawal', merchantName: null, categoryPrimary: 'CASH_ADVANCE' }),
			transaction({ pending: true }),
			transaction({ date: '2026-10-26' })
		];
		expect(
			candidates.filter((entry) =>
				isLikelyWellsFargoQualifyingTransaction(entry, '2026-08-27', '2026-10-25')
			)
		).toHaveLength(3);
		expect(
			buildWellsFargoBusinessTracker(bonus, account, candidates)?.likelyQualifyingTransactions
		).toHaveLength(3);
	});

	it('does not attach Wells Fargo rules to an unrelated account', () => {
		expect(
			buildWellsFargoBusinessTracker(bonus, { ...account, institution: 'Example Bank' }, [])
		).toBeNull();
	});
});
