import { describe, expect, it } from 'vitest';
import {
	applyCardRewardProfileSchema,
	bonusChurnSchema,
	createBonusSchema,
	createFinancialAccountSchema,
	createManualCardSchema,
	exchangeTokenSchema,
	isoDateSchema,
	updateBonusSchema,
	updateCardRewardsSchema,
	updateFinancialAccountSchema,
	updateManualCardSchema
} from './schemas';

describe('card request validation', () => {
	it('accepts bounded Plaid account selection metadata', () => {
		expect(
			exchangeTokenSchema.safeParse({
				publicToken: 'public-token',
				institutionName: 'Chase',
				institutionId: 'ins_56',
				accounts: [
					{
						name: 'Self-Directed',
						mask: '3352',
						type: 'investment',
						subtype: 'brokerage'
					}
				]
			}).success
		).toBe(true);
		expect(
			exchangeTokenSchema.safeParse({
				publicToken: 'public-token',
				institutionId: '../invalid',
				accounts: []
			}).success
		).toBe(false);
	});

	it('rejects impossible calendar dates', () => {
		expect(isoDateSchema.safeParse('2027-02-29').success).toBe(false);
		expect(isoDateSchema.safeParse('2028-02-29').success).toBe(true);
	});

	it('accepts only the last four characters rather than a full card number', () => {
		const tooManyDigits = Array.from({ length: 4 }, () => '4111').join('');
		expect(createManualCardSchema.safeParse({ nickname: 'Card', last4: '1234' }).success).toBe(
			true
		);
		expect(
			createManualCardSchema.safeParse({ nickname: 'Card', last4: tooManyDigits }).success
		).toBe(false);
	});

	it('requires at least one field for updates', () => {
		expect(updateManualCardSchema.safeParse({}).success).toBe(false);
	});

	it('accepts flexible reward categories and rejects invalid reward values', () => {
		expect(
			updateCardRewardsSchema.safeParse({
				rewardProgramName: 'Ultimate Rewards',
				rewardValueCents: 12_345,
				rewardType: 'points',
				rewardBaseRate: 1,
				rewardCategories: [
					{ name: 'Dining', multiplier: 3, matchCategory: 'dining' },
					{ name: 'Groceries', multiplier: 5, matchCategory: 'groceries' }
				]
			}).success
		).toBe(true);
		expect(updateCardRewardsSchema.safeParse({ rewardValueCents: -1 }).success).toBe(false);
		expect(
			updateCardRewardsSchema.safeParse({ rewardCategories: [{ name: '', multiplier: 3 }] }).success
		).toBe(false);
		expect(updateCardRewardsSchema.safeParse({}).success).toBe(false);
	});

	it('accepts only a bounded reward profile identifier', () => {
		expect(
			applyCardRewardProfileSchema.safeParse({ profileId: 'chase-sapphire-preferred' }).success
		).toBe(true);
		expect(applyCardRewardProfileSchema.safeParse({ profileId: '' }).success).toBe(false);
		expect(applyCardRewardProfileSchema.safeParse({ profileId: '../private' }).success).toBe(false);
		expect(
			applyCardRewardProfileSchema.safeParse({
				profileId: 'chase-sapphire-preferred',
				unexpected: true
			}).success
		).toBe(false);
	});
});

