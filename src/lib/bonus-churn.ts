import type { AccountBonus, BonusChurn, BonusChurnCondition } from '$lib/types';
import { getBonusOfferTemplate } from './bonus-offers';

export type BonusChurnStatus = 'unconfigured' | 'needs_info' | 'waiting' | 'ready' | 'restricted';

export interface BonusChurnTracker {
	status: BonusChurnStatus;
	reviewDate: string | null;
	daysRemaining: number | null;
	missing: string[];
	ruleSummary: string;
}

export interface BonusChurnPreset {
	id: string;
	label: string;
	description: string;
	sourceUrl: string;
	verifiedAt: string | null;
	churn: BonusChurn;
}

const DAY_MS = 86_400_000;
const ANCHOR_LABELS: Record<BonusChurnCondition['anchor'], string> = {
	paidDate: 'bonus payment',
	openedDate: 'account opening',
	closedDate: 'account closure'
};

function preset(
	id: string,
	label: string,
	description: string,
	sourceUrl: string,
	churn: Partial<BonusChurn> = {},
	verifiedAt: string | null = '2026-09-13'
): BonusChurnPreset {
	return {
		id,
		label,
		description,
		sourceUrl,
		verifiedAt,
		churn: {
			mode: 'restricted',
			conditions: [],
			requiresClosed: false,
			closedDate: null,
			manualEligibleDate: null,
			presetId: id,
			sourceUrl,
			notes: description,
			...churn
		}
	};
}

// These are offered for explicit selection. Institution names never activate a rule.
export const BONUS_CHURN_PRESETS: BonusChurnPreset[] = [
	preset(
		'wells-fargo-business-2026-09-13',
		'Wells Fargo business checking',
		'24 months after bonus payment and 90 days after closure. The bonus limit applies per business and per owner across businesses. Confirm no other Wells Fargo business checking accounts remain open and review current terms.',
		'https://accountoffers.wellsfargo.com/business-checking-bonus/',
		{
			mode: 'rules',
			conditions: [
				{ anchor: 'paidDate', months: 24, days: 0 },
				{ anchor: 'closedDate', months: 0, days: 90 }
			],
			requiresClosed: true
		}
	),
	preset(
		'us-bank-business-2026-09-13',
		'U.S. Bank business checking',
		'Current terms limit bonuses to one per business. A separate 12-month closure condition does not establish repeat eligibility after a previous bonus. No repeat date is assumed; confirm the current offer terms.',
		'https://www.usbank.com/business-banking/banking-products/business-bank-accounts/business-checking-account.html'
	),
	preset(
		'capital-one-business-2026-09-13',
		'Capital One business checking',
		'Current terms exclude applicants who are users on Capital One business checking accounts open on or after January 1, 2025. This fixed cutoff does not provide a rolling repeat date. Review the current offer terms.',
		'https://www.capitalone.com/small-business/bank/bizchecking500/'
	),
	preset(
		'bmo-business-2026-09-13',
		'BMO business checking',
		'Current terms limit cash bonuses to one per business entity. A separate 12-month account closure condition does not establish repeat eligibility after a previous bonus. No repeat date is assumed; confirm the current offer terms.',
		'https://www.bmo.com/en-us/main/business-banking/bank-accounts/bb-checking-offer/?COID=BCHK-11395L-BCHKDSC'
	),
	preset(
		'etrade-targeted-review',
		'E*TRADE targeted offer — confirm terms',
		'Targeted existing-account offers require the terms from your own offer. No repeat cooldown has been confirmed. Check the offer in your E*TRADE alerts before choosing a custom rule or review date.',
		'https://us.etrade.com/e/t/alerts/Alertinbox',
		{},
		null
	)
];

function parseDate(value: unknown): Date | null {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const [year, month, day] = value.split('-').map(Number);
	if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(0, 0, 0, 0);
	return date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
		? date
		: null;
}

export function getBonusChurnToday(now: Date = new Date()): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/Los_Angeles',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(now);
	const part = (type: Intl.DateTimeFormatPartTypes): string =>
		parts.find((item) => item.type === type)!.value;
	return `${part('year')}-${part('month')}-${part('day')}`;
}

export function formatBonusChurnDate(value: string | null | undefined): string {
	const date = parseDate(value);
	if (!date) return 'Not set';
	return new Intl.DateTimeFormat('en-US', {
		timeZone: 'UTC',
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	}).format(date);
}

export function bonusChurnStatusLabel(status: BonusChurnStatus): string {
	return {
		unconfigured: 'Not tracking',
		needs_info: 'Needs information',
		waiting: 'Cooling down',
		ready: 'Review current terms',
		restricted: 'Restricted'
	}[status];
}

function validCondition(condition: BonusChurnCondition | null | undefined): boolean {
	return Boolean(
		condition &&
		typeof condition === 'object' &&
		Object.hasOwn(ANCHOR_LABELS, condition.anchor) &&
		Number.isSafeInteger(condition.months) &&
		condition.months >= 0 &&
		condition.months <= 1_200 &&
		Number.isSafeInteger(condition.days) &&
		condition.days >= 0 &&
		condition.days <= 36_500 &&
		(condition.months > 0 || condition.days > 0)
	);
}

