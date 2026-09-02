import type { AccountBonus, FinancialAccount, FinancialAccountTransaction } from '$lib/types';

export type BonusTransactionRule =
	'balance-only' | 'capital-one-business' | 'wells-fargo-business' | 'us-bank-business';

export interface BonusOfferTier {
	thresholdCents: number;
	rewardCents: number;
	label: string;
}

export interface BonusOfferTemplate {
	id: string;
	institution: string;
	institutionAliases: string[];
	name: string;
	accountProduct: string;
	versionLabel: string;
	validFrom: string | null;
	validThrough: string | null;
	sourceUrl: string;
	sourceVerifiedAt: string;
	promoCode: string | null;
	rewardCents: number;
	tiers: BonusOfferTier[];
	fundingDay: number;
	qualificationDay: number;
	transactionTarget: number;
	transactionRule: BonusTransactionRule;
	qualificationLabel: string;
	payoutRule:
		| 'qualification-plus-14'
		| 'qualification-plus-30'
		| 'qualification-plus-90'
		| 'qualification-month-end-plus-30';
	requirements(openedDate: string): string[];
	notes: string;
	activityNote: string;
}

export interface BonusOfferDraft {
	name: string;
	institution: string;
	rewardCents: number;
	requirementDeadline: string;
	expectedPayoutDate: string;
	safeToCloseDate: string;
	requirements: string[];
	notes: string;
}

export interface BonusTracker {
	offer: BonusOfferTemplate;
	account: FinancialAccount;
	balanceCents: number | null;
	currentTier: BonusOfferTier | null;
	nextTier: BonusOfferTier | null;
	amountToNextTierCents: number | null;
	fundingDeadline: string | null;
	qualificationDeadline: string | null;
	latestPayoutDate: string | null;
	safeToCloseDate: string | null;
	likelyQualifyingTransactions: FinancialAccountTransaction[];
	postedRewardCents: number | null;
}

export function automaticEarnedValueCents(
	bonus: AccountBonus,
	tracker: BonusTracker | null
): number {
	if (tracker?.account.source === 'connected') return tracker.postedRewardCents ?? 0;
	return bonus.paidDate || bonus.status === 'paid' ? (bonus.rewardCents ?? 0) : 0;
}

const WELLS_FARGO_SOURCE = 'https://accountoffers.wellsfargo.com/business-checking-bonus/';
const US_BANK_SOURCE =
	'https://www.usbank.com/business-banking/banking-products/business-bank-accounts/business-checking-account.html';
const CAPITAL_ONE_SOURCE = 'https://www.capitalone.com/small-business/bank/bizchecking500/';
const BMO_SOURCE =
	'https://www.bmo.com/en-us/main/business-banking/bank-accounts/bb-checking-offer/';

export const WELLS_FARGO_BUSINESS_BONUS_TIERS: BonusOfferTier[] = [
	{ thresholdCents: 250_000, rewardCents: 40_000, label: '$2,500 balance' },
	{ thresholdCents: 1_000_000, rewardCents: 55_000, label: '$10,000 balance' },
	{ thresholdCents: 2_500_000, rewardCents: 82_500, label: '$25,000 balance' }
];

const US_BANK_ESSENTIALS_TIER: BonusOfferTier[] = [
	{ thresholdCents: 500_000, rewardCents: 40_000, label: '$5,000 daily balance' }
];

const US_BANK_PLATINUM_TIER: BonusOfferTier[] = [
	{ thresholdCents: 2_500_000, rewardCents: 120_000, label: '$25,000 daily balance' }
];

const CAPITAL_ONE_BUSINESS_TIER: BonusOfferTier[] = [
	{ thresholdCents: 500_000, rewardCents: 50_000, label: '$5,000 end-of-day balance' }
];

export const BMO_BUSINESS_BONUS_TIERS: BonusOfferTier[] = [
	{ thresholdCents: 400_000, rewardCents: 40_000, label: '$4,000 daily balance' },
	{ thresholdCents: 2_500_000, rewardCents: 75_000, label: '$25,000 daily balance' },
	{ thresholdCents: 5_000_000, rewardCents: 100_000, label: '$50,000 daily balance' },
	{ thresholdCents: 10_000_000, rewardCents: 150_000, label: '$100,000 daily balance' }
];

