import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerageHistoryEstimateResponse } from '$lib/types';
import { rebuildBrokerageHistory } from './brokerage-history-service';
import { resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests } from './database';
import * as etrade from './etrade';
import * as financialRecords from './financial-records';
import {
	listFinancialAccounts,
	replaceConnectedFinancialAccounts,
	updateFinancialAccount
} from './financial-records';
import { setMarketHistoryFetchForTests } from './market-history';
import { savePlaidItem } from './plaid-store';

function etradeUnavailable(
	availability: BrokerageHistoryEstimateResponse['availability']
): BrokerageHistoryEstimateResponse {
	return {
		availability,
		provider: 'etrade',
		account: null,
		estimatedPointCount: 0,
		startDate: null,
		endDate: null,
		unpricedSymbols: [],
		refreshedAt: null
	};
}

async function etradeAccountWithoutActivity(enabled = false) {
	const connectionId = await savePlaidItem('etrade-item', 'synthetic-etrade-token', 'E*TRADE');
	await replaceConnectedFinancialAccounts(
		'plaid',
		connectionId,
		[
			{
				accountId: 'etrade-account',
				nickname: 'Brokerage',
				institution: 'E*TRADE',
				institutionLogoBase64: null,
				accountType: 'brokerage',
				last4: '1234',
				currency: 'USD',
				currentBalanceCents: 10_000,
				costBasisCents: 9_000,
				holdings: [],
				transactionHistory: enabled
					? { enabled: true, cursor: null, status: 'historical_complete', transactions: [] }
					: undefined
			}
		],
		'2026-08-29T15:00:00.000Z'
	);
	return (await listFinancialAccounts())[0];
}

