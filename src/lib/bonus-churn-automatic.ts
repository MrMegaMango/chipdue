import type {
	AccountBonus,
	BonusChurn,
	Card,
	FinancialAccount,
	FinancialAccountTransaction
} from '$lib/types';
import {
	BONUS_CHURN_PRESETS,
	buildBonusChurnTracker,
	formatBonusChurnDate,
	getBonusChurnToday,
	type BonusChurnPreset,
	type BonusChurnTracker
} from './bonus-churn';
import { getBonusOfferTemplate, type BonusOfferTemplate } from './bonus-offers';

export type BonusChurnActivity = {
	account: FinancialAccount | null;
	card: Card | null;
	transactions: FinancialAccountTransaction[];
	activityState: 'available' | 'unavailable' | 'not_connected';
	lastSyncedAt: string | null;
	payoutAmbiguous?: boolean;
};

export type BonusChurnAutomationResult = {
	bonusId: string;
	tracker: BonusChurnTracker;
	effectiveRule: BonusChurn | null;
	ruleSource: 'automatic' | 'saved' | 'unmatched';
	paidDate: string | null;
	openedDate: string | null;
	closedDate: string | null;
	dateSources: {
		paidDate: 'saved' | 'transaction' | null;
		openedDate: 'saved' | 'account' | null;
		closedDate: 'saved' | null;
	};
	statusLabel: string;
	detail: string;
	projectionDate: string | null;
	projectionNote: string | null;
	sourceUrl: string | null;
	checkedAt: string | null;
	ruleVerifiedAt: string | null;
	payoutTransactionId: string | null;
};

type OfferCategory = 'upgrade' | 'referral' | 'targeted' | null;
type PayoutMatch = {
	date: string | null;
	transactionId: string | null;
	issue: 'ambiguous' | 'reversed' | null;
};

function validDate(value: string | null | undefined): value is string {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function actualDate(value: string | null | undefined, today: string): string | null {
	return validDate(value) && validDate(today) && value <= today ? value : null;
}

function normalized(value: string): string {
	return value
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, ' ')
		.trim();
}

function categoryFor(bonus: AccountBonus, offer: BonusOfferTemplate | null): OfferCategory {
	const text = normalized(`${bonus.name} ${offer?.name ?? ''} ${offer?.accountProduct ?? ''}`);
	if (/\bUPGRAD(?:E|ES|ING)\b/.test(text)) return 'upgrade';
	if (/\bREFERRAL\b|\bREFER (?:A )?FRIEND\b|\bREFERRER\b/.test(text)) return 'referral';
	if (/\bTARGETED\b|\bINVITATION\b|\bINVITE\b|\bEXISTING ACCOUNT\b/.test(text)) return 'targeted';
	return null;
}

function automaticPreset(
	offer: BonusOfferTemplate | null,
	category: OfferCategory
): BonusChurnPreset | null {
	if (!offer) return null;
	if (offer.id === 'etrade-targeted-existing-brokerage-2026-08-19') {
		return BONUS_CHURN_PRESETS.find((item) => item.id === 'etrade-targeted-review') ?? null;
	}
	if (
		category ||
		!offer.ownerTypes.includes('business') ||
		!offer.accountTypes.includes('checking')
	) {
		return null;
	}
	const prefix =
		offer.transactionRule === 'wells-fargo-business'
			? 'wells-fargo-business-'
			: offer.transactionRule === 'us-bank-business'
				? 'us-bank-business-'
				: offer.transactionRule === 'capital-one-business'
					? 'capital-one-business-'
					: offer.id === 'bmo-business-checking-2026-08-31'
						? 'bmo-business-'
						: null;
	return prefix ? (BONUS_CHURN_PRESETS.find((item) => item.id.startsWith(prefix)) ?? null) : null;
}

function cloneRule(rule: BonusChurn): BonusChurn {
	return { ...rule, conditions: rule.conditions.map((condition) => ({ ...condition })) };
}

const REVERSAL =
	/\bREFUND(?:ED)?\b|\bREVERS(?:AL|ED|E)\b|\bRECOUP(?:MENT|ED)?\b|\bCLAWBACK\b|\bCLAW BACK\b|\bCHARGEBACK\b/;