function addDays(value: string, days: number): string {
	const date = new Date(`${value}T00:00:00Z`);
	if (!Number.isFinite(date.getTime())) return '';
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function dayOfOffer(openedDate: string, day: number): string {
	return addDays(openedDate, day - 1);
}

function endOfMonthPlusDays(value: string, days: number): string {
	const date = new Date(`${value}T00:00:00Z`);
	if (!Number.isFinite(date.getTime())) return '';
	const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
	monthEnd.setUTCDate(monthEnd.getUTCDate() + days);
	return monthEnd.toISOString().slice(0, 10);
}

function formatDate(value: string): string {
	return new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC'
	}).format(new Date(`${value}T00:00:00Z`));
}

function wellsFargoRequirements(openedDate: string): string[] {
	const fundingDeadline = dayOfOffer(openedDate, 30);
	const qualificationDeadline = dayOfOffer(openedDate, 60);
	const payoutDate = addDays(qualificationDeadline, 30);
	return [
		'Confirm the Wells Fargo bonus offer code was applied at opening',
		`Reach at least $2,500 by ${formatDate(fundingDeadline)}; the day-30 balance sets the bonus tier`,
		`Maintain the day-30 balance tier through ${formatDate(qualificationDeadline)}`,
		`Complete 5 qualifying posted transactions by ${formatDate(qualificationDeadline)}`,
		`Keep the account open through the expected payout on ${formatDate(payoutDate)}`
	];
}

function usBankRequirements(balance: string, openedDate: string): string[] {
	const fundingDeadline = dayOfOffer(openedDate, 30);
	const qualificationDeadline = dayOfOffer(openedDate, 60);
	const payoutDate = endOfMonthPlusDays(qualificationDeadline, 30);
	return [
		'Confirm promo code Q3DIG26 was applied at opening',
		`Deposit at least ${balance} in new money from outside U.S. Bank by ${formatDate(fundingDeadline)}`,
		`Maintain at least ${balance} as the daily balance through ${formatDate(qualificationDeadline)}`,
		`Complete 6 qualifying posted transactions by ${formatDate(qualificationDeadline)}`,
		`Keep the account open with a positive available balance through the expected payout on ${formatDate(payoutDate)}`
	];
}

function capitalOneRequirements(openedDate: string): string[] {
	const fundingDeadline = dayOfOffer(openedDate, 30);
	const qualificationDeadline = dayOfOffer(openedDate, 90);
	const payoutDate = addDays(qualificationDeadline, 90);
	return [
		'Confirm the account was opened online with promo code SBOFFER500',
		`Deposit at least $5,000 from outside Capital One by ${formatDate(fundingDeadline)}`,
		`Maintain a minimum $5,000 end-of-day balance for at least 60 days within the first 90 days, ending ${formatDate(qualificationDeadline)}`,
		`Complete 10 qualifying electronic transactions by ${formatDate(qualificationDeadline)}`,
		`Keep the account open and in good standing through the conservative payout date of ${formatDate(payoutDate)}`
	];
}

function bmoRequirements(openedDate: string): string[] {
	const fundingDeadline = dayOfOffer(openedDate, 30);
	const qualificationDeadline = dayOfOffer(openedDate, 90);
	const payoutDate = addDays(qualificationDeadline, 14);
	return [
		'Confirm the account was opened through the online offer or with the branch promo code',
		`Reach at least $4,000 by ${formatDate(fundingDeadline)}; the day-30 balance sets the $400 / $750 / $1,000 / $1,500 tier`,
		`Maintain at least the chosen tier balance every day from day 31 through ${formatDate(qualificationDeadline)}; a lower daily balance can reduce the bonus`,
		`Keep the account open, in good standing, and above $0 through the expected payout on ${formatDate(payoutDate)}`
	];
}

