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
		expect(result.points).toMatchObject([
			{ recordedAt: '2026-08-27T20:00:00.000Z', balanceCents: 10_000, source: 'estimated' },
			{ recordedAt: '2026-08-28T20:00:00.000Z', balanceCents: 20_000, source: 'estimated' }
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
	});
});
