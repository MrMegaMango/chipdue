import { describe, expect, it } from 'vitest';
import {
	createBonusSchema,
	createFinancialAccountSchema,
	createManualCardSchema,
	isoDateSchema,
	updateBonusSchema,
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
});

describe('financial workspace validation', () => {
	it('accepts bank and brokerage accounts without full account numbers', () => {
		expect(
			createFinancialAccountSchema.safeParse({
				nickname: 'Business checking',
				accountType: 'checking',
				ownerType: 'business',
				last4: '1234'
			}).success
		).toBe(true);
		expect(
			createFinancialAccountSchema.safeParse({
				nickname: 'Brokerage',
				accountType: 'brokerage',
				last4: '12345678'
			}).success
		).toBe(false);
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
		expect(updateFinancialAccountSchema.safeParse({}).success).toBe(false);
		expect(updateBonusSchema.safeParse({}).success).toBe(false);
	});
});
