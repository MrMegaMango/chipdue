import { describe, expect, it } from 'vitest';
import { cardDowngradeTiming as resolveTiming } from './card-downgrade';

const cardDowngradeTiming = (bonus: Parameters<typeof resolveTiming>[0]) =>
	resolveTiming(bonus, '2028-01-01');

describe('card downgrade timing', () => {
	it('does not turn a saved bonus hold date into a fee deadline', () => {
		const timing = cardDowngradeTiming({ safeToCloseDate: '2028-04-18' });
		expect(timing.deadline).toBeNull();
		expect(timing.earliest).toBe('2028-04-18');
		expect(timing.message).toContain('not confirmed');
	});

	it('keeps the issuer-confirmed latest date separate from the hold date', () => {
		const dates = { safeToCloseDate: '2028-04-18', feeFreeDowngradeDate: '2028-05-02' };
		expect(cardDowngradeTiming(dates)).toMatchObject({
			deadline: '2028-05-02',
			earliest: '2028-04-18',
			conflict: false
		});
		expect(dates.safeToCloseDate).toBe('2028-04-18');
	});

	it('flags a fee deadline before the bonus hold ends', () => {
		const timing = cardDowngradeTiming({
			safeToCloseDate: '2028-04-18',
			feeFreeDowngradeDate: '2028-04-17'
		});
		expect(timing.conflict).toBe(true);
		expect(timing.message).toContain('No fee-free window');
	});

	it('allows an issuer-confirmed deadline on the saved earliest date', () => {
		expect(
			cardDowngradeTiming({
				safeToCloseDate: '2028-02-29',
				feeFreeDowngradeDate: '2028-02-29'
			}).conflict
		).toBe(false);
	});

	it('expires at midnight Pacific without advancing the saved deadline', () => {
		const dates = { safeToCloseDate: '2028-04-18', feeFreeDowngradeDate: '2028-05-02' };
		expect(resolveTiming(dates, '2028-05-02').expired).toBe(false);
		expect(resolveTiming(dates, '2028-05-03')).toMatchObject({
			expired: true,
			deadline: '2028-05-02'
		});
	});

	it('does not promise bonus protection when the hold date is missing', () => {
		const timing = cardDowngradeTiming({
			safeToCloseDate: null,
			feeFreeDowngradeDate: '2028-05-02'
		});
		expect(timing.deadline).toBe('2028-05-02');
		expect(timing.message).toContain('bonus hold date is missing');
	});
});
