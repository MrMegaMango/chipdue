import { describe, expect, it } from 'vitest';
import { matchAutomaticCardRewardProfile } from './card-reward-profiles';

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
