import type { CardRewardCategoryMatch, CardRewardType } from '$lib/types';

export type CardRewardCalculation = 'static' | 'venmo_spend_ranked';

export interface AutomaticCardRewardProfile {
	id: string;
	issuer: 'Chase' | 'Venmo';
	cardName: string;
	programName: string;
	rewardType: CardRewardType;
	baseRate: number;
	calculation: CardRewardCalculation;
	categories: Array<{
		name: string;
		multiplier: number;
		matchCategory: CardRewardCategoryMatch | null;
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

// These profiles intentionally contain only earning rules that can be inferred from
// Plaid's transaction categories. Portal-only, merchant-only, capped, and activated
// promotions are omitted so activity estimates do not promise rewards they cannot verify.
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
	if (/\bvenmo\b/i.test(institution) && /^\s*(?:credit\s+card\s*)+$/i.test(product)) {
		return automaticCardRewardProfileById('venmo-credit-card');
	}
	const match = PROFILE_MATCHERS.find(
		(candidate) =>
			candidate.product.test(product) &&
			(!candidate.institution || candidate.institution.test(institution))
	);
	return match?.profile ?? null;
}
