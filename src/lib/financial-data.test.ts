import { describe, expect, it } from 'vitest';
import { financialProviderName, normalizeTransactionHistoryStatus } from './financial-data';

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