const REDEMPTION = /\bREDEMPTION\b|\bREDEEM(?:ED|ING)?\b/;
const PAYROLL = /\bPAYROLL\b|\bPAYCHECK\b|\bSALARY\b|\bWAGES?\b|\bEMPLOYER\b/;

function hasBonusDescription(
	transaction: FinancialAccountTransaction,
	promoCode: string | null
): boolean {
	// Merchant/security names alone cannot establish that the institution paid this bonus.
	const text = normalized(transaction.name);
	const code = promoCode ? normalized(promoCode) : null;
	return (
		/\bBONUS\b|\bPROMO(?:TION|TIONAL)?\b|\bINCENTIVE\b/.test(text) ||
		Boolean(code && ` ${text} `.includes(` ${code} `))
	);
}

function excludedCredit(transaction: FinancialAccountTransaction): boolean {
	const text = normalized(`${transaction.name} ${transaction.merchantName ?? ''}`);
	const category = normalized(
		`${transaction.categoryPrimary ?? ''} ${transaction.categoryDetailed ?? ''}`
	);
	if (REVERSAL.test(text) || REDEMPTION.test(text) || PAYROLL.test(`${text} ${category}`))
		return true;
	if (/\bLOAN PAYMENTS?\b|\bCREDIT CARD PAYMENT\b/.test(category)) return true;
	if (
		/\bPAYMENTS?\b|\bBILL PAY\b|\bAUTOPAY\b/.test(text) &&
		!/\b(?:BONUS|PROMO(?:TION|TIONAL)?|INCENTIVE) PAYMENT\b/.test(text)
	)
		return true;
	if (transaction.investmentDetails) {
		const details = transaction.investmentDetails;
		const kind = normalized(`${details.type} ${details.subtype}`);
		if (
			details.tickerSymbol ||
			details.quantity !== 0 ||
			/\bBUY\b|\bSELL\b|\bSALE\b|\bTRADE\b|\bDIVIDEND\b|\bINTEREST\b|\bREINVESTMENT\b/.test(kind)
		)
			return true;
		if (!/\bCASH\b|\bCREDIT\b|\bDEPOSIT\b|\bTRANSFER\b|\bBONUS\b/.test(kind)) return true;
	}
	return false;
}

function detectPayout(
	bonus: AccountBonus,
	offer: BonusOfferTemplate | null,
	transactions: FinancialAccountTransaction[],
	startDate: string | null,
	today: string
): PayoutMatch {
	if (!startDate || !validDate(startDate) || !validDate(today))
		return { date: null, transactionId: null, issue: null };
	const rewards = new Set(
		[bonus.rewardCents, ...(offer?.tiers.map((tier) => tier.rewardCents) ?? [])].filter(
			(amount): amount is number =>
				typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0
		)
	);
	const matches = new Map<string, FinancialAccountTransaction>();
	for (const transaction of transactions) {
		if (
			transaction.pending ||
			!Number.isSafeInteger(transaction.amountCents) ||
			transaction.amountCents >= 0 ||
			transaction.currency.toUpperCase() !== bonus.currency.toUpperCase() ||
			!validDate(transaction.date) ||
			transaction.date < startDate ||
			transaction.date > today ||
			!rewards.has(-transaction.amountCents) ||
			!hasBonusDescription(transaction, offer?.promoCode ?? null) ||
			excludedCredit(transaction)
		)
			continue;
		const previous = matches.get(transaction.id);
		if (
			previous &&
			(previous.date !== transaction.date || previous.amountCents !== transaction.amountCents)
		) {
			return { date: null, transactionId: null, issue: 'ambiguous' };
		}
		matches.set(transaction.id, transaction);
	}
	if (matches.size > 1) return { date: null, transactionId: null, issue: 'ambiguous' };
	const candidate = [...matches.values()][0];
	if (!candidate) return { date: null, transactionId: null, issue: null };
	const reversed = transactions.some(
		(transaction) =>
			!transaction.pending &&
			transaction.amountCents === -candidate.amountCents &&
			transaction.currency.toUpperCase() === bonus.currency.toUpperCase() &&
			validDate(transaction.date) &&
			transaction.date >= candidate.date &&
			transaction.date <= today &&
			REVERSAL.test(normalized(`${transaction.name} ${transaction.merchantName ?? ''}`))
	);
	return reversed
		? { date: null, transactionId: null, issue: 'reversed' }
		: { date: candidate.date, transactionId: candidate.id, issue: null };
}