export const BONUS_OFFER_CATALOG: BonusOfferTemplate[] = [
	{
		id: 'bmo-business-checking-2026-08-31',
		institution: 'BMO',
		institutionAliases: ['BMO', 'BMO (US)', 'BMO Bank', 'BMO Bank N.A.'],
		name: 'BMO business checking bonus (up to $1,500)',
		accountProduct: 'Digital, Simple, Premium, or Elite Business Checking',
		versionLabel: 'Offer ending Aug 31, 2026',
		validFrom: '2026-05-01',
		validThrough: '2026-08-31',
		sourceUrl: BMO_SOURCE,
		sourceVerifiedAt: '2026-09-02',
		promoCode: null,
		rewardCents: 150_000,
		tiers: BMO_BUSINESS_BONUS_TIERS,
		fundingDay: 30,
		qualificationDay: 90,
		transactionTarget: 0,
		transactionRule: 'balance-only',
		qualificationLabel: 'Maintain through',
		payoutRule: 'qualification-plus-14',
		requirements: bmoRequirements,
		notes:
			'Official terms require an eligible BMO business checking account opened online through the offer page or in branch with a promo code between May 1 and August 31, 2026. The day-30 balance sets the maximum tier: $4,000 for $400, $25,000 for $750, $50,000 for $1,000, or $100,000 for $1,500. Maintain at least that balance every day from day 31 through day 90; dropping to a lower tier reduces the bonus, and dropping below $4,000 forfeits it. BMO expects payment within 14 days after qualification. Existing business checking customers and businesses that closed a BMO business checking account within the prior 12 months are not eligible; one bonus per business entity, and taxes may apply.',
		activityNote:
			'BMO has no transaction-count requirement for this offer. Verify the uninterrupted daily balance directly with BMO because provider snapshots cannot prove it.'
	},
	{
		id: 'wells-fargo-business-checking-2026-09-08',
		institution: 'Wells Fargo',
		institutionAliases: ['Wells Fargo'],
		name: 'Wells Fargo business checking bonus (up to $825)',
		accountProduct: 'Initiate, Navigate, or Optimize Business Checking',
		versionLabel: 'Offer ending Sep 8, 2026',
		validFrom: null,
		validThrough: '2026-09-08',
		sourceUrl: WELLS_FARGO_SOURCE,
		sourceVerifiedAt: '2026-08-28',
		promoCode: null,
		rewardCents: 82_500,
		tiers: WELLS_FARGO_BUSINESS_BONUS_TIERS,
		fundingDay: 30,
		qualificationDay: 60,
		transactionTarget: 5,
		transactionRule: 'wells-fargo-business',
		qualificationLabel: 'Maintain through',
		payoutRule: 'qualification-plus-30',
		requirements: wellsFargoRequirements,
		notes:
			'Official terms require a qualifying Wells Fargo business checking account and a bonus offer code at opening. The day-30 balance sets the maximum tier; maintain that tier through day 60 and complete 5 qualifying posted transactions. New business checking customers only; eligibility restrictions apply. Bonus may be taxable.',
		activityNote:
			'Verify the five transactions in Wells Fargo. Zelle, withdrawals, internal Wells Fargo transfers, RTP/FedNow, and original credits do not count.'
	},
	{
		id: 'us-bank-business-essentials-q3-2026',
		institution: 'U.S. Bank',
		institutionAliases: ['U.S. Bank', 'US Bank', 'U.S. Bancorp'],
		name: 'U.S. Bank Business Essentials bonus ($400)',
		accountProduct: 'Business Essentials',
		versionLabel: 'Q3 2026 · Q3DIG26',
		validFrom: '2026-07-01',
		validThrough: '2026-09-27',
		sourceUrl: US_BANK_SOURCE,
		sourceVerifiedAt: '2026-08-28',
		promoCode: 'Q3DIG26',
		rewardCents: 40_000,
		tiers: US_BANK_ESSENTIALS_TIER,
		fundingDay: 30,
		qualificationDay: 60,
		transactionTarget: 6,
		transactionRule: 'us-bank-business',
		qualificationLabel: 'Maintain through',
		payoutRule: 'qualification-month-end-plus-30',
		requirements: (openedDate) => usBankRequirements('$5,000', openedDate),
		notes:
			'Official Q3DIG26 terms require $5,000 in new money from outside U.S. Bank within 30 days, a $5,000 daily balance through day 60, and 6 qualifying posted transactions. For weekend or federal-holiday openings, U.S. Bank treats the next business day as the opening date. Existing businesses with a U.S. Bank business checking account, or one closed in the prior 12 months, are not eligible. Limit one bonus per business; other restrictions and taxes may apply.',
		activityNote:
			'Verify the six transactions in U.S. Bank. Eligible activity includes debit purchases, ACH/wires, Zelle, mobile check deposits, eligible check debits, business bill pay, and Payment Solutions. Internal U.S. Bank transfers, other person-to-person payments, and credit-card transfers do not count.'
	},
	{
		id: 'us-bank-platinum-business-checking-q3-2026',
		institution: 'U.S. Bank',
		institutionAliases: ['U.S. Bank', 'US Bank', 'U.S. Bancorp'],
		name: 'U.S. Bank Platinum Business Checking bonus ($1,200)',
		accountProduct: 'Platinum Business Checking Package',
		versionLabel: 'Q3 2026 · Q3DIG26',
		validFrom: '2026-07-01',
		validThrough: '2026-09-27',
		sourceUrl: US_BANK_SOURCE,
		sourceVerifiedAt: '2026-08-28',
		promoCode: 'Q3DIG26',
		rewardCents: 120_000,
		tiers: US_BANK_PLATINUM_TIER,
		fundingDay: 30,
		qualificationDay: 60,
		transactionTarget: 6,
		transactionRule: 'us-bank-business',
		qualificationLabel: 'Maintain through',
		payoutRule: 'qualification-month-end-plus-30',
		requirements: (openedDate) => usBankRequirements('$25,000', openedDate),
		notes:
			'Official Q3DIG26 terms require $25,000 in new money from outside U.S. Bank within 30 days, a $25,000 daily balance through day 60, and 6 qualifying posted transactions. For weekend or federal-holiday openings, U.S. Bank treats the next business day as the opening date. Existing businesses with a U.S. Bank business checking account, or one closed in the prior 12 months, are not eligible. Limit one bonus per business; other restrictions and taxes may apply.',
		activityNote:
			'Verify the six transactions in U.S. Bank. Eligible activity includes debit purchases, ACH/wires, Zelle, mobile check deposits, eligible check debits, business bill pay, and Payment Solutions. Internal U.S. Bank transfers, other person-to-person payments, and credit-card transfers do not count.'
	},
	{
		id: 'capital-one-business-checking-sboffer500-2026',
		institution: 'Capital One',
		institutionAliases: ['Capital One', 'Capital One Bank'],
		name: 'Capital One business checking bonus ($500)',
		accountProduct: 'Basic or Enhanced Business Checking',
		versionLabel: 'SBOFFER500 · active Aug 29, 2026',
		validFrom: null,
		validThrough: null,
		sourceUrl: CAPITAL_ONE_SOURCE,
		sourceVerifiedAt: '2026-08-29',
		promoCode: 'SBOFFER500',
		rewardCents: 50_000,
		tiers: CAPITAL_ONE_BUSINESS_TIER,
		fundingDay: 30,
		qualificationDay: 90,
		transactionTarget: 10,
		transactionRule: 'capital-one-business',
		qualificationLabel: 'Complete by',
		payoutRule: 'qualification-plus-90',
		requirements: capitalOneRequirements,
		notes:
			'Official SBOFFER500 terms require an online Basic or Enhanced Business Checking opening, at least $5,000 from outside Capital One within 30 days, a $5,000 minimum end-of-day balance for at least 60 days within the first 90 days, and 10 qualifying electronic transactions within 90 days. Capital One may end or change the offer before acceptance, and eligibility restrictions and taxes may apply.',
		activityNote:
			'Verify all ten transactions in Capital One. Only electronic wires, remote check deposits, ACH, and qualifying instant transfers count; internal Capital One transfers do not.'
	}
];

