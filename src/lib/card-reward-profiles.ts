import type { CardRewardCategoryMatch, CardRewardType } from '$lib/types';

export type CardRewardCalculation = 'static' | 'venmo_spend_ranked';

export interface AutomaticCardRewardProfile {
	id: string;
	issuer: 'American Express' | 'Chase' | 'U.S. Bank' | 'Venmo';
	cardName: string;
	programName: string;
	rewardType: CardRewardType | null;
	baseRate: number | null;
	calculation: CardRewardCalculation;
	categories: Array<{
		name: string;
		multiplier: number;
		matchCategory: CardRewardCategoryMatch | null;
		annualSpendCapCents?: number;
	}>;
}

interface CardRewardIdentity {
	institutionName: string | null;
	accountName: string;
	officialName: string | null;
}

interface ProfileMatcher {
	profile: AutomaticCardRewardProfile;
	product: RegExp;
	institution?: RegExp;
}

const US_BANK_INSTITUTION = /\bu\.?\s*s\.?\s*bank\b/i;

// Categories that require a bank portal, selected merchant, or relationship tier are shown
// for completeness but deliberately have no Plaid category match. Transaction estimates then
// stay at the dependable base rate instead of promising a bonus ChipDue cannot verify.
const PROFILE_MATCHERS: ProfileMatcher[] = [
	{
		product: /\bsapphire\s+preferred\b/i,
		institution: /\b(chase|jpmorgan)\b/i,
		profile: {
			id: 'chase-sapphire-preferred',
			issuer: 'Chase',
			cardName: 'Chase Sapphire Preferred',
			programName: 'Chase Ultimate Rewards',
			rewardType: 'points',
			baseRate: 1,
			calculation: 'static',
			categories: [
				{ name: 'Chase Travel', multiplier: 5, matchCategory: null },
				{ name: 'Dining', multiplier: 3, matchCategory: 'dining' },
				{ name: 'Gas & EV charging', multiplier: 3, matchCategory: 'gas' },
				{ name: 'Select streaming', multiplier: 3, matchCategory: 'streaming' },
				{ name: 'Online grocery', multiplier: 3, matchCategory: null },
				{ name: 'Other travel', multiplier: 2, matchCategory: 'travel' }
			]
		}
	},
	{
		product: /\bsapphire\s+reserve\b/i,
		institution: /\b(chase|jpmorgan)\b/i,
		profile: {
			id: 'chase-sapphire-reserve',
			issuer: 'Chase',
			cardName: 'Chase Sapphire Reserve',
			programName: 'Chase Ultimate Rewards',
			rewardType: 'points',
			baseRate: 1,
			calculation: 'static',
			categories: [
				{ name: 'Chase Travel', multiplier: 8, matchCategory: null },
				{ name: 'Flights & hotels', multiplier: 4, matchCategory: 'flights_hotels' },
				{ name: 'Dining', multiplier: 3, matchCategory: 'dining' }
			]
		}
	},
	{
		product: /\bfreedom\s+unlimited\b/i,
		institution: /\b(chase|jpmorgan)\b/i,
		profile: {
			id: 'chase-freedom-unlimited',
			issuer: 'Chase',
			cardName: 'Chase Freedom Unlimited',
			programName: 'Chase Ultimate Rewards',
			rewardType: 'points',
			baseRate: 1.5,
			calculation: 'static',
			categories: [
				{ name: 'Chase Travel', multiplier: 5, matchCategory: null },
				{ name: 'Dining', multiplier: 3, matchCategory: 'dining' },
				{ name: 'Drugstores', multiplier: 3, matchCategory: 'drugstores' }
			]
		}
	},
	{
		product: /\bfreedom\s+flex\b/i,
		institution: /\b(chase|jpmorgan)\b/i,
		profile: {
			id: 'chase-freedom-flex',
			issuer: 'Chase',
			cardName: 'Chase Freedom Flex',
			programName: 'Chase Ultimate Rewards',
			rewardType: 'points',
			baseRate: 1,
			calculation: 'static',
			categories: [
				{ name: 'Activated quarterly categories', multiplier: 5, matchCategory: null },
				{ name: 'Chase Travel', multiplier: 5, matchCategory: null },
				{ name: 'Dining', multiplier: 3, matchCategory: 'dining' },
				{ name: 'Drugstores', multiplier: 3, matchCategory: 'drugstores' }
			]
		}
	},
	{
		product: /\bfreedom\s+rise\b/i,
		institution: /\b(chase|jpmorgan)\b/i,
		profile: {
			id: 'chase-freedom-rise',
			issuer: 'Chase',
			cardName: 'Chase Freedom Rise',
			programName: 'Chase Ultimate Rewards',
			rewardType: 'points',
			baseRate: 1.5,
			calculation: 'static',
			categories: []
		}
	},
	{
		product: /\b(amazon\s+prime\s+visa|prime\s+visa)\b/i,
		institution: /\b(chase|jpmorgan)\b/i,
		profile: {
			id: 'chase-prime-visa',
			issuer: 'Chase',
			cardName: 'Prime Visa',
			programName: 'Amazon Rewards',
			rewardType: 'points',
			baseRate: 1,
			calculation: 'static',
			categories: [
				{ name: 'Amazon, Whole Foods & Chase Travel', multiplier: 5, matchCategory: null },
				{ name: 'Dining', multiplier: 2, matchCategory: 'dining' },
				{ name: 'Gas', multiplier: 2, matchCategory: 'gas' },
				{ name: 'Transit', multiplier: 2, matchCategory: 'transit' }
			]
		}
	},
	{
		product: /\bblue\s+cash\s+preferred\b/i,
		profile: {
			id: 'amex-blue-cash-preferred',
			issuer: 'American Express',
			cardName: 'Blue Cash Preferred',
			programName: 'Amex Reward Dollars',
			rewardType: 'cash_back',
			baseRate: 1,
			calculation: 'static',
			categories: [
				{
					name: 'U.S. supermarkets',
					multiplier: 6,
					matchCategory: 'groceries',
					annualSpendCapCents: 600_000
				},
				{ name: 'Select U.S. streaming', multiplier: 6, matchCategory: 'streaming' },
				{ name: 'U.S. gas stations', multiplier: 3, matchCategory: 'gas' },
				{ name: 'Transit', multiplier: 3, matchCategory: 'transit' }
			]
		}
	},
	{
		product: /\bblue\s+cash\s+everyday\b/i,
		profile: {
			id: 'amex-blue-cash-everyday',
			issuer: 'American Express',
			cardName: 'Blue Cash Everyday',
			programName: 'Amex Reward Dollars',
			rewardType: 'cash_back',
			baseRate: 1,
			calculation: 'static',
			categories: [
				{
					name: 'U.S. supermarkets',
					multiplier: 3,
					matchCategory: 'groceries',
					annualSpendCapCents: 600_000
				},
				{
					name: 'U.S. gas stations',
					multiplier: 3,
					matchCategory: 'gas',
					annualSpendCapCents: 600_000
				},
				{
					name: 'U.S. online retail',
					multiplier: 3,
					matchCategory: 'online_shopping',
					annualSpendCapCents: 600_000
				}
			]
		}
	},
	{
		product: /\baltitude\s+go\b/i,
		institution: US_BANK_INSTITUTION,
		profile: {
			id: 'us-bank-altitude-go',
			issuer: 'U.S. Bank',
			cardName: 'U.S. Bank Altitude Go',
			programName: 'U.S. Bank Altitude Rewards',
			rewardType: 'points',
			baseRate: 1,
			calculation: 'static',
			categories: [
				{ name: 'Dining · first $2,000/quarter', multiplier: 4, matchCategory: 'dining' },
				{ name: 'Groceries', multiplier: 2, matchCategory: 'groceries' },
				{ name: 'Gas & EV charging', multiplier: 2, matchCategory: 'gas' },
				{ name: 'Streaming', multiplier: 2, matchCategory: 'streaming' }
			]
		}
	},
	{
		product: /\baltitude\s+connect\b/i,
		institution: US_BANK_INSTITUTION,
		profile: {
			id: 'us-bank-altitude-connect',
			issuer: 'U.S. Bank',
			cardName: 'U.S. Bank Altitude Connect',
			programName: 'U.S. Bank Altitude Rewards',
			rewardType: 'points',
			baseRate: 1,
			calculation: 'static',
			categories: [
				{ name: 'Travel Center hotels & cars', multiplier: 5, matchCategory: null },
				{ name: 'Travel', multiplier: 4, matchCategory: 'travel' },
				{ name: 'Transit', multiplier: 4, matchCategory: 'transit' },
				{
					name: 'Gas & EV charging · first $1,000/quarter',
					multiplier: 4,
					matchCategory: 'gas'
				},
				{ name: 'Dining', multiplier: 2, matchCategory: 'dining' },
				{ name: 'Groceries', multiplier: 2, matchCategory: 'groceries' },
				{ name: 'Streaming', multiplier: 2, matchCategory: 'streaming' }
			]
		}
	},
	{
		product: /\baltitude\s+reserve\b/i,
		institution: US_BANK_INSTITUTION,
		profile: {
			id: 'us-bank-altitude-reserve',
			issuer: 'U.S. Bank',
			cardName: 'U.S. Bank Altitude Reserve',
			programName: 'U.S. Bank Altitude Rewards',
			rewardType: 'points',
			baseRate: 1,
			calculation: 'static',
			categories: [
				{ name: 'Travel Center hotels & cars', multiplier: 10, matchCategory: null },
				{ name: 'Travel Center flights', multiplier: 5, matchCategory: null },
				{
					name: 'Mobile wallet · first $5,000/billing cycle',
					multiplier: 3,
					matchCategory: null
				},
				{ name: 'Travel', multiplier: 3, matchCategory: 'travel' },
				{ name: 'Transit', multiplier: 3, matchCategory: 'transit' }
			]
		}
	},
	{
		product: /\bcash\s*(?:\+|plus\b)/i,
		institution: US_BANK_INSTITUTION,
		profile: {
			id: 'us-bank-cash-plus',
			issuer: 'U.S. Bank',
			cardName: 'U.S. Bank Cash+',
			programName: 'U.S. Bank Cash Rewards',
			rewardType: 'cash_back',
			baseRate: 1,
			calculation: 'static',
			categories: [
				{
					name: 'Two selected categories · first $2,000/quarter',
					multiplier: 5,
					matchCategory: null
				},
				{ name: 'Travel Center prepaid travel', multiplier: 5, matchCategory: null },
				{ name: 'Selected everyday category', multiplier: 2, matchCategory: null }
			]
		}
	},
	{
		product: /\bshopper\s+cash(?:\s+rewards?)?\b/i,
		institution: US_BANK_INSTITUTION,
		profile: {
			id: 'us-bank-shopper-cash-rewards',
			issuer: 'U.S. Bank',
			cardName: 'U.S. Bank Shopper Cash Rewards',
			programName: 'U.S. Bank Cash Rewards',
			rewardType: 'cash_back',
			baseRate: 1.5,
			calculation: 'static',
			categories: [
				{
					name: 'Two selected retailers · first $1,500/quarter',
					multiplier: 6,
					matchCategory: null
				},
				{ name: 'Travel Center hotels & cars', multiplier: 5.5, matchCategory: null },
				{
					name: 'Selected everyday category · first $1,500/quarter',
					multiplier: 3,
					matchCategory: null
				}
			]
		}
	},
	{
		product: /\b(?:bank\s+)?smartly\b/i,
		institution: US_BANK_INSTITUTION,
		profile: {
			id: 'us-bank-smartly',
			issuer: 'U.S. Bank',
			cardName: 'U.S. Bank Smartly',
			programName: 'U.S. Bank Smartly Rewards',
			rewardType: 'cash_back',
			baseRate: 2,
			calculation: 'static',
			categories: [
				{
					name: 'Qualifying relationship tier · up to',
					multiplier: 4,
					matchCategory: null
				}
			]
		}
	},
	{
		product: /\bshield\b/i,
		institution: US_BANK_INSTITUTION,
		profile: {
			id: 'us-bank-shield',
			issuer: 'U.S. Bank',
			cardName: 'U.S. Bank Shield',
			programName: 'U.S. Bank Cash Rewards',
			rewardType: 'cash_back',
			baseRate: null,
			calculation: 'static',
			categories: [{ name: 'Travel Center prepaid travel', multiplier: 4, matchCategory: null }]
		}
	},
	{
		product: /\bvenmo\b.*\b(credit|visa|card)\b|\b(credit|visa)\b.*\bvenmo\b/i,
		profile: {
			id: 'venmo-credit-card',
			issuer: 'Venmo',
			cardName: 'Venmo Credit Card',
			programName: 'Venmo Cash Back',
			rewardType: 'cash_back',
			baseRate: 1,
			calculation: 'venmo_spend_ranked',
			categories: [
				{ name: 'Top eligible category', multiplier: 3, matchCategory: null },
				{ name: 'Second eligible category', multiplier: 2, matchCategory: null }
			]
		}
	}
];

