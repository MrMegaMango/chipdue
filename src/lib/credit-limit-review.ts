import type { CardCreditLimitReview } from './types';
import { getBonusChurnToday } from './bonus-churn';

const DAY_MS = 86_400_000;

export function creditLimitReviewStatus(
	review: CardCreditLimitReview,
	today = getBonusChurnToday()
): { daysUntil: number; label: string; due: boolean } {
	const daysUntil = Math.round(
		(Date.parse(`${review.reviewDate}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) /
			DAY_MS
	);
	return {
		daysUntil,
		label:
			daysUntil < 0
				? 'Review available'
				: daysUntil === 0
					? 'Review today'
					: `Review in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`,
		due: daysUntil <= 0
	};
}
