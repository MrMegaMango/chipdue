import { describe, expect, it } from 'vitest';
import type { AccountBonus, FinancialAccount, FinancialAccountTransaction } from '$lib/types';
import {
	automaticEarnedValueCents,
	buildBonusOfferDraft,
	buildBonusTracker,
	getBonusOfferTemplate,
	getCompatibleBonusOffers,
	isLikelyCapitalOneQualifyingTransaction,
	isLikelyUsBankQualifyingTransaction,
	isLikelyWellsFargoQualifyingTransaction
} from './bonus-offers';

const account: FinancialAccount = {
	id: '00000000-0000-4000-8000-000000000001',
	source: 'connected',
	nickname: 'Business checking',
	institution: 'Wells Fargo',
	institutionLogoUrl: null,
	accountType: 'checking',
	ownerType: 'business',
	status: 'active',
	hidden: false,
	last4: '1234',
	currency: 'USD',
	currentBalanceCents: 1_250_000,
	apyBasisPoints: null,
	apySource: null,
	apyUpdatedAt: null,
	costBasisCents: null,
	netContributionsCents: null,
	balanceHistory: [],
	holdings: [],
	transactionHistoryEnabled: true,
	transactionHistoryStatus: 'historical_complete',
	openedDate: '2026-08-27',
	notes: null,
	connectionId: '00000000-0000-4000-8000-000000000002',
	connectionProvider: 'plaid',
	lastSyncedAt: '2026-08-28T12:00:00.000Z',
	createdAt: '2026-08-27T12:00:00.000Z',
	updatedAt: '2026-08-28T12:00:00.000Z'
};