function offerSpecificDetail(category: OfferCategory, bonus: AccountBonus): string {
	if (category === 'upgrade') {
		return 'Upgrade bonuses depend on the specific upgrade offer or invitation. No calendar reset is confirmed; review a new offer when it appears. A welcome-bonus rule does not establish upgrade eligibility.';
	}
	if (category === 'referral') {
		const varo = /\bVARO\b/.test(normalized(`${bonus.name} ${bonus.institution ?? ''}`));
		return varo
			? 'Varo referral terms distinguish the new-customer recipient from the referrer. The recipient must never previously have been a customer; referrer limits are separate. The saved bonus does not identify your role, so no repeat date is assumed.'
			: 'Referral eligibility depends on whether you are the referrer or recipient and on the specific campaign limits. No calendar reset is confirmed for this saved offer.';
	}
	if (category === 'targeted') {
		return 'This bonus depends on a targeted invitation or existing-account offer. A new invitation and its terms determine whether it can be repeated; no calendar reset is confirmed.';
	}
	return 'The saved product has no confirmed repeat-bonus rule in the offer catalog. Posted payout activity can still be tracked; eligibility depends on the next offer’s specific terms.';
}

function projection(
	bonus: AccountBonus,
	rule: BonusChurn | null,
	tracker: BonusChurnTracker,
	paidDate: string | null,
	openedDate: string | null,
	closedDate: string | null,
	today: string
): { projectionDate: string | null; projectionNote: string | null } {
	const empty = { projectionDate: null, projectionNote: null };
	if (!rule || rule.mode !== 'rules' || tracker.status !== 'needs_info' || !validDate(today))
		return empty;
	if (
		(bonus.paidDate != null && !paidDate) ||
		(bonus.churn?.openedDate != null && !openedDate) ||
		(bonus.churn?.closedDate != null && !closedDate)
	)
		return empty;
	let projectedPaid = paidDate;
	let projectedClosed = closedDate;
	const assumptions: string[] = [];
	const expected = validDate(bonus.expectedPayoutDate) ? bonus.expectedPayoutDate : null;
	const safe = validDate(bonus.safeToCloseDate) ? bonus.safeToCloseDate : null;
	if (rule.conditions.some((condition) => condition.anchor === 'paidDate') && !projectedPaid) {
		if (!expected || expected < today) return empty;
		projectedPaid = expected;
		assumptions.push(`bonus payment on ${formatBonusChurnDate(expected)}`);
	}
	if (
		(rule.requiresClosed ||
			rule.conditions.some((condition) => condition.anchor === 'closedDate')) &&
		!projectedClosed
	) {
		if (!safe && !expected) return empty;
		projectedClosed = [today, projectedPaid, expected, safe]
			.filter((date): date is string => Boolean(date))
			.sort()
			.at(-1)!;
		assumptions.push(`account closure on ${formatBonusChurnDate(projectedClosed)} or later`);
	}
	if (!assumptions.length) return empty;
	const referenceDate = [today, projectedPaid, projectedClosed]
		.filter((date): date is string => Boolean(date))
		.sort()
		.at(-1)!;
	const forecast = buildBonusChurnTracker(
		{
			...bonus,
			openedDate,
			paidDate: projectedPaid,
			churn: { ...rule, openedDate, closedDate: projectedClosed }
		},
		referenceDate
	);
	if (!forecast.reviewDate) return empty;
	return {
		projectionDate: forecast.reviewDate,
		projectionNote: `Estimate only: assumes ${assumptions.join(' and ')}. The actual dates must be confirmed and current offer terms reviewed.`
	};
}

