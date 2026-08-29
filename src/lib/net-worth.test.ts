import { describe, expect, it } from 'vitest';
import type { NetWorthAccount } from './net-worth';
import { buildNetWorthHistory } from './net-worth';

function account(overrides: Partial<NetWorthAccount> = {}): NetWorthAccount {
	return {
		id: 'account-1',
		status: 'active',
		hidden: false,
		currency: 'USD',
		currentBalanceCents: 150_000,
		balanceHistory: [
			{
				recordedAt: '2026-01-01T12:00:00.000Z',
				balanceCents: 100_000,
				netContributionsCents: null,
				source: 'observed'
			}
		],
		lastSyncedAt: '2026-02-01T12:00:00.000Z',
		updatedAt: '2026-02-01T12:00:00.000Z',
		...overrides
	};
}

describe('net worth history', () => {
	it('aggregates visible active account balances and subtracts tracked card balances', () => {
		const history = buildNetWorthHistory(
			[
				account(),
				account({
					id: 'account-2',
					currentBalanceCents: 80_000,
					balanceHistory: [
						{
							recordedAt: '2026-01-15T12:00:00.000Z',
							balanceCents: 75_000,
							netContributionsCents: null,
							source: 'observed'
						}
					]
				})
			],
			20_000
		);

		expect(history.currentAssetCents).toBe(230_000);
		expect(history.currentNetWorthCents).toBe(210_000);
		expect(history.points.map((point) => point.netWorthCents)).toEqual([155_000, 155_000, 210_000]);
		expect(history.includesEstimates).toBe(true);
	});

	it('excludes hidden, closed, and unsupported-currency accounts', () => {
		const history = buildNetWorthHistory([
			account(),
			account({ id: 'hidden', hidden: true }),
			account({ id: 'closed', status: 'closed' }),
			account({ id: 'eur', currency: 'EUR' })
		]);

		expect(history.accountCount).toBe(1);
		expect(history.excludedCurrencyCount).toBe(1);
		expect(history.currentNetWorthCents).toBe(150_000);
	});

	it('preserves estimated brokerage history markers', () => {
		const history = buildNetWorthHistory([
			account({
				balanceHistory: [
					{
						recordedAt: '2025-12-01T12:00:00.000Z',
						balanceCents: 90_000,
						netContributionsCents: 80_000,
						source: 'estimated'
					}
				]
			})
		]);

		expect(history.points[0].estimated).toBe(true);
		expect(history.points.at(-1)?.netWorthCents).toBe(150_000);
	});
});
