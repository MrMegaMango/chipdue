import { describe, expect, it } from 'vitest';
import type {
	AccountBonus,
	BonusChurn,
	Card,
	FinancialAccount,
	FinancialAccountTransaction
} from '$lib/types';
import { BONUS_CHURN_PRESETS } from './bonus-churn';
import { resolveAutomaticBonusChurn, type BonusChurnActivity } from './bonus-churn-automatic';

const account: FinancialAccount = {
	id: 'account-1',
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
	currentBalanceCents: 0,
	apyBasisPoints: null,
	apySource: null,
	apyUpdatedAt: null,
	costBasisCents: null,
	netContributionsCents: null,
	balanceHistory: [],
	holdings: [],
	transactionHistoryEnabled: true,
	transactionHistoryStatus: 'historical_complete',
	openedDate: '2024-01-01',
	notes: null,
	connectionId: 'connection-1',
	connectionProvider: 'plaid',
	lastSyncedAt: '2026-09-13T12:00:00Z',
	createdAt: '2024-01-01T12:00:00Z',
	updatedAt: '2026-09-13T12:00:00Z'
};
const card: Card = {
	id: 'card-1',
	source: 'connected',
	nickname: 'Cash card',
	providerProductName: 'Cash card',
	issuer: 'Amex',
	issuerLogoUrl: null,
	last4: '5678',
	currency: 'USD',
	statementBalanceCents: null,
	minimumPaymentCents: null,
	currentBalanceCents: null,
	dueDate: null,
	statementDate: null,
	isOverdue: null,
	autopayEnabled: false,
	rewardProgramName: null,
	rewardValueCents: null,
	rewardType: 'cash_back',
	rewardBaseRate: null,
	rewardCategories: [],
	rewardSource: null,
	rewardProfileName: null,
	rewardCalculation: null,
	transactionHistoryEnabled: true,
	transactionHistoryStatus: 'historical_complete',
	connectionId: 'connection-2',
	connectionProvider: 'plaid',
	createdAt: '2024-01-01T12:00:00Z',
	updatedAt: '2026-09-13T12:00:00Z',
	lastSyncedAt: '2026-09-13T12:00:00Z'
};
const bonus: AccountBonus = {
	id: 'bonus-1',
	accountId: account.id,
	cardId: null,
	offerTemplateId: 'wells-fargo-business-checking-2026-09-08',
	offerDateOverrideConfirmed: false,
	name: 'Wells Fargo business checking bonus',
	institution: 'Wells Fargo',
	rewardCents: 82_500,
	spendTargetCents: null,
	currency: 'USD',
	status: 'active',
	openedDate: '2024-01-01',
	requirementDeadline: null,
	expectedPayoutDate: null,
	paidDate: null,
	safeToCloseDate: null,
	feeFreeDowngradeDate: null,
	feeFreeDowngradeDateSource: 'issuer_confirmed',
	requirements: [],
	notes: null,
	createdAt: '2024-01-01T12:00:00Z',
	updatedAt: '2026-09-13T12:00:00Z'
};
function credit(changes: Partial<FinancialAccountTransaction> = {}): FinancialAccountTransaction {
	return {
		id: 'tx-1',
		name: 'BUSINESS CHECKING BONUS',
		merchantName: null,
		amountCents: -55_000,
		currency: 'USD',
		date: '2024-04-15',
		authorizedDate: null,
		pending: false,
		categoryPrimary: 'INCOME',
		categoryDetailed: 'INCOME_OTHER_INCOME',
		...changes
	};
}
function activity(changes: Partial<BonusChurnActivity> = {}): BonusChurnActivity {
	return {
		account,
		card: null,
		transactions: [credit()],
		activityState: 'available',
		lastSyncedAt: account.lastSyncedAt,
		...changes
	};
}
function rule(changes: Partial<BonusChurn> = {}): BonusChurn {
	return {
		mode: 'rules',
		conditions: [{ anchor: 'paidDate', months: 24, days: 0 }],
		requiresClosed: false,
		openedDate: null,
		closedDate: null,
		manualEligibleDate: null,
		presetId: null,
		sourceUrl: null,
		notes: null,
		...changes
	};
}
const today = '2026-09-13';