function normalizeInstitution(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function institutionMatches(offer: BonusOfferTemplate, institution: string | null): boolean {
	if (!institution) return false;
	const normalized = normalizeInstitution(institution);
	return offer.institutionAliases.some((alias) => {
		const candidate = normalizeInstitution(alias);
		return normalized.includes(candidate) || candidate.includes(normalized);
	});
}

export function getBonusOfferTemplate(id: string | null): BonusOfferTemplate | null {
	return BONUS_OFFER_CATALOG.find((offer) => offer.id === id) ?? null;
}

export function isOfferDateEligible(offer: BonusOfferTemplate, openedDate: string | null): boolean {
	if (!openedDate) return true;
	return (
		(!offer.validFrom || openedDate >= offer.validFrom) &&
		(!offer.validThrough || openedDate <= offer.validThrough)
	);
}

export function getCompatibleBonusOffers(
	account: FinancialAccount | null,
	openedDate: string | null = null
): BonusOfferTemplate[] {
	if (!account || account.accountType !== 'checking' || account.ownerType !== 'business') return [];
	return BONUS_OFFER_CATALOG.filter(
		(offer) =>
			institutionMatches(offer, account.institution) && isOfferDateEligible(offer, openedDate)
	);
}

export function buildBonusOfferDraft(
	offer: BonusOfferTemplate,
	openedDate: string
): BonusOfferDraft | null {
	const fundingDeadline = dayOfOffer(openedDate, offer.fundingDay);
	const qualificationDeadline = dayOfOffer(openedDate, offer.qualificationDay);
	if (!fundingDeadline || !qualificationDeadline) return null;
	const expectedPayoutDate =
		offer.payoutRule === 'qualification-plus-14'
			? addDays(qualificationDeadline, 14)
			: offer.payoutRule === 'qualification-plus-30'
				? addDays(qualificationDeadline, 30)
				: offer.payoutRule === 'qualification-plus-90'
					? addDays(qualificationDeadline, 90)
					: endOfMonthPlusDays(qualificationDeadline, 30);
	return {
		name: offer.name,
		institution: offer.institution,
		rewardCents: offer.rewardCents,
		requirementDeadline: qualificationDeadline,
		expectedPayoutDate,
		safeToCloseDate: addDays(expectedPayoutDate, 1),
		requirements: offer.requirements(openedDate),
		notes: `${offer.notes}\n\nOfficial terms: ${offer.sourceUrl}\nTemplate verified ${offer.sourceVerifiedAt}. Always follow the terms provided when you opened the account.`
	};
}

function normalizedTransactionText(transaction: FinancialAccountTransaction): string {
	return `${transaction.name} ${transaction.merchantName ?? ''}`
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, ' ')
		.trim();
}