function conditionSummary(condition: BonusChurnCondition): string {
	const duration = [
		condition.months ? `${condition.months} month${condition.months === 1 ? '' : 's'}` : '',
		condition.days ? `${condition.days} day${condition.days === 1 ? '' : 's'}` : ''
	]
		.filter(Boolean)
		.join(' and ');
	return `${duration || '0 days'} after ${ANCHOR_LABELS[condition.anchor]}`;
}

function addCooldown(date: Date, condition: BonusChurnCondition): string | null {
	const targetMonth = date.getUTCMonth() + condition.months;
	const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
	if (targetYear > 9999) return null;
	const result = new Date(0);
	result.setUTCFullYear(targetYear, (targetMonth % 12) + 1, 0);
	const lastDay = result.getUTCDate();
	result.setUTCDate(Math.min(date.getUTCDate(), lastDay));
	result.setUTCDate(result.getUTCDate() + condition.days);
	if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() > 9999) return null;
	return result.toISOString().slice(0, 10);
}

export function bonusChurnOpenedDate(bonus: AccountBonus): string | null {
	if (bonus.churn?.openedDate != null) return bonus.churn.openedDate;
	// Existing-account offers save enrollment in bonus.openedDate, not account opening.
	if (getBonusOfferTemplate(bonus.offerTemplateId)?.startDateLabel === 'Offer enrolled')
		return null;
	return bonus.openedDate;
}

export function buildBonusChurnTracker(
	bonus: AccountBonus,
	today: string = getBonusChurnToday()
): BonusChurnTracker {
	const empty = { reviewDate: null, daysRemaining: null, missing: [] };
	const churn = bonus.churn;
	if (!churn) {
		return {
			...empty,
			status: 'unconfigured',
			ruleSummary: 'Choose how to track repeat eligibility.'
		};
	}
	if (churn.mode === 'restricted') {
		return {
			...empty,
			status: 'restricted',
			ruleSummary:
				churn.notes?.trim() ||
				'No repeat date under the saved restriction. Review the current offer terms.'
		};
	}

	const conditions = Array.isArray(churn.conditions) ? churn.conditions : [];
	const summaries = conditions.filter(validCondition).map(conditionSummary);
	const ruleSummary =
		churn.mode === 'manual'
			? 'Manually selected review date. Confirm the current offer terms before applying.'
			: `${summaries.length ? summaries.join('; ') : 'Add at least one cooldown rule'}.${churn.requiresClosed ? ' Account must be closed.' : ''} Review current offer terms before applying.`;
	const missing = new Set<string>();
	const dates: string[] = [];
	const todayDate = parseDate(today);
	if (!todayDate) missing.add('Set a valid current date.');
	if (conditions.length > 3) missing.add('Use at most three cooldown rules.');
	const anchors = new Set<BonusChurnCondition['anchor']>();
	for (const condition of conditions) {
		if (!validCondition(condition)) {
			missing.add(
				'Use a positive cooldown in whole months and days, up to 1,200 months and 36,500 days.'
			);
			continue;
		}
		if (anchors.has(condition.anchor)) missing.add('Use each date only once.');
		anchors.add(condition.anchor);
	}

	function actualDate(value: string | null, anchor: BonusChurnCondition['anchor']): Date | null {
		const date = parseDate(value);
		if (!date || (todayDate && date > todayDate)) {
			missing.add(`Record the actual ${ANCHOR_LABELS[anchor]} date.`);
			return null;
		}
		return date;
	}

	if (churn.requiresClosed) {
		const closedDate = actualDate(churn.closedDate, 'closedDate');
		if (closedDate) dates.push(closedDate.toISOString().slice(0, 10));
	}

	if (churn.mode === 'manual') {
		if (!parseDate(churn.manualEligibleDate)) missing.add('Set a valid manual review date.');
		else dates.push(churn.manualEligibleDate!);
	} else if (churn.mode === 'rules') {
		if (!conditions.length) missing.add('Add at least one cooldown rule.');
		for (const condition of conditions) {
			if (!validCondition(condition)) continue;
			const value =
				condition.anchor === 'closedDate'
					? churn.closedDate
					: condition.anchor === 'openedDate'
						? bonusChurnOpenedDate(bonus)
						: bonus.paidDate;
			const date = actualDate(value, condition.anchor);
			if (!date) continue;
			const reviewDate = addCooldown(date, condition);
			if (!reviewDate) missing.add('Choose a cooldown that ends before year 10000.');
			else dates.push(reviewDate);
		}
	} else {
		missing.add('Choose a repeat eligibility tracking method.');
	}

	if (missing.size || !dates.length || !todayDate) {
		return { ...empty, status: 'needs_info', missing: [...missing], ruleSummary };
	}
	// Every condition must pass, so the latest date controls the review window.
	const reviewDate = dates.sort().at(-1)!;
	const daysRemaining = Math.max(
		0,
		Math.round((parseDate(reviewDate)!.getTime() - todayDate.getTime()) / DAY_MS)
	);
	return {
		status: daysRemaining > 0 ? 'waiting' : 'ready',
		reviewDate,
		daysRemaining,
		missing: [],
		ruleSummary
	};
}