describe('automatic bonus churn resolution', () => {
	it('starts tracking a saved offer and actual matching payout without churn setup', () => {
		const result = resolveAutomaticBonusChurn(bonus, activity(), today);
		expect(result).toMatchObject({
			ruleSource: 'automatic',
			paidDate: '2024-04-15',
			closedDate: null,
			dateSources: { paidDate: 'transaction', openedDate: 'saved', closedDate: null },
			statusLabel: 'Waiting for account closure',
			tracker: { status: 'needs_info', reviewDate: null }
		});
		expect(result.effectiveRule?.conditions).toEqual([
			{ anchor: 'paidDate', months: 24, days: 0 },
			{ anchor: 'closedDate', months: 0, days: 90 }
		]);
		expect(result.sourceUrl).toContain('wellsfargo.com');
		expect(result.checkedAt).toBe(account.lastSyncedAt);
		expect(result.ruleVerifiedAt).toBe('2026-09-13');
		expect(result.payoutTransactionId).toBe('tx-1');
		expect(result.tracker.missing.join(' ')).not.toContain('Record');
	});

	it.each([
		'us-bank-business-essentials-q3-2026',
		'us-bank-platinum-business-checking-q3-2026',
		'capital-one-business-checking-sboffer500-2026',
		'bmo-business-checking-2026-08-31'
	])(
		'automatically marks %s for offer review rather than guaranteeing disqualification',
		(offerTemplateId) => {
			const result = resolveAutomaticBonusChurn({ ...bonus, offerTemplateId }, activity(), today);
			expect(result).toMatchObject({
				ruleSource: 'automatic',
				statusLabel: 'Offer review required',
				tracker: { status: 'restricted', reviewDate: null },
				projectionDate: null
			});
		}
	);

	it('preserves a saved preset, auto-detects payment, and starts its complete cooldown', () => {
		const preset = BONUS_CHURN_PRESETS.find((item) => item.id.startsWith('wells-fargo'))!;
		const saved = { ...bonus, churn: { ...preset.churn, closedDate: '2026-08-01' } };
		const original = JSON.stringify(saved);
		const result = resolveAutomaticBonusChurn(saved, activity(), today);
		expect(result).toMatchObject({
			ruleSource: 'saved',
			paidDate: '2024-04-15',
			closedDate: '2026-08-01',
			tracker: { status: 'waiting', reviewDate: '2026-10-30', daysRemaining: 47 }
		});
		expect(JSON.stringify(saved)).toBe(original);
		expect(preset.churn.closedDate).toBeNull();
	});

	it('gives saved dates and custom rules precedence over inferred dates and defaults', () => {
		const result = resolveAutomaticBonusChurn(
			{
				...bonus,
				paidDate: '2026-08-01',
				churn: rule({
					openedDate: '2023-02-02',
					closedDate: '2026-09-01',
					conditions: [{ anchor: 'paidDate', months: 12, days: 0 }]
				})
			},
			activity(),
			today
		);
		expect(result).toMatchObject({
			ruleSource: 'saved',
			paidDate: '2026-08-01',
			openedDate: '2023-02-02',
			closedDate: '2026-09-01',
			dateSources: { paidDate: 'saved', openedDate: 'saved', closedDate: 'saved' },
			tracker: { reviewDate: '2027-08-01' }
		});
	});

	it.each([
		{ pending: true },
		{ amountCents: 55_000 },
		{ amountCents: -55_001 },
		{ currency: 'CAD' },
		{ name: 'BONUS REFUND' },
		{ name: 'PROMO REVERSAL' },
		{ name: 'BONUS REWARDS REDEMPTION' },
		{ name: 'CREDIT CARD PAYMENT BONUS' },
		{ name: 'AUTOPAY BONUS' },
		{ name: 'Payroll annual bonus' },
		{ name: 'Annual bonus', categoryDetailed: 'INCOME_WAGES' },
		{ name: 'Cash rewards credit' },
		{ name: 'Deposit', merchantName: 'Bonus Coffee' },
		{ date: '2023-12-31' },
		{ date: '2026-09-14' },
		{ date: '2024-02-30' },
		{
			name: 'Business bonus',
			investmentDetails: {
				type: 'sell',
				subtype: 'sell',
				securityName: 'Bonus Fund',
				tickerSymbol: 'BONS',
				quantity: 1,
				priceMicros: 55_000,
				feesCents: 0
			}
		}
	])('rejects unrelated or unconfirmed credit %j', (changes) => {
		const result = resolveAutomaticBonusChurn(
			bonus,
			activity({ transactions: [credit(changes)] }),
			today
		);
		expect(result.paidDate).toBeNull();
		expect(result.dateSources.paidDate).toBeNull();
		expect(result.tracker.reviewDate).toBeNull();
	});

	it('accepts an explicit bonus payment and exact promo code, but not a partial code', () => {
		expect(
			resolveAutomaticBonusChurn(
				bonus,
				activity({ transactions: [credit({ name: 'BONUS PAYMENT' })] }),
				today
			).paidDate
		).toBe('2024-04-15');
		const usBank = {
			...bonus,
			offerTemplateId: 'us-bank-business-essentials-q3-2026',
			rewardCents: 40_000
		};
		for (const [name, expected] of [
			['Q3DIG26 CREDIT', '2024-04-15'],
			['Q3DIG260 CREDIT', null]
		] as const) {
			expect(
				resolveAutomaticBonusChurn(
					usBank,
					activity({ transactions: [credit({ name, amountCents: -40_000 })] }),
					today
				).paidDate
			).toBe(expected);
		}
	});

	it('deduplicates the same credit id and refuses distinct matching credits', () => {
		expect(
			resolveAutomaticBonusChurn(bonus, activity({ transactions: [credit(), credit()] }), today)
				.paidDate
		).toBe('2024-04-15');
		const result = resolveAutomaticBonusChurn(
			bonus,
			activity({ transactions: [credit(), credit({ id: 'tx-2' })] }),
			today
		);
		expect(result).toMatchObject({ paidDate: null, statusLabel: 'Payout review required' });
		expect(result.detail).toContain('Multiple distinct');
	});

	it('invalidates a matching bonus when a later separate clawback debit appears', () => {
		const result = resolveAutomaticBonusChurn(
			bonus,
			activity({
				transactions: [
					credit(),
					credit({
						id: 'tx-clawback',
						amountCents: 55_000,
						name: 'BONUS CLAWBACK',
						date: '2024-04-16'
					})
				]
			}),
			today
		);
		expect(result).toMatchObject({ paidDate: null, statusLabel: 'Payout review required' });
		expect(result.detail).toContain('clawback');
	});

	it('suppresses cross-bonus credit ambiguity while preserving saved payment corrections', () => {
		const ambiguous = activity({ payoutAmbiguous: true });
		expect(resolveAutomaticBonusChurn(bonus, ambiguous, today)).toMatchObject({
			paidDate: null,
			payoutTransactionId: null,
			statusLabel: 'Payout review required',
			projectionDate: null
		});
		expect(
			resolveAutomaticBonusChurn({ ...bonus, paidDate: '2024-04-15' }, ambiguous, today)
		).toMatchObject({
			paidDate: '2024-04-15',
			dateSources: { paidDate: 'saved' }
		});
	});

	it('uses only activity from the matching linked entity and a known start date', () => {
		for (const supplied of [
			activity({ account: null }),
			activity({ account: { ...account, id: 'other-account' } }),
			activity({ account: { ...account, currency: 'CAD' } }),
			activity({ activityState: 'unavailable' })
		]) {
			expect(resolveAutomaticBonusChurn(bonus, supplied, today).paidDate).toBeNull();
		}
		expect(
			resolveAutomaticBonusChurn(
				{ ...bonus, openedDate: null },
				activity({ account: { ...account, openedDate: null } }),
				today
			).paidDate
		).toBeNull();
	});

	it('takes a linked account opening date when the bonus has none', () => {
		const result = resolveAutomaticBonusChurn(
			{
				...bonus,
				openedDate: null,
				churn: rule({ conditions: [{ anchor: 'openedDate', months: 36, days: 0 }] })
			},
			activity(),
			today
		);
		expect(result).toMatchObject({
			openedDate: '2024-01-01',
			dateSources: { openedDate: 'account' },
			tracker: { reviewDate: '2027-01-01' }
		});
	});

	it('keeps targeted enrollment distinct from actual opening, including for saved overrides', () => {
		const targeted = {
			...bonus,
			offerTemplateId: 'etrade-targeted-existing-brokerage-2026-08-19',
			name: 'Targeted brokerage bonus',
			openedDate: '2026-08-19',
			churn: rule({ conditions: [{ anchor: 'openedDate', months: 36, days: 0 }] })
		};
		expect(resolveAutomaticBonusChurn(targeted, activity(), today)).toMatchObject({
			openedDate: '2024-01-01',
			dateSources: { openedDate: 'account' },
			tracker: { reviewDate: '2027-01-01' },
			paidDate: null
		});
		expect(
			resolveAutomaticBonusChurn(
				targeted,
				activity({ account: { ...account, openedDate: null } }),
				today
			)
		).toMatchObject({ openedDate: null, tracker: { status: 'needs_info', reviewDate: null } });
	});

	it('never substitutes sync, update, closure status, or zero balance for a closure date', () => {
		const result = resolveAutomaticBonusChurn(
			bonus,
			activity({ account: { ...account, status: 'closed', currentBalanceCents: 0 } }),
			today
		);
		expect(result).toMatchObject({
			closedDate: null,
			dateSources: { closedDate: null },
			statusLabel: 'Waiting for account closure',
			tracker: { reviewDate: null }
		});
	});

	it('does not override an invalid saved actual date with a detected date', () => {
		const result = resolveAutomaticBonusChurn(
			{ ...bonus, paidDate: '2027-01-01', churn: rule() },
			activity(),
			today
		);
		expect(result).toMatchObject({
			paidDate: null,
			statusLabel: 'Saved dates need review',
			tracker: { status: 'needs_info' }
		});
		const invalidOpening = resolveAutomaticBonusChurn(
			{
				...bonus,
				churn: rule({
					openedDate: '2024-02-30',
					conditions: [{ anchor: 'openedDate', months: 1, days: 0 }]
				})
			},
			activity(),
			today
		);
		expect(invalidOpening).toMatchObject({
			openedDate: null,
			tracker: { status: 'needs_info', reviewDate: null }
		});
	});

	it('tracks a cash card bonus from explicit posted activity without inventing issuer rules', () => {
		const cardBonus = {
			...bonus,
			accountId: null,
			cardId: card.id,
			offerTemplateId: null,
			name: 'Cash card signup bonus',
			rewardCents: 30_000
		};
		const result = resolveAutomaticBonusChurn(
			cardBonus,
			activity({
				account: null,
				card,
				transactions: [credit({ name: 'WELCOME BONUS', amountCents: -30_000 })]
			}),
			today
		);
		expect(result).toMatchObject({
			paidDate: '2024-04-15',
			dateSources: { paidDate: 'transaction' },
			ruleSource: 'unmatched',
			statusLabel: 'Offer-specific terms',
			tracker: { reviewDate: null }
		});
	});

	it.each([
		['Amex Blue Cash Preferred targeted upgrade bonus', 'Upgrade bonuses'],
		['Varo referral bonus', 'recipient must never'],
		['Targeted deposit bonus', 'targeted invitation'],
		['Wells Fargo personal checking bonus', 'no confirmed repeat-bonus rule']
	])('describes %s without an institution-only reset', (name, expected) => {
		const result = resolveAutomaticBonusChurn(
			{ ...bonus, offerTemplateId: null, name },
			activity(),
			today
		);
		expect(result).toMatchObject({
			ruleSource: 'unmatched',
			effectiveRule: null,
			statusLabel: 'Offer-specific terms',
			projectionDate: null
		});
		expect(result.detail).toContain(expected);
	});

	it('reports activity failures while keeping automatic matched rules active', () => {
		const result = resolveAutomaticBonusChurn(
			bonus,
			activity({ activityState: 'unavailable' }),
			today
		);
		expect(result).toMatchObject({
			ruleSource: 'automatic',
			paidDate: null,
			statusLabel: 'Activity unavailable',
			checkedAt: null
		});
	});

	it('separates forecast dates from actual status and payment/closure sources', () => {
		const projected = {
			...bonus,
			openedDate: '2026-08-27',
			expectedPayoutDate: '2026-11-24',
			safeToCloseDate: '2026-11-25'
		};
		const result = resolveAutomaticBonusChurn(projected, activity({ transactions: [] }), today);
		expect(result).toMatchObject({
			paidDate: null,
			closedDate: null,
			projectionDate: '2028-11-24',
			tracker: { status: 'needs_info', reviewDate: null },
			statusLabel: 'Watching for bonus payout'
		});
		expect(result.projectionNote).toContain('Estimate only');
		expect(result.projectionNote).toContain('Nov 25, 2026');
	});

	it('never projects unconfirmed closure into the past or becomes ready from old estimates', () => {
		const result = resolveAutomaticBonusChurn(
			{
				...bonus,
				paidDate: '2024-04-15',
				expectedPayoutDate: '2024-04-14',
				safeToCloseDate: '2024-04-16'
			},
			activity(),
			today
		);
		expect(result).toMatchObject({
			projectionDate: '2026-12-12',
			tracker: { status: 'needs_info', reviewDate: null }
		});
		expect(result.projectionNote).toContain('Sep 13, 2026');
	});

	it('skips forecasts when a needed anchor has no defensible saved estimate', () => {
		for (const record of [
			{ ...bonus, safeToCloseDate: '2026-11-25' },
			{ ...bonus, expectedPayoutDate: '2024-04-15', safeToCloseDate: '2024-04-16' }
		]) {
			expect(
				resolveAutomaticBonusChurn(record, activity({ transactions: [] }), today).projectionDate
			).toBeNull();
		}
	});
});