describe.sequential('provider-neutral brokerage history', () => {
	let temporaryDirectory: string;
	let previousDataDirectory: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-brokerage-history-'));
		process.env.CARDDUE_DATA_DIR = temporaryDirectory;
		closeDatabaseForTests();
		resetCryptoStateForTests();
		setMarketHistoryFetchForTests();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-29T16:00:00.000Z'));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		setMarketHistoryFetchForTests();
		closeDatabaseForTests();
		resetCryptoStateForTests();
		if (previousDataDirectory === undefined) delete process.env.CARDDUE_DATA_DIR;
		else process.env.CARDDUE_DATA_DIR = previousDataDirectory;
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it.each([
		{ institution: 'Chase', availability: null, contributions: null },
		{ institution: 'E*TRADE', availability: null, contributions: null },
		{ institution: 'E*TRADE', availability: 'authorization_required', contributions: null },
		{ institution: 'E*TRADE', availability: 'account_not_found', contributions: null },
		{ institution: 'E*TRADE', availability: null, contributions: 17_000 }
	] as const)(
		'builds Plaid history for $institution with optional E*TRADE status $availability and manual contributions $contributions',
		async ({ institution, availability, contributions }) => {
			if (availability) {
				vi.spyOn(etrade, 'rebuildEtradeBrokerageHistory').mockResolvedValue(
					etradeUnavailable(availability)
				);
			}
			const connectionId = await savePlaidItem(
				'provider-chase-item',
				'provider-chase-token',
				'Chase'
			);
			await replaceConnectedFinancialAccounts(
				'plaid',
				connectionId,
				[
					{
						accountId: 'provider-chase-brokerage',
						nickname: 'Self-Directed',
						institution,
						institutionLogoBase64: null,
						accountType: 'brokerage',
						last4: '3352',
						currency: 'USD',
						currentBalanceCents: 10_000,
						costBasisCents: 9_000,
						holdings: [
							{
								name: 'Synthetic equity',
								tickerSymbol: 'SYN',
								securityType: 'equity',
								quantity: 1,
								priceMicros: 100_000_000,
								valueCents: 10_000,
								costBasisCents: 9_000,
								currency: 'USD',
								priceAsOf: '2026-08-28'
							}
						],
						transactionHistory: {
							enabled: true,
							cursor: null,
							status: 'historical_complete',
							transactions: [
								{
									transactionId: 'provider-deposit',
									name: 'Cash deposit',
									merchantName: null,
									amountCents: -9_000,
									currency: 'USD',
									date: '2026-08-28',
									authorizedDate: null,
									pending: false,
									categoryPrimary: 'INVESTMENT',
									categoryDetailed: 'cash: deposit',
									investmentDetails: {
										type: 'cash',
										subtype: 'deposit',
										securityName: null,
										tickerSymbol: null,
										quantity: 0,
										priceMicros: 0,
										feesCents: null
									}
								},
								{
									transactionId: 'provider-buy',
									name: 'Bought SYN',
									merchantName: 'SYN',
									amountCents: 10_000,
									currency: 'USD',
									date: '2026-08-28',
									authorizedDate: null,
									pending: false,
									categoryPrimary: 'INVESTMENT',
									categoryDetailed: 'buy: buy',
									investmentDetails: {
										type: 'buy',
										subtype: 'buy',
										securityName: 'Synthetic equity',
										tickerSymbol: 'SYN',
										quantity: 1,
										priceMicros: 100_000_000,
										feesCents: null
									}
								}
							]
						}
					}
				],
				'2026-08-29T15:00:00.000Z'
			);
			const [account] = await listFinancialAccounts();
			if (contributions !== null) {
				await updateFinancialAccount(account.id, { netContributionsCents: contributions });
			}
			setMarketHistoryFetchForTests(
				async () =>
					new Response(
						JSON.stringify({
							chart: {
								result: [
									{
										timestamp: [
											Date.parse('2026-08-27T00:00:00Z') / 1000,
											Date.parse('2026-08-28T00:00:00Z') / 1000
										],
										indicators: { quote: [{ close: [90, 100] }] }
									}
								]
							}
						})
					)
			);

			const response = await rebuildBrokerageHistory(account.id);

			expect(response.provider).toBe('plaid');
			expect(response.availability).toBe('available');
			expect(response.estimatedPointCount).toBe(2);
			expect(response.account?.netContributionsCents).toBe(contributions);
			expect(response.account?.balanceHistory.map((point) => point.source)).toEqual(
				contributions === null
					? ['estimated', 'estimated', 'observed']
					: ['estimated', 'estimated', 'observed', 'observed']
			);
			expect(response.account?.balanceHistory.map((point) => point.netContributionsCents)).toEqual(
				contributions === null ? [1_000, 10_000, 10_000] : [8_000, 17_000, null, 17_000]
			);
		}
	);

	it('requires synced investment activity before Plaid reconstruction', async () => {
		const connectionId = await savePlaidItem(
			'provider-no-activity-item',
			'provider-no-activity-token',
			'Chase'
		);
		await replaceConnectedFinancialAccounts(
			'plaid',
			connectionId,
			[
				{
					accountId: 'provider-no-activity-account',
					nickname: 'Self-Directed',
					institution: 'Chase',
					institutionLogoBase64: null,
					accountType: 'brokerage',
					last4: '3352',
					currency: 'USD',
					currentBalanceCents: 10_000,
					costBasisCents: 9_000,
					holdings: []
				}
			],
			'2026-08-29T15:00:00.000Z'
		);
		const [account] = await listFinancialAccounts();

		await expect(rebuildBrokerageHistory(account.id)).resolves.toMatchObject({
			provider: 'plaid',
			availability: 'activity_required',
			account: null
		});
	});

	it.each([false, true])(
		'preserves the E*TRADE setup status without synced Plaid activity (enabled: %s)',
		async (enabled) => {
			const account = await etradeAccountWithoutActivity(enabled);
			const marketFetch = vi.fn();
			setMarketHistoryFetchForTests(marketFetch);

			await expect(rebuildBrokerageHistory(account.id)).resolves.toMatchObject({
				provider: 'etrade',
				availability: 'not_configured',
				account: null
			});
			expect(marketFetch).not.toHaveBeenCalled();
		}
	);

	it('prefers a successful direct E*TRADE estimate over Plaid reconstruction', async () => {
		const account = await etradeAccountWithoutActivity(true);
		const response: BrokerageHistoryEstimateResponse = {
			...etradeUnavailable('available'),
			account,
			estimatedPointCount: 200,
			startDate: '2024-08-28',
			endDate: '2026-08-28',
			refreshedAt: '2026-08-29T16:00:00.000Z'
		};
		vi.spyOn(etrade, 'rebuildEtradeBrokerageHistory').mockResolvedValue(response);
		const plaidActivity = vi.spyOn(financialRecords, 'listFinancialAccountTransactions');
		const marketFetch = vi.fn();
		setMarketHistoryFetchForTests(marketFetch);

		await expect(rebuildBrokerageHistory(account.id)).resolves.toEqual(response);
		expect(plaidActivity).not.toHaveBeenCalled();
		expect(marketFetch).not.toHaveBeenCalled();
	});

	it('does not hide a direct E*TRADE error behind the Plaid fallback', async () => {
		const account = await etradeAccountWithoutActivity(true);
		const failure = new Error('Direct E*TRADE request failed');
		vi.spyOn(etrade, 'rebuildEtradeBrokerageHistory').mockRejectedValue(failure);
		const marketFetch = vi.fn();
		setMarketHistoryFetchForTests(marketFetch);

		await expect(rebuildBrokerageHistory(account.id)).rejects.toBe(failure);
		expect(marketFetch).not.toHaveBeenCalled();
	});
});
