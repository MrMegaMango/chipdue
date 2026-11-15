import { describe, expect, it } from 'vitest';
import {
	financialProviderName,
	normalizeTransactionHistoryStatus,
	sumMoneyByCurrency
} from './financial-data';

describe('money totals by currency', () => {
	it('sums balances within each currency without treating foreign balances as dollars', () => {
		expect(
			sumMoneyByCurrency([
				{ currency: 'GBP', amountCents: 200_000 },
				{ currency: 'USD', amountCents: 350_000 },
				{ currency: 'GBP', amountCents: 25_000 },
				{ currency: 'EUR', amountCents: 70_000 },
				{ currency: 'USD', amountCents: 50_000 }
			])
		).toEqual([
			{ currency: 'USD', amountCents: 400_000 },
			{ currency: 'EUR', amountCents: 70_000 },
			{ currency: 'GBP', amountCents: 225_000 }
		]);
	});

	it('keeps investment losses and known zero totals while omitting unknown amounts', () => {
		expect(
			sumMoneyByCurrency([
				{ currency: 'USD', amountCents: null },
				{ currency: 'GBP', amountCents: -15_000 },
				{ currency: 'GBP', amountCents: 5_000 },
				{ currency: 'EUR', amountCents: 10_000 },
				{ currency: 'EUR', amountCents: -10_000 }
			])
		).toEqual([
			{ currency: 'EUR', amountCents: 0 },
			{ currency: 'GBP', amountCents: -10_000 }
		]);
		expect(sumMoneyByCurrency([])).toEqual([]);
		expect(sumMoneyByCurrency([{ currency: 'USD', amountCents: null }])).toEqual([]);
	});

	it('preserves single-currency totals', () => {
		expect(
			sumMoneyByCurrency([
				{ currency: 'USD', amountCents: 120_000 },
				{ currency: 'USD', amountCents: -20_000 }
			])
		).toEqual([{ currency: 'USD', amountCents: 100_000 }]);
	});
});

describe('financial data provider boundary', () => {
	it('keeps provider display names out of the domain model', () => {
		expect(financialProviderName('plaid')).toBe('Plaid');
		expect(financialProviderName(null)).toBe('Connected provider');
	});

	it.each([
		['TRANSACTIONS_UPDATE_STATUS_UNKNOWN', 'unknown'],
		['NOT_READY', 'preparing'],
		['INITIAL_UPDATE_COMPLETE', 'current'],
		['HISTORICAL_UPDATE_COMPLETE', 'historical_complete'],
		['current', 'current']
	] as const)('normalizes stored status %s to %s', (stored, expected) => {
		expect(normalizeTransactionHistoryStatus(stored)).toBe(expected);
	});
});