function postedBonusRewardCents(
	bonus: AccountBonus,
	offer: BonusOfferTemplate,
	transactions: FinancialAccountTransaction[]
): number | null {
	const tierRewards = new Set(offer.tiers.map((tier) => tier.rewardCents));
	const promoCode = offer.promoCode?.toUpperCase() ?? '';
	const matches = transactions
		.filter(
			(transaction) =>
				!transaction.pending &&
				transaction.amountCents < 0 &&
				transaction.date >= (bonus.openedDate ?? '') &&
				tierRewards.has(Math.abs(transaction.amountCents))
		)
		.filter((transaction) => {
			const text = normalizedTransactionText(transaction);
			return (
				/BONUS|PROMO(?:TION|TIONAL)?|INCENTIVE|REWARD/.test(text) ||
				Boolean(promoCode && text.includes(promoCode))
			);
		})
		.map((transaction) => Math.abs(transaction.amountCents));
	return matches.length > 0 ? Math.max(...matches) : null;
}

function isInQualificationWindow(
	transaction: FinancialAccountTransaction,
	openedDate: string,
	qualificationDeadline: string
): boolean {
	return (
		!transaction.pending &&
		transaction.amountCents !== 0 &&
		transaction.date >= openedDate &&
		transaction.date <= qualificationDeadline
	);
}

