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

	it('recognizes Blue Cash Preferred directly from the Plaid account name', () => {
		expect(
			matchAutomaticCardRewardProfile({
				institutionName: 'American Express',
				accountName: 'Blue Cash Preferred®',
				officialName: null
			})
		).toMatchObject({
			issuer: 'American Express',
			cardName: 'Blue Cash Preferred',
			programName: 'Amex Reward Dollars',
			rewardType: 'cash_back',
			baseRate: 1,
			categories: expect.arrayContaining([
				expect.objectContaining({
					name: 'U.S. supermarkets',
					multiplier: 6,
					matchCategory: 'groceries',
					annualSpendCapCents: 600_000
				}),
				expect.objectContaining({ multiplier: 6, matchCategory: 'streaming' }),
				expect.objectContaining({ multiplier: 3, matchCategory: 'gas' }),
				expect.objectContaining({ multiplier: 3, matchCategory: 'transit' })
			])
		});
	});

	it('distinguishes Blue Cash Everyday from Blue Cash Preferred', () => {
		expect(
			matchAutomaticCardRewardProfile({
				institutionName: 'American Express',
				accountName: 'Blue Cash Everyday®',
				officialName: null
			})
		).toMatchObject({
			cardName: 'Blue Cash Everyday',
			categories: expect.arrayContaining([
				expect.objectContaining({ multiplier: 3, matchCategory: 'online_shopping' })
			])
		});
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
		expect(
			matchAutomaticCardRewardProfile({
				institutionName: 'Venmo - Personal',
				accountName: 'Credit Card ••••8180',
				officialName: null
			})
		).toMatchObject({
			cardName: 'Venmo Credit Card',
			calculation: 'venmo_spend_ranked'
		});
	});

	it.each([
		['ALTITUDE GO VISA SIGNATURE', 'U.S. Bank Altitude Go', 1],
		['U.S. BANK ALTITUDE CONNECT VISA SIGNATURE', 'U.S. Bank Altitude Connect', 1],
		['ALTITUDE RESERVE VISA INFINITE', 'U.S. Bank Altitude Reserve', 1],
		['CASH+ VISA SIGNATURE', 'U.S. Bank Cash+', 1],
		['SHOPPER CASH REWARDS VISA SIGNATURE', 'U.S. Bank Shopper Cash Rewards', 1.5],
		['BANK SMARTLY VISA SIGNATURE', 'U.S. Bank Smartly', 2],
		['SHIELD VISA', 'U.S. Bank Shield', null]
	])(
		'recognizes U.S. Bank product %s from Plaid official_name',
		(officialName, cardName, baseRate) => {
			expect(
				matchAutomaticCardRewardProfile({
					institutionName: 'U.S. Bank',
					accountName: 'Credit Card - 2984',
					officialName
				})
			).toMatchObject({ issuer: 'U.S. Bank', cardName, baseRate });
		}
	);

	it('does not invent a U.S. Bank product when Plaid returns only a generic card name', () => {
		expect(
			matchAutomaticCardRewardProfile({
				institutionName: 'U.S. Bank',
				accountName: 'Credit Card - 2984',
				officialName: null
			})
		).toBeNull();
	});

	it('requires U.S. Bank for its product names', () => {
		expect(
			matchAutomaticCardRewardProfile({
				institutionName: 'Example Bank',
				accountName: 'Altitude Go',
				officialName: null
			})
		).toBeNull();
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