export const AUTOMATIC_CARD_REWARD_PROFILES = PROFILE_MATCHERS.map(({ profile }) => profile);

export function automaticCardRewardProfileById(
	profileId: string
): AutomaticCardRewardProfile | null {
	return AUTOMATIC_CARD_REWARD_PROFILES.find((profile) => profile.id === profileId) ?? null;
}

function normalizedIdentity(identity: CardRewardIdentity): {
	product: string;
	institution: string;
} {
	return {
		product: [identity.officialName, identity.accountName].filter(Boolean).join(' '),
		institution: identity.institutionName ?? ''
	};
}

export function matchAutomaticCardRewardProfile(
	identity: CardRewardIdentity
): AutomaticCardRewardProfile | null {
	const { product, institution } = normalizedIdentity(identity);
	if (
		/\bvenmo\b/i.test(institution) &&
		/^\s*(?:credit\s+card|visa|mastercard|card)(?:\s*(?:[-–—•·*]+\s*)*\d{4})?\s*$/i.test(product)
	) {
		return automaticCardRewardProfileById('venmo-credit-card');
	}
	const match = PROFILE_MATCHERS.find(
		(candidate) =>
			candidate.product.test(product) &&
			(!candidate.institution || candidate.institution.test(institution))
	);
	return match?.profile ?? null;
}
