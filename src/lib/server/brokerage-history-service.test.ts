import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rebuildBrokerageHistory } from './brokerage-history-service';
import { resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests } from './database';
import { listFinancialAccounts, replaceConnectedFinancialAccounts } from './financial-records';
import { setMarketHistoryFetchForTests } from './market-history';
import { savePlaidItem } from './plaid-store';

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
		vi.useRealTimers();
		setMarketHistoryFetchForTests();
		closeDatabaseForTests();
		resetCryptoStateForTests();
		if (previousDataDirectory === undefined) delete process.env.CARDDUE_DATA_DIR;
		else process.env.CARDDUE_DATA_DIR = previousDataDirectory;
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('builds estimated history for a Plaid-connected Chase brokerage account', async () => {
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
					institution: 'Chase',
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
		expect(response.account?.netContributionsCents).toBeNull();
		expect(response.account?.balanceHistory.map((point) => point.source)).toEqual([
			'estimated',
			'estimated',
			'observed'
		]);
		expect(response.account?.balanceHistory.map((point) => point.netContributionsCents)).toEqual([
			1_000, 10_000, 10_000
		]);
	});

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
});