const bonus: AccountBonus = {
	id: '00000000-0000-4000-8000-000000000003',
	accountId: account.id,
	offerTemplateId: null,
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
		id: crypto.randomUUID(),
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

describe('versioned business bonus offer catalog', () => {
	it('keeps the existing Wells Fargo record on its verified legacy template', () => {
		const tracker = buildBonusTracker(bonus, account, []);
		expect(tracker).toMatchObject({
			fundingDeadline: '2026-09-25',
			qualificationDeadline: '2026-10-25',
			latestPayoutDate: '2026-11-24',
			currentTier: { rewardCents: 55_000 },
			nextTier: { thresholdCents: 2_500_000, rewardCents: 82_500 },
			amountToNextTierCents: 1_250_000,
			offer: { id: 'wells-fargo-business-checking-2026-09-08' }
		});
	});

	it('builds fixed U.S. Bank deadlines and requirements from the opening date', () => {
		const offer = getBonusOfferTemplate('us-bank-business-essentials-q3-2026');
		expect(offer).not.toBeNull();
		expect(buildBonusOfferDraft(offer!, '2026-08-27')).toMatchObject({
			rewardCents: 40_000,
			requirementDeadline: '2026-10-25',
			expectedPayoutDate: '2026-11-30',
			safeToCloseDate: '2026-12-01',
			requirements: [
				'Confirm promo code Q3DIG26 was applied at opening',
				expect.stringContaining('Sep 25, 2026'),
				expect.stringContaining('Oct 25, 2026'),
				expect.stringContaining('6 qualifying posted transactions'),
				expect.stringContaining('Nov 30, 2026')
			]
		});
	});

	it('offers both current U.S. Bank products without guessing which one was opened', () => {
		const usBankAccount = { ...account, institution: 'U.S. Bank National Association' };
		expect(getCompatibleBonusOffers(usBankAccount, '2026-08-27').map((offer) => offer.id)).toEqual([
			'us-bank-business-essentials-q3-2026',
			'us-bank-platinum-business-checking-q3-2026'
		]);
		expect(getCompatibleBonusOffers(usBankAccount, '2026-09-28')).toEqual([]);
	});

	it('requires explicit U.S. Bank offer confirmation before attaching a tracker', () => {
		const usBankAccount = {
			...account,
			institution: 'US Bank',
			currentBalanceCents: 600_000
		};
		const unconfirmed = {
			...bonus,
			accountId: usBankAccount.id,
			institution: 'U.S. Bank',
			rewardCents: 40_000
		};
		expect(buildBonusTracker(unconfirmed, usBankAccount, [])).toBeNull();
		const confirmed = {
			...unconfirmed,
			offerTemplateId: 'us-bank-business-essentials-q3-2026',
			expectedPayoutDate: '2026-11-30',
			safeToCloseDate: '2026-12-01'
		};
		expect(buildBonusTracker(confirmed, usBankAccount, [])).toMatchObject({
			currentTier: { rewardCents: 40_000 },
			qualificationDeadline: '2026-10-25',
			latestPayoutDate: '2026-11-30',
			offer: { transactionTarget: 6 }
		});
		expect(buildBonusTracker(confirmed, { ...usBankAccount, source: 'manual' }, [])).toMatchObject({
			account: { source: 'manual' },
			offer: { id: 'us-bank-business-essentials-q3-2026' }
		});
	});

	it('tracks the current Capital One SBOFFER500 promotion', () => {
		const capitalOneAccount = {
			...account,
			institution: 'Capital One',
			nickname: 'Business Basic Checking',
			currentBalanceCents: 501_075
		};
		const offer = getCompatibleBonusOffers(capitalOneAccount)[0];
		expect(offer).toMatchObject({
			id: 'capital-one-business-checking-sboffer500-2026',
			promoCode: 'SBOFFER500',
			transactionTarget: 10,
			qualificationLabel: 'Complete by'
		});
		expect(buildBonusOfferDraft(offer!, '2026-08-01')).toMatchObject({
			rewardCents: 50_000,
			requirementDeadline: '2026-10-29',
			expectedPayoutDate: '2027-01-27',
			safeToCloseDate: '2027-01-28',
			requirements: [
				expect.stringContaining('SBOFFER500'),
				expect.stringContaining('Aug 30, 2026'),
				expect.stringContaining('at least 60 days'),
				expect.stringContaining('10 qualifying electronic transactions'),
				expect.stringContaining('Jan 27, 2027')
			]
		});
	});

	it('tracks the BMO balance-only offer and its four tiers', () => {
		const bmoAccount = {
			...account,
			institution: 'BMO (US)',
			nickname: 'BMO Simple Business Checking',
			currentBalanceCents: 2_500_000,
			openedDate: '2026-08-31'
		};
		const offer = getCompatibleBonusOffers(bmoAccount, bmoAccount.openedDate)[0];
		expect(offer).toMatchObject({
			id: 'bmo-business-checking-2026-08-31',
			rewardCents: 150_000,
			transactionTarget: 0,
			qualificationLabel: 'Maintain through'
		});
		expect(getCompatibleBonusOffers(bmoAccount, '2026-09-01')).toEqual([]);

		const draft = buildBonusOfferDraft(offer!, '2026-08-31');
		expect(draft).toMatchObject({
			requirementDeadline: '2026-11-28',
			expectedPayoutDate: '2026-12-12',
			safeToCloseDate: '2026-12-13',
			requirements: [
				expect.stringContaining('offer'),
				expect.stringContaining('Sep 29, 2026'),
				expect.stringContaining('Nov 28, 2026'),
				expect.stringContaining('Dec 12, 2026')
			]
		});

		const bmoBonus: AccountBonus = {
			...bonus,
			accountId: bmoAccount.id,
			offerTemplateId: offer!.id,
			name: offer!.name,
			institution: 'BMO',
			rewardCents: offer!.rewardCents,
			openedDate: '2026-08-31',
			requirementDeadline: draft!.requirementDeadline,
			expectedPayoutDate: draft!.expectedPayoutDate,
			safeToCloseDate: draft!.safeToCloseDate
		};
		expect(buildBonusTracker(bmoBonus, bmoAccount, [transaction()])).toMatchObject({
			currentTier: { thresholdCents: 2_500_000, rewardCents: 75_000 },
			nextTier: { thresholdCents: 5_000_000, rewardCents: 100_000 },
			amountToNextTierCents: 2_500_000,
			likelyQualifyingTransactions: [],
			offer: { tiers: expect.arrayContaining([expect.objectContaining({ rewardCents: 150_000 })]) }
		});
	});

	it('counts earned value only after a posted bonus reward reaches the connected account', () => {
		const capitalOneAccount = {
			...account,
			institution: 'Capital One',
			currentBalanceCents: 501_075
		};
		const capitalOneBonus: AccountBonus = {
			...bonus,
			offerTemplateId: 'capital-one-business-checking-sboffer500-2026',
			institution: 'Capital One',
			rewardCents: 50_000,
			openedDate: '2026-06-01',
			requirementDeadline: '2026-08-29'
		};
		const transactions = Array.from({ length: 10 }, (_, index) =>
			transaction({
				id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
				name: 'External ACH credit',
				merchantName: null,
				date: '2026-08-01'
			})
		);
		const qualifiedTracker = buildBonusTracker(capitalOneBonus, capitalOneAccount, transactions);

		expect(qualifiedTracker).toMatchObject({
			currentTier: { rewardCents: 50_000 },
			likelyQualifyingTransactions: expect.arrayContaining([expect.any(Object)]),
			postedRewardCents: null
		});
		expect(automaticEarnedValueCents(capitalOneBonus, qualifiedTracker)).toBe(0);
		expect(
			automaticEarnedValueCents({ ...capitalOneBonus, status: 'qualified' }, qualifiedTracker)
		).toBe(0);

		const paidTracker = buildBonusTracker(capitalOneBonus, capitalOneAccount, [
			...transactions,
			transaction({
				name: 'SBOFFER500 promotional bonus',
				merchantName: null,
				amountCents: -50_000,
				date: '2026-11-10'
			})
		]);
		expect(paidTracker).toMatchObject({ postedRewardCents: 50_000 });
		expect(automaticEarnedValueCents(capitalOneBonus, paidTracker)).toBe(50_000);

		const unrelatedCreditTracker = buildBonusTracker(capitalOneBonus, capitalOneAccount, [
			...transactions,
			transaction({
				name: 'External ACH credit',
				merchantName: null,
				amountCents: -50_000,
				date: '2026-11-10'
			})
		]);
		expect(automaticEarnedValueCents(capitalOneBonus, unrelatedCreditTracker)).toBe(0);

		expect(automaticEarnedValueCents({ ...capitalOneBonus, status: 'active' }, null)).toBe(0);
		expect(automaticEarnedValueCents({ ...capitalOneBonus, status: 'paid' }, null)).toBe(50_000);
	});
});

describe('conservative posted-activity classifiers', () => {
	it('counts likely Wells Fargo purchases, deposits, and Bill Pay activity', () => {
		const candidates = [
			transaction(),
			transaction({
				name: 'Mobile deposit',
				merchantName: null,
				amountCents: -250_000,
				categoryPrimary: 'TRANSFER_IN',
				categoryDetailed: 'TRANSFER_IN_DEPOSIT'
			}),
			transaction({
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
	});

	it('uses U.S. Bank rules for Zelle, ACH, purchases, and explicit exclusions', () => {
		const candidates = [
			transaction(),
			transaction({ name: 'Zelle credit', merchantName: null, categoryPrimary: 'TRANSFER_IN' }),
			transaction({
				name: 'ACH credit payroll',
				merchantName: null,
				amountCents: -100_000,
				categoryPrimary: 'TRANSFER_IN'
			}),
			transaction({ name: 'Internal transfer from US Bank savings', merchantName: null }),
			transaction({ name: 'Venmo person to person', merchantName: 'Venmo' }),
			transaction({
				name: 'Credit card payment',
				merchantName: null,
				categoryPrimary: 'LOAN_PAYMENTS'
			}),
			transaction({ pending: true }),
			transaction({ date: '2026-10-26' })
		];
		expect(
			candidates.filter((entry) =>
				isLikelyUsBankQualifyingTransaction(entry, '2026-08-27', '2026-10-25')
			)
		).toHaveLength(3);
	});

	it('counts only likely Capital One electronic transfers and deposits', () => {
		const candidates = [
			transaction({ name: 'External ACH credit', merchantName: null }),
			transaction({ name: 'Incoming wire transfer', merchantName: null }),
			transaction({ name: 'Remote check deposit', merchantName: null }),
			transaction({
				name: 'External transfer',
				merchantName: null,
				categoryPrimary: 'TRANSFER_IN',
				categoryDetailed: 'TRANSFER_IN_ACCOUNT_TRANSFER'
			}),
			transaction({ name: 'Capital One internal transfer', merchantName: null }),
			transaction({ name: 'Debit card purchase', merchantName: 'Coffee shop' }),
			transaction({ name: 'Zelle transfer', merchantName: null }),
			transaction({ pending: true }),
			transaction({ date: '2026-11-01' })
		];
		expect(
			candidates.filter((entry) =>
				isLikelyCapitalOneQualifyingTransaction(entry, '2026-08-01', '2026-10-29')
			)
		).toHaveLength(4);
	});
});