export function resolveAutomaticBonusChurn(
	bonus: AccountBonus,
	activity: Partial<BonusChurnActivity> = {},
	today: string = getBonusChurnToday()
): BonusChurnAutomationResult {
	const offer = getBonusOfferTemplate(bonus.offerTemplateId);
	const category = categoryFor(bonus, offer);
	const preset = automaticPreset(offer, category);
	const ruleSource = bonus.churn ? 'saved' : preset ? 'automatic' : 'unmatched';
	let effectiveRule = bonus.churn
		? cloneRule(bonus.churn)
		: preset
			? cloneRule(preset.churn)
			: null;
	const account =
		bonus.accountId && activity.account?.id === bonus.accountId ? activity.account : null;
	const card = bonus.cardId && activity.card?.id === bonus.cardId ? activity.card : null;
	const linked = account ?? card;
	const activityState =
		activity.activityState ?? (linked?.source === 'connected' ? 'unavailable' : 'not_connected');
	const enrollment = offer?.startDateLabel === 'Offer enrolled' || (!offer && category !== null);
	const savedOpening = bonus.churn?.openedDate ?? (enrollment ? null : bonus.openedDate);
	const openingCandidate = savedOpening ?? account?.openedDate ?? null;
	const openedDate = actualDate(openingCandidate, today);
	const closedDate = actualDate(bonus.churn?.closedDate, today);
	const savedPaidDate = actualDate(bonus.paidDate, today);
	const dateSources: BonusChurnAutomationResult['dateSources'] = {
		paidDate: savedPaidDate ? 'saved' : null,
		openedDate: openedDate ? (savedOpening != null ? 'saved' : 'account') : null,
		closedDate: closedDate ? 'saved' : null
	};
	// Enrollment is a valid lower bound for payout matching, never an opening-date substitute.
	const startDates = [openedDate, enrollment ? actualDate(bonus.openedDate, today) : null].filter(
		(date): date is string => Boolean(date)
	);
	const startDate = startDates.sort().at(-1) ?? null;
	const payout: PayoutMatch =
		bonus.paidDate == null && activity.payoutAmbiguous
			? { date: null, transactionId: null, issue: 'ambiguous' }
			: bonus.paidDate == null &&
				  linked &&
				  linked.currency.toUpperCase() === bonus.currency.toUpperCase() &&
				  activityState === 'available'
				? detectPayout(bonus, offer, activity.transactions ?? [], startDate, today)
				: { date: null, transactionId: null, issue: null };
	const paidDate = savedPaidDate ?? payout.date;
	if (payout.date) dateSources.paidDate = 'transaction';
	if (effectiveRule) effectiveRule = { ...effectiveRule, openedDate, closedDate };
	const base = buildBonusChurnTracker(
		{ ...bonus, openedDate, paidDate, churn: effectiveRule },
		today
	);
	const tracker = {
		...base,
		missing: base.missing.map((item) =>
			item
				.replace('Record the actual bonus payment date.', 'Waiting for a confirmed bonus payment.')
				.replace(
					'Record the actual account closure date.',
					'Waiting for a confirmed account closure date.'
				)
				.replace(
					'Record the actual account opening date.',
					'Waiting for a confirmed account opening date.'
				)
		)
	};
	let statusLabel: string;
	let detail: string;
	const needsPaid =
		effectiveRule?.mode === 'rules' &&
		effectiveRule.conditions.some((condition) => condition.anchor === 'paidDate');
	const needsClosed = Boolean(
		effectiveRule?.requiresClosed ||
		(effectiveRule?.mode === 'rules' &&
			effectiveRule.conditions.some((condition) => condition.anchor === 'closedDate'))
	);
	const invalidSavedDate =
		(bonus.paidDate != null && !savedPaidDate) ||
		(savedOpening != null && !openedDate) ||
		(bonus.churn?.closedDate != null && !closedDate);
	if (!effectiveRule) {
		statusLabel = 'Offer-specific terms';
		detail = offerSpecificDetail(category, bonus);
		tracker.ruleSummary = detail;
	} else if (tracker.status === 'restricted') {
		statusLabel = 'Offer review required';
		detail = category
			? offerSpecificDetail(category, bonus)
			: `${effectiveRule.notes ?? 'The saved offer includes repeat-bonus restrictions.'} Review the next offer before assuming eligibility.`;
	} else if (tracker.status === 'ready') {
		statusLabel = 'Offer review due';
		detail = `The tracked cooldown ended on ${formatBonusChurnDate(tracker.reviewDate)}. Review current offer terms before applying again.`;
	} else if (tracker.status === 'waiting') {
		statusLabel = 'Cooling down';
		detail = `The current rules put the next offer review on ${formatBonusChurnDate(tracker.reviewDate)}.${dateSources.paidDate === 'transaction' ? ` Bonus payment was detected in posted activity on ${formatBonusChurnDate(paidDate)}.` : ''}`;
	} else if (invalidSavedDate) {
		statusLabel = 'Saved dates need review';
		detail =
			'A saved actual-event date is invalid or in the future. The tracker will use the corrected date when it is confirmed.';
	} else if (needsPaid && !paidDate) {
		if (payout.issue) {
			statusLabel = 'Payout review required';
			detail =
				payout.issue === 'reversed'
					? 'A matching bonus credit has a later refund, reversal, or clawback debit. Its payment date is not confirmed.'
					: activity.payoutAmbiguous
						? 'The same posted credit matches more than one saved bonus. A payment date cannot be attributed reliably until the match is confirmed.'
						: 'Multiple distinct posted credits match this bonus. A payment date cannot be selected reliably from this activity.';
		} else if (activityState === 'unavailable') {
			statusLabel = 'Activity unavailable';
			detail =
				'Linked activity could not be checked. Automatic payout detection resumes when activity is available; saved dates and terms remain in use.';
		} else {
			statusLabel = 'Watching for bonus payout';
			detail =
				!linked || activityState === 'not_connected'
					? 'A posted bonus credit can be detected when this bonus has a linked account or card with available activity.'
					: !startDate
						? 'Activity is available, but a confirmed offer start is needed to distinguish this bonus from earlier credits.'
						: 'No single posted credit matches the bonus amount, currency, offer start, and bonus description yet. This updates as linked activity syncs.';
		}
	} else if (needsClosed && !closedDate) {
		statusLabel = 'Waiting for account closure';
		detail =
			account?.status === 'closed'
				? 'The linked account is marked closed, but its dated closure is not available. A confirmed closure date is needed to start that cooldown.'
				: 'The repeat-offer rules include an account-closure cooldown. Its confirmed closure date will start that part of the countdown.';
	} else if (
		effectiveRule.mode === 'rules' &&
		!openedDate &&
		effectiveRule.conditions.some((condition) => condition.anchor === 'openedDate')
	) {
		statusLabel = 'Watching for account opening';
		detail =
			'This cooldown depends on the actual account opening date. The tracker uses a saved date or the linked account’s opening date when available.';
	} else {
		statusLabel = 'Offer review required';
		detail =
			effectiveRule.mode === 'manual'
				? 'The saved override uses a manual review date. The tracker will count down when that date is set.'
				: 'The saved cooldown rules need review before a repeat-offer date can be calculated.';
	}
	const referencePreset = BONUS_CHURN_PRESETS.find((item) => item.id === effectiveRule?.presetId);
	const sourceUrl = effectiveRule?.sourceUrl ?? preset?.sourceUrl ?? offer?.sourceUrl ?? null;
	const ruleVerifiedAt =
		sourceUrl && sourceUrl === referencePreset?.sourceUrl
			? referencePreset.verifiedAt
			: sourceUrl && sourceUrl === offer?.sourceUrl
				? offer.sourceVerifiedAt
				: null;
	return {
		bonusId: bonus.id,
		tracker,
		effectiveRule,
		ruleSource,
		paidDate,
		openedDate,
		closedDate,
		dateSources,
		statusLabel,
		detail,
		...(payout.issue
			? { projectionDate: null, projectionNote: null }
			: projection(bonus, effectiveRule, tracker, paidDate, openedDate, closedDate, today)),
		sourceUrl,
		checkedAt: activityState === 'available' && linked ? (activity.lastSyncedAt ?? null) : null,
		ruleVerifiedAt,
		payoutTransactionId: payout.transactionId
	};
}