export function isLikelyWellsFargoQualifyingTransaction(
	transaction: FinancialAccountTransaction,
	openedDate: string,
	qualificationDeadline: string
): boolean {
	if (!isInQualificationWindow(transaction, openedDate, qualificationDeadline)) return false;
	const text = normalizedTransactionText(transaction);
	if (
		/\bZELLE\b|\bFEDNOW\b|\bRTP\b|REAL TIME PAYMENT|ORIGINAL CREDIT|\bOCT\b|ATM WITHDRAWAL|CASH WITHDRAWAL|INTERNAL TRANSFER|WELLS FARGO TRANSFER|WIRE OUT|ACH WITHDRAWAL|DEBIT CARD CREDIT/.test(
			text
		)
	) {
		return false;
	}
	if (/\bBILL PAY(?:MENT)?\b/.test(text)) return true;
	const primary = transaction.categoryPrimary?.toUpperCase() ?? '';
	const detailed = transaction.categoryDetailed?.toUpperCase() ?? '';
	if (transaction.amountCents < 0) {
		return (
			primary === 'INCOME' ||
			primary === 'TRANSFER_IN' ||
			/DEPOSIT|PAYCHECK|ACH CREDIT|WIRE TRANSFER IN/.test(`${text} ${detailed}`)
		);
	}
	if (
		['TRANSFER_IN', 'TRANSFER_OUT', 'CASH_ADVANCE', 'BANK_FEES', 'LOAN_PAYMENTS'].includes(primary)
	) {
		return false;
	}
	return Boolean(transaction.merchantName || detailed);
}

export function isLikelyUsBankQualifyingTransaction(
	transaction: FinancialAccountTransaction,
	openedDate: string,
	qualificationDeadline: string
): boolean {
	if (!isInQualificationWindow(transaction, openedDate, qualificationDeadline)) return false;
	const text = normalizedTransactionText(transaction);
	const primary = transaction.categoryPrimary?.toUpperCase() ?? '';
	const detailed = transaction.categoryDetailed?.toUpperCase() ?? '';
	const combined = `${text} ${detailed}`;
	if (
		/INTERNAL TRANSFER|TRANSFER BETWEEN|U S BANK TRANSFER|USBANK TRANSFER|CREDIT CARD (?:TRANSFER|PAYMENT)|CARDMEMBER SERVICE|VENMO|CASH APP|PAYPAL|PERSON TO PERSON|\bP2P\b|ATM WITHDRAWAL|CASH WITHDRAWAL/.test(
			combined
		)
	) {
		return false;
	}
	if (/\bZELLE\b/.test(text)) return true;
	if (/PAYMENT SOLUTIONS|ELAVON|MOBILE CHECK DEPOSIT|REMOTE DEPOSIT/.test(combined)) return true;
	if (/\bBILL PAY(?:MENT)?\b/.test(text) && !/CREDIT CARD|CARDMEMBER/.test(combined)) return true;
	if (
		/\bACH\b|WIRE (?:CREDIT|DEBIT|TRANSFER)|CHECK (?:DEBIT|PAID|NUMBER|NO\b)|CHECK #/.test(combined)
	) {
		return true;
	}
	if (transaction.amountCents < 0) {
		return primary === 'INCOME' || /DEPOSIT|TRANSFER IN/.test(combined);
	}
	if (
		['TRANSFER_IN', 'TRANSFER_OUT', 'CASH_ADVANCE', 'BANK_FEES', 'LOAN_PAYMENTS'].includes(primary)
	) {
		return false;
	}
	return Boolean(transaction.merchantName || detailed);
}

