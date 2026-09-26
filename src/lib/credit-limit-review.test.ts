import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardCreditLimitReview } from './types';
import { creditLimitReviewStatus } from './credit-limit-review';

function review(reviewDate: string): CardCreditLimitReview {
	return { reviewDate, dateSource: 'estimated', notes: null };
}

afterEach(() => vi.useRealTimers());

describe('credit limit review timing', () => {
	it('shows a future review countdown without implying approval', () => {
		expect(creditLimitReviewStatus(review('2031-08-16'), '2031-08-04')).toEqual({
			daysUntil: 12,
			label: 'Review in 12 days',
			due: false
		});
		expect(creditLimitReviewStatus(review('2031-08-05'), '2031-08-04').label).toBe(
			'Review in 1 day'
		);
	});

	it('marks today and past dates as due for review', () => {
		expect(creditLimitReviewStatus(review('2031-08-04'), '2031-08-04')).toEqual({
			daysUntil: 0,
			label: 'Review today',
			due: true
		});
		expect(creditLimitReviewStatus(review('2031-08-01'), '2031-08-04')).toEqual({
			daysUntil: -3,
			label: 'Review available',
			due: true
		});
	});

	it.each([
		['2031-08-04', '2031-08-04T06:59:59.000Z', '2031-08-04T07:00:00.000Z'],
		['2031-01-04', '2031-01-04T07:59:59.000Z', '2031-01-04T08:00:00.000Z']
	])('waits for Pacific midnight on %s rather than UTC midnight', (date, before, midnight) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(before));
		expect(creditLimitReviewStatus(review(date))).toEqual({
			daysUntil: 1,
			label: 'Review in 1 day',
			due: false
		});
		vi.setSystemTime(new Date(midnight));
		expect(creditLimitReviewStatus(review(date))).toEqual({
			daysUntil: 0,
			label: 'Review today',
			due: true
		});
	});

	it.each([
		['2031-03-08', '2031-03-10'],
		['2031-11-01', '2031-11-03'],
		['2032-02-28', '2032-03-01']
	])('counts calendar days from %s to %s across clock and month changes', (today, date) => {
		expect(creditLimitReviewStatus(review(date), today).daysUntil).toBe(2);
	});
});
