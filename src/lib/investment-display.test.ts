import { describe, expect, it } from 'vitest';
import { cashSweepAction, isCashSweepSecurity } from './investment-display';

describe('cash sweep display', () => {
	it('recognizes the Chase deposit sweep by ticker or provider name', () => {
		expect(isCashSweepSecurity('QACDS', 'JPMorgan Chase Bank NA')).toBe(true);
		expect(isCashSweepSecurity(null, 'Chase Deposit Sweep JPMorgan Chase Bank NA')).toBe(true);
		expect(isCashSweepSecurity('SPY', 'SPDR S&P 500 ETF Trust')).toBe(false);
	});

	it('describes sweep redemptions as cash used and sweep deposits as cash added', () => {
		expect(cashSweepAction('sell', 'sell')).toBe('used');
		expect(cashSweepAction('cash', 'withdrawal')).toBe('used');
		expect(cashSweepAction('buy', 'buy')).toBe('added');
		expect(cashSweepAction('cash', 'deposit')).toBe('added');
		expect(cashSweepAction('cash', 'adjustment')).toBe('moved');
	});
});