describe('repeat bonus tracking validation', () => {
	const waitingPeriod = { anchor: 'paidDate', months: 24, days: 1 };

	it('defaults new bonuses to no tracking and preserves omission on updates', () => {
		expect(createBonusSchema.parse({ name: 'Bonus' }).churn).toBeNull();
		expect(updateBonusSchema.parse({ status: 'paid' })).not.toHaveProperty('churn');
		expect(updateBonusSchema.parse({ churn: null })).toEqual({ churn: null });
	});

	it('accepts multiple waiting periods without requiring their dates yet', () => {
		const churn = bonusChurnSchema.parse({
			mode: 'rules',
			conditions: [
				waitingPeriod,
				{ anchor: 'closedDate', months: 0, days: 30 },
				{ anchor: 'openedDate', months: 1_200, days: 36_500 }
			],
			requiresClosed: true
		});
		expect(churn).toMatchObject({
			mode: 'rules',
			conditions: [
				waitingPeriod,
				{ anchor: 'closedDate', months: 0, days: 30 },
				expect.any(Object)
			],
			requiresClosed: true,
			openedDate: null,
			closedDate: null,
			manualEligibleDate: null
		});
		expect(createBonusSchema.safeParse({ name: 'Bonus', churn }).success).toBe(true);
		expect(updateBonusSchema.safeParse({ churn }).success).toBe(true);
	});

	it.each([
		[],
		[{ anchor: 'paidDate', months: 0, days: 0 }],
		[{ anchor: 'paidDate', months: -1, days: 1 }],
		[{ anchor: 'paidDate', months: 1.5, days: 0 }],
		[{ anchor: 'paidDate', months: 1_201, days: 0 }],
		[{ anchor: 'paidDate', months: 1, days: -1 }],
		[{ anchor: 'paidDate', months: 1, days: 0.5 }],
		[{ anchor: 'paidDate', months: 0, days: 36_501 }],
		[{ anchor: 'expectedPayoutDate', months: 24, days: 0 }],
		[waitingPeriod, { anchor: 'paidDate', months: 12, days: 0 }],
		[waitingPeriod, waitingPeriod, waitingPeriod, waitingPeriod],
		[{ ...waitingPeriod, unexpected: true }]
	])('rejects invalid or duplicate waiting periods: %j', (...conditions) => {
		expect(bonusChurnSchema.safeParse({ mode: 'rules', conditions }).success).toBe(false);
	});

	it('allows manual dates to remain unknown and restriction notes to be saved', () => {
		expect(bonusChurnSchema.parse({ mode: 'manual' })).toMatchObject({
			mode: 'manual',
			conditions: [],
			manualEligibleDate: null
		});
		expect(
			bonusChurnSchema.parse({
				mode: 'restricted',
				notes: 'Check the current offer terms before applying.'
			})
		).toMatchObject({ mode: 'restricted', conditions: [] });
		expect(
			bonusChurnSchema.safeParse({ mode: 'manual', manualEligibleDate: '2027-02-29' }).success
		).toBe(false);
		expect(bonusChurnSchema.safeParse({ mode: 'manual', closedDate: '2026-04-31' }).success).toBe(
			false
		);
		expect(bonusChurnSchema.safeParse({ mode: 'manual', openedDate: '2026-04-31' }).success).toBe(
			false
		);
	});

	it.each(['https://bank.example/offer?campaign=repeat', 'http://bank.example/terms'])(
		'accepts an offer source URL: %s',
		(sourceUrl) => {
			expect(bonusChurnSchema.parse({ mode: 'manual', sourceUrl }).sourceUrl).toBe(sourceUrl);
		}
	);

	it.each([
		'javascript:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'file:///private/terms',
		'//bank.example/terms',
		new URL('/terms', `https://${['user:password', 'bank.example'].join('@')}`).toString(),
		'https://bank.example/unsafe path',
		'https://',
		`https://bank.example/${'a'.repeat(2_048)}`
	])('rejects unsafe or unbounded offer source URLs: %s', (sourceUrl) => {
		expect(bonusChurnSchema.safeParse({ mode: 'manual', sourceUrl }).success).toBe(false);
	});

	it('bounds text and rejects unknown tracking properties', () => {
		for (const extra of [
			{ presetId: '' },
			{ presetId: 'a'.repeat(101) },
			{ notes: 'a'.repeat(2_001) },
			{ requiresClosed: 'yes' },
			{ unknown: true }
		]) {
			expect(bonusChurnSchema.safeParse({ mode: 'manual', ...extra }).success).toBe(false);
		}
	});
});

