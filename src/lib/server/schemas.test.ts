import { describe, expect, it } from 'vitest';
import {
	applyCardRewardProfileSchema,
	createBonusSchema,
	createFinancialAccountSchema,
	createManualCardSchema,
	isoDateSchema,
	updateBonusSchema,
	updateCardRewardsSchema,
	updateFinancialAccountSchema,
	updateManualCardSchema
} from './schemas';

describe('card request validation', () => {
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

describe('financial workspace validation', () => {
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
		expect(
			createBonusSchema.safeParse({
				name: 'New account bonus',
				rewardCents: 50_000,
				requirementDeadline: '2028-04-30',
				requirements: [
					{ label: 'Fund the account' },
					{ label: 'Complete qualifying deposits', completed: true }
				]
			}).success
		).toBe(true);
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
