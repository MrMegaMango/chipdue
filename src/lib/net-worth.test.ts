import { describe, expect, it } from 'vitest';
import type { NetWorthAccount } from './net-worth';
import { buildNetWorthHistory, netWorthDateAxisTicks, netWorthPointsForRange } from './net-worth';

function account(overrides: Partial<NetWorthAccount> = {}): NetWorthAccount {
	return {
		id: 'account-1',
		nickname: 'Primary account',
		accountType: 'checking',
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
	it('supports a one-week view anchored to the latest history date', () => {
		const history = buildNetWorthHistory([
			account({
				balanceHistory: [
					{
						recordedAt: '2026-01-01T12:00:00.000Z',
						balanceCents: 100_000,
						netContributionsCents: null,
						source: 'observed'
					},
					{
						recordedAt: '2026-01-03T12:00:00.000Z',
						balanceCents: 120_000,
						netContributionsCents: null,
						source: 'observed'
					}
				],
				lastSyncedAt: '2026-01-10T12:00:00.000Z',
				updatedAt: '2026-01-10T12:00:00.000Z'
			})
		]);

		expect(
			netWorthPointsForRange(history.points, '1W').map((point) => point.recordedAt.slice(0, 10))
		).toEqual(['2026-01-03', '2026-01-10']);
	});

	it('builds evenly spaced date-axis ticks with unambiguous endpoints', () => {
		const history = buildNetWorthHistory([
			account({
				balanceHistory: [
					{
						recordedAt: '2025-08-29T12:00:00.000Z',
						balanceCents: 100_000,
						netContributionsCents: null,
						source: 'observed'
					}
				],
				lastSyncedAt: '2026-08-29T12:00:00.000Z',
				updatedAt: '2026-08-29T12:00:00.000Z'
			})
		]);

		const ticks = netWorthDateAxisTicks(history.points);
		expect(ticks).toHaveLength(5);
		expect(ticks.map((tick) => tick.position)).toEqual([0, 0.25, 0.5, 0.75, 1]);
		expect(ticks[0].recordedAt).toBe('2025-08-29T12:00:00.000Z');
		expect(ticks.at(-1)?.recordedAt).toBe('2026-08-29T12:00:00.000Z');
	});

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

	it('provides per-account balances and changes for every date', () => {
		const history = buildNetWorthHistory(
			[
				account({
					nickname: 'Checking',
					currentBalanceCents: 110_000,
					balanceHistory: [
						{
							recordedAt: '2026-06-02T12:00:00.000Z',
							balanceCents: 100_000,
							netContributionsCents: null,
							source: 'observed'
						},
						{
							recordedAt: '2026-06-03T12:00:00.000Z',
							balanceCents: 110_000,
							netContributionsCents: null,
							source: 'observed'
						}
					],
					lastSyncedAt: '2026-06-04T12:00:00.000Z',
					updatedAt: '2026-06-04T12:00:00.000Z'
				}),
				account({
					id: 'account-2',
					nickname: 'Brokerage',
					accountType: 'brokerage',
					currentBalanceCents: 45_000,
					balanceHistory: [
						{
							recordedAt: '2026-06-02T12:00:00.000Z',
							balanceCents: 50_000,
							netContributionsCents: 40_000,
							source: 'estimated'
						},
						{
							recordedAt: '2026-06-03T12:00:00.000Z',
							balanceCents: 45_000,
							netContributionsCents: 40_000,
							source: 'estimated'
						}
					],
					lastSyncedAt: '2026-06-04T12:00:00.000Z',
					updatedAt: '2026-06-04T12:00:00.000Z'
				})
			],
			2_000
		);

		const juneThird = history.points.find((point) => point.recordedAt.startsWith('2026-06-03'));
		expect(juneThird).toMatchObject({
			assetCents: 155_000,
			netWorthCents: 153_000,
			changeCents: 5_000,
			estimated: true
		});
		expect(juneThird?.accounts).toEqual([
			expect.objectContaining({
				accountId: 'account-1',
				nickname: 'Checking',
				balanceCents: 110_000,
				changeCents: 10_000,
				estimated: false,
				backfilled: false
			}),
			expect.objectContaining({
				accountId: 'account-2',
				nickname: 'Brokerage',
				balanceCents: 45_000,
				changeCents: -5_000,
				estimated: true,
				backfilled: false
			})
		]);
	});
});