export function isLikelyCapitalOneQualifyingTransaction(
	transaction: FinancialAccountTransaction,
	openedDate: string,
	qualificationDeadline: string
): boolean {
	if (!isInQualificationWindow(transaction, openedDate, qualificationDeadline)) return false;
	const text = normalizedTransactionText(transaction);
	const primary = transaction.categoryPrimary?.toUpperCase() ?? '';
	const detailed = transaction.categoryDetailed?.toUpperCase() ?? '';
	const combined = `${text} ${detailed}`;
	if (
		/CAPITAL ONE|INTERNAL TRANSFER|TRANSFER BETWEEN|ATM|CASH WITHDRAWAL|CASH ADVANCE|DEBIT CARD|CARD PURCHASE|BILL PAY|CREDIT CARD|CARDMEMBER|ZELLE|VENMO|CASH APP|PAYPAL|PERSON TO PERSON|\bP2P\b/.test(
			combined
		)
	) {
		return false;
	}
	if (
		/\bACH\b|\bWIRE\b|REMOTE CHECK DEPOSIT|MOBILE CHECK DEPOSIT|INSTANT TRANSFER/.test(combined)
	) {
		return true;
	}
	return ['TRANSFER_IN', 'TRANSFER_OUT'].includes(primary) && /TRANSFER|DEPOSIT/.test(detailed);
}

function resolveOffer(bonus: AccountBonus, account: FinancialAccount): BonusOfferTemplate | null {
	const selected = getBonusOfferTemplate(bonus.offerTemplateId);
	if (selected) return selected;
	const legacyWellsFargo = getBonusOfferTemplate('wells-fargo-business-checking-2026-09-08')!;
	if (
		bonus.rewardCents === legacyWellsFargo.rewardCents &&
		institutionMatches(legacyWellsFargo, account.institution) &&
		isOfferDateEligible(legacyWellsFargo, bonus.openedDate)
	) {
		return legacyWellsFargo;
	}
	return null;
}

export function resolveBonusOffer(
	bonus: AccountBonus,
	account: FinancialAccount | null
): BonusOfferTemplate | null {
	if (!account || account.accountType !== 'checking' || account.ownerType !== 'business')
		return null;
	const offer = resolveOffer(bonus, account);
	return offer &&
		institutionMatches(offer, account.institution) &&
		(isOfferDateEligible(offer, bonus.openedDate) || bonus.offerDateOverrideConfirmed)
		? offer
		: null;
}

export function buildBonusTracker(
	bonus: AccountBonus,
	account: FinancialAccount | null,
	transactions: FinancialAccountTransaction[]
): BonusTracker | null {
	if (!account || !bonus.openedDate) return null;
	const offer = resolveBonusOffer(bonus, account);
	if (!offer) return null;
	const draft = buildBonusOfferDraft(offer, bonus.openedDate);
	if (!draft) return null;
	const balanceCents = account.currentBalanceCents;
	const currentTier =
		balanceCents === null
			? null
			: (offer.tiers.filter((tier) => balanceCents >= tier.thresholdCents).at(-1) ?? null);
	const nextTier =
		balanceCents === null
			? offer.tiers[0]
			: (offer.tiers.find((tier) => balanceCents < tier.thresholdCents) ?? null);
	const qualificationDeadline = bonus.requirementDeadline ?? draft.requirementDeadline;
	const classifier =
		offer.transactionRule === 'balance-only'
			? () => false
			: offer.transactionRule === 'wells-fargo-business'
				? isLikelyWellsFargoQualifyingTransaction
				: offer.transactionRule === 'capital-one-business'
					? isLikelyCapitalOneQualifyingTransaction
					: isLikelyUsBankQualifyingTransaction;
	return {
		offer,
		account,
		balanceCents,
		currentTier,
		nextTier,
		amountToNextTierCents:
			nextTier && balanceCents !== null
				? Math.max(0, nextTier.thresholdCents - balanceCents)
				: (nextTier?.thresholdCents ?? null),
		fundingDeadline: dayOfOffer(bonus.openedDate, offer.fundingDay),
		qualificationDeadline,
		latestPayoutDate: bonus.expectedPayoutDate ?? draft.expectedPayoutDate,
		safeToCloseDate: bonus.safeToCloseDate ?? draft.safeToCloseDate,
		likelyQualifyingTransactions: transactions.filter((transaction) =>
			classifier(transaction, bonus.openedDate!, qualificationDeadline)
		),
		postedRewardCents: postedBonusRewardCents(bonus, offer, transactions)
	};
}
