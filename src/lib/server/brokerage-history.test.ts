import { describe, expect, it } from 'vitest';
import type { FinancialAccount } from '$lib/types';
import { reconstructBrokerageHistory } from './brokerage-history';

describe('brokerage history reconstruction', () => {
	it('values current shares at each historical close and labels every point estimated', () => {
		const account = {
			currentBalanceCents: 20_000,
			netContributionsCents: 15_000
		} as FinancialAccount;
		const result = reconstructBrokerageHistory(
			account,
			[{ symbol: 'SYN', securityType: 'EQ', quantity: 2, marketValue: 200 }],
			0,
			[],
			[
				{
					symbol: 'SYN',
					closes: new Map([
						['2026-08-27', 50],
						['2026-08-28', 100]
					])
				}
			],
			'2026-08-27',
			'2026-08-28'
		);

		expect(result.unpricedSymbols).toEqual([]);
		expect(result.contributionBasis).toBe('account');
		expect(result.currentNetContributionsCents).toBe(15_000);
		expect(result.points).toMatchObject([
			{
				recordedAt: '2026-08-27T20:00:00.000Z',
				balanceCents: 10_000,
				netContributionsCents: 15_000,
				source: 'estimated'
			},
			{
				recordedAt: '2026-08-28T20:00:00.000Z',
				balanceCents: 20_000,
				netContributionsCents: 15_000,
				source: 'estimated'
			}
		]);
	});

	it('reverses trades when walking backward', () => {
		const result = reconstructBrokerageHistory(
			{ currentBalanceCents: 10_000, netContributionsCents: null } as FinancialAccount,
			[{ symbol: 'SYN', securityType: 'EQ', quantity: 1, marketValue: 100 }],
			0,
			[
				{
					date: '2026-08-29',
					amount: -100,
					transactionType: 'Bought',
					symbol: 'SYN',
					securityType: 'EQ',
					quantity: 1
				}
			],
			[
				{
					symbol: 'SYN',
					closes: new Map([
						['2026-08-27', 90],
						['2026-08-28', 100]
					])
				}
			],
			'2026-08-27',
			'2026-08-28'
		);

		expect(result.points.map((point) => point.balanceCents)).toEqual([10_000, 10_000]);
		expect(result.points.map((point) => point.netContributionsCents)).toEqual([10_000, 10_000]);
		expect(result.currentNetContributionsCents).toBe(10_000);
		expect(result.contributionBasis).toBe('estimated_period');
	});

	it('automatically anchors period contributions and applies only external cash flows', () => {
		const result = reconstructBrokerageHistory(
			{ currentBalanceCents: 11_000, netContributionsCents: null } as FinancialAccount,
			[{ symbol: 'SYN', securityType: 'EQ', quantity: 1, marketValue: 100 }],
			10,
			[
				{
					date: '2026-08-28',
					amount: 20,
					transactionType: 'cash deposit',
					symbol: null,
					securityType: '',
					quantity: 0,
					externalCashFlow: true
				},
				{
					date: '2026-08-28',
					amount: 5,
					transactionType: 'cash dividend',
					symbol: 'SYN',
					securityType: 'EQ',
					quantity: 0,
					externalCashFlow: false
				},
				{
					date: '2026-08-29',
					amount: 10,
					transactionType: 'cash deposit',
					symbol: null,
					securityType: '',
					quantity: 0,
					externalCashFlow: true
				}
			],
			[
				{
					symbol: 'SYN',
					closes: new Map([
						['2026-08-27', 80],
						['2026-08-28', 100]
					])
				}
			],
			'2026-08-27',
			'2026-08-28'
		);

		expect(result.contributionBasis).toBe('estimated_period');
		expect(result.points.map((point) => point.netContributionsCents)).toEqual([5_500, 7_500]);
		expect(result.currentNetContributionsCents).toBe(8_500);
	});
});
