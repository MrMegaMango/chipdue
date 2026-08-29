import { describe, expect, it } from 'vitest';
import {
	automaticCardRewardProfileById,
	matchAutomaticCardRewardProfile
} from './card-reward-profiles';

describe('automatic card reward profiles', () => {
	it('matches a Chase card from Plaid official_name even when the account name is generic', () => {
		expect(
			matchAutomaticCardRewardProfile({
				institutionName: 'Chase',
				accountName: 'CREDIT CARD',
				officialName: 'CHASE SAPPHIRE PREFERRED®'
			})
		).toMatchObject({
			cardName: 'Chase Sapphire Preferred',
			programName: 'Chase Ultimate Rewards',
			rewardType: 'points',
			baseRate: 1,
			categories: expect.arrayContaining([
				expect.objectContaining({ name: 'Dining', multiplier: 3, matchCategory: 'dining' })
			])
		});
	});

	it('does not guess a product from a generic institution and account name', () => {
		expect(
			matchAutomaticCardRewardProfile({
				institutionName: 'Chase',
				accountName: 'CREDIT CARD',
				officialName: null
			})
		).toBeNull();
	});

	it('looks up a complete profile from a one-time product selection', () => {
		expect(automaticCardRewardProfileById('chase-freedom-unlimited')).toMatchObject({
			issuer: 'Chase',
			cardName: 'Chase Freedom Unlimited',
			programName: 'Chase Ultimate Rewards',
			baseRate: 1.5
		});
		expect(automaticCardRewardProfileById('unknown-card')).toBeNull();
	});

	it('recognizes the dynamically ranked Venmo rewards program', () => {
		expect(
			matchAutomaticCardRewardProfile({
				institutionName: 'Synchrony Bank',
				accountName: 'Venmo Credit Card',
				officialName: null
			})
		).toMatchObject({
			programName: 'Venmo Cash Back',
			calculation: 'venmo_spend_ranked',
			baseRate: 1
		});
	});

	it('identifies a generic Venmo card from the linked institution', () => {
		expect(
			matchAutomaticCardRewardProfile({
				institutionName: 'Venmo',
				accountName: 'CREDIT CARD',
				officialName: null
			})
		).toMatchObject({
			cardName: 'Venmo Credit Card',
			calculation: 'venmo_spend_ranked'
		});
	});

	it('requires the expected issuer for similarly named Chase products', () => {
		expect(
			matchAutomaticCardRewardProfile({
				institutionName: 'Example Bank',
				accountName: 'Freedom Unlimited',
				officialName: null
			})
		).toBeNull();
	});
});