describe('financial workspace validation', () => {
	it('keeps the confirmed fee-free downgrade deadline independent from the bonus hold date', () => {
		const dates = {
			safeToCloseDate: '2028-02-29',
			feeFreeDowngradeDate: '2028-03-15'
		};
		expect(createBonusSchema.parse({ name: 'Card upgrade bonus', ...dates })).toMatchObject(dates);
		expect(createBonusSchema.parse({ name: 'Bonus' }).feeFreeDowngradeDate).toBeNull();
		expect(updateBonusSchema.parse({ status: 'paid' })).not.toHaveProperty('feeFreeDowngradeDate');
		expect(updateBonusSchema.parse({ feeFreeDowngradeDate: null })).toEqual({
			feeFreeDowngradeDate: null
		});
		expect(updateBonusSchema.parse({ feeFreeDowngradeDate: dates.feeFreeDowngradeDate })).toEqual({
			feeFreeDowngradeDate: dates.feeFreeDowngradeDate
		});
	});

	it.each(['2027-02-29', '2028-04-31', '2028-3-15', '2028-03-15T00:00:00Z', ''])(
		'rejects an invalid fee-free downgrade date: %s',
		(feeFreeDowngradeDate) => {
			expect(createBonusSchema.safeParse({ name: 'Bonus', feeFreeDowngradeDate }).success).toBe(
				false
			);
			expect(updateBonusSchema.safeParse({ feeFreeDowngradeDate }).success).toBe(false);
		}
	);

	it('accepts bank and brokerage accounts without full account numbers', () => {
		expect(
			createFinancialAccountSchema.safeParse({
				nickname: 'Business checking',
				accountType: 'checking',
				ownerType: 'business',
				apyBasisPoints: 425,
				last4: '1234'
			}).success
		).toBe(true);
		expect(
			createFinancialAccountSchema.safeParse({
				nickname: 'Brokerage',
				accountType: 'brokerage',
				netContributionsCents: 250_000,
				last4: '12345678'
			}).success
		).toBe(false);
		expect(updateFinancialAccountSchema.safeParse({ apyBasisPoints: 425 }).success).toBe(true);
		expect(updateFinancialAccountSchema.safeParse({ apyBasisPoints: -1 }).success).toBe(false);
		expect(updateFinancialAccountSchema.safeParse({ apyBasisPoints: 425.5 }).success).toBe(false);
	});

	it('validates bonus milestones and bounded requirements', () => {
		const cardId = '6ac7c447-c302-4b28-a38a-98626af9aace';
		expect(
			createBonusSchema.safeParse({
				name: 'New account bonus',
				cardId,
				rewardCents: 50_000,
				spendTargetCents: 100_000,
				requirementDeadline: '2028-04-30',
				requirements: [
					{ label: 'Fund the account' },
					{ label: 'Complete qualifying deposits', completed: true }
				]
			}).success
		).toBe(true);
		expect(createBonusSchema.parse({ name: 'Bonus' }).offerDateOverrideConfirmed).toBe(false);
		expect(createBonusSchema.parse({ name: 'Bonus' }).cardId).toBeNull();
		expect(createBonusSchema.parse({ name: 'Bonus' }).spendTargetCents).toBeNull();
		expect(updateBonusSchema.safeParse({ offerDateOverrideConfirmed: true }).success).toBe(true);
		expect(updateBonusSchema.safeParse({ cardId, spendTargetCents: 100_000 }).success).toBe(true);
		expect(updateBonusSchema.safeParse({ spendTargetCents: -1 }).success).toBe(false);
		expect(createBonusSchema.safeParse({ name: 'Bonus', rewardCents: -1 }).success).toBe(false);
		expect(updateFinancialAccountSchema.safeParse({ hidden: true }).success).toBe(true);
		expect(updateFinancialAccountSchema.safeParse({ netContributionsCents: -50_000 }).success).toBe(
			true
		);
		expect(updateFinancialAccountSchema.safeParse({ hidden: 'yes' }).success).toBe(false);
		expect(updateFinancialAccountSchema.safeParse({}).success).toBe(false);
		expect(updateBonusSchema.safeParse({}).success).toBe(false);
	});
});
