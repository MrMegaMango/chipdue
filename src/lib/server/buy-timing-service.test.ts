import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialAccount, FinancialAccountTransaction } from '$lib/types';
import { accountBuyTiming } from './buy-timing-service';
import { adjustedMarketSeries, type AdjustedMarketSeries } from './adjusted-market-history';
import { AppError } from './errors';
import { getFinancialAccount, listFinancialAccountTransactions } from './financial-records';
import { spyBenchmarkSeries } from './market-history';
import { currentTenantId, runAsTenant } from './tenant';

vi.mock('./financial-records', () => ({
	getFinancialAccount: vi.fn(),
	listFinancialAccountTransactions: vi.fn()
}));
vi.mock('./adjusted-market-history', async (original) => ({
	...(await original<typeof import('./adjusted-market-history')>()),
	adjustedMarketSeries: vi.fn()
}));
vi.mock('./market-history', () => ({ spyBenchmarkSeries: vi.fn() }));

const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001';
const NOW = '2026-08-31T22:00:00.000Z';
const DAYS = ['2026-07-01', '2026-07-15', '2026-08-03', '2026-08-14', '2026-08-31'];

function account(changes: Partial<FinancialAccount> = {}): FinancialAccount {
	return {
		id: ACCOUNT_ID,
		source: 'connected',
		nickname: 'Synthetic brokerage',
		institution: 'Synthetic institution',
		institutionLogoUrl: null,
		accountType: 'brokerage',
		ownerType: 'personal',
		status: 'active',
		hidden: false,
		last4: '1234',
		currency: 'USD',
		currentBalanceCents: 40_000,
		apyBasisPoints: null,
		apySource: null,
		apyUpdatedAt: null,
		costBasisCents: null,
		netContributionsCents: null,
		balanceHistory: [],
		holdings: [],
		transactionHistoryEnabled: true,
		transactionHistoryStatus: 'historical_complete',
		openedDate: null,
		notes: null,
		connectionId: 'synthetic-connection',
		connectionProvider: 'plaid',
		lastSyncedAt: NOW,
		createdAt: NOW,
		updatedAt: NOW,
		...changes
	};
}

function buy(
	date = '2026-07-01',
	symbol = 'AAA',
	changes: Partial<FinancialAccountTransaction> = {}
): FinancialAccountTransaction {
	return {
		id: `${date}-${symbol}`,
		name: 'Synthetic purchase',
		merchantName: symbol,
		amountCents: 10_000,
		currency: 'USD',
		date,
		authorizedDate: date,
		pending: false,
		categoryPrimary: 'INVESTMENT',
		categoryDetailed: 'buy: buy',
		investmentDetails: {
			type: 'buy',
			subtype: 'buy',
			securityName: 'Synthetic stock',
			tickerSymbol: symbol,
			quantity: 1,
			priceMicros: 100_000_000,
			feesCents: 0
		},
		...changes
	};
}

function series(symbol = 'AAA', changes: Partial<AdjustedMarketSeries> = {}): AdjustedMarketSeries {
	return {
		symbol,
		currency: 'USD',
		instrumentType: 'EQUITY',
		exchangeTimezoneName: 'America/New_York',
		prices: DAYS.map((date, index) => ({ date, adjustedClose: [100, 110, 120, 130, 150][index] })),
		fetchedAt: NOW,
		...changes
	};
}

function savedActivity(transactions = [buy(), buy('2026-08-03')], syncedAt = NOW) {
	vi.mocked(listFinancialAccountTransactions).mockResolvedValue({
		transactions,
		status: 'historical_complete',
		lastSyncedAt: syncedAt
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW));
	vi.mocked(getFinancialAccount).mockResolvedValue(account());
	savedActivity();
	vi.mocked(adjustedMarketSeries).mockResolvedValue([series()]);
	vi.mocked(spyBenchmarkSeries).mockResolvedValue({
		symbol: 'SPY',
		name: 'S&P 500 (SPY)',
		prices: DAYS.map((date) => ({ date, adjustedClose: 600 })),
		fetchedAt: NOW
	});
});

afterEach(() => vi.useRealTimers());

describe('account buy timing', () => {
	it('compares saved buys using principal after known fees, or shares times price when fees are absent', async () => {
		const first = buy('2026-07-03', 'AAA', { authorizedDate: '2026-07-01', amountCents: 10_100 });
		first.investmentDetails!.feesCents = 100;
		const second = buy('2026-08-03', 'AAA', { authorizedDate: null, amountCents: 20_000 });
		second.investmentDetails!.quantity = 2;
		second.investmentDetails!.feesCents = null;
		savedActivity([first, second]);

		const response = await accountBuyTiming(ACCOUNT_ID);

		expect(response.comparison).toMatchObject({
			status: 'available',
			totalInvestedCents: 30_000,
			actualValueCents: 40_000,
			scheduledValueCents: 41_250,
			differenceCents: -1_250
		});
		expect(response.coverage).toMatchObject({
			transactionCount: 2,
			buyCount: 2,
			includedBuyCount: 2,
			postedDateBuyCount: 1,
			excludedBuyCount: 0,
			rangeStartDate: '2026-07-01',
			rangeEndDate: '2026-08-31'
		});
		expect(listFinancialAccountTransactions).toHaveBeenCalledWith(ACCOUNT_ID, 10_000);
		expect(adjustedMarketSeries).toHaveBeenCalledWith(['AAA'], '2024-08-31', '2026-08-31');
		expect(spyBenchmarkSeries).toHaveBeenCalledWith('2024-08-31', '2026-08-31');
	});

	it('excludes pending, reinvestment, cover, cash sweeps, non-USD and known derivatives', async () => {
		const reinvestment = buy('2026-07-15');
		reinvestment.investmentDetails!.subtype = 'dividend reinvestment';
		const cover = buy('2026-07-15');
		cover.investmentDetails!.subtype = 'buy to cover';
		savedActivity([
			buy(),
			buy('2026-08-03'),
			buy('2026-07-15', 'AAA', { pending: true }),
			reinvestment,
			cover,
			buy('2026-07-15', 'QACDS'),
			buy('2026-07-15', 'CCC', { currency: 'CAD' }),
			buy('2026-07-15', 'OPT')
		]);
		vi.mocked(getFinancialAccount).mockResolvedValue(
			account({
				holdings: [
					{
						name: 'Option contract',
						tickerSymbol: 'OPT',
						securityType: 'derivative',
						quantity: 1,
						priceMicros: 100_000_000,
						valueCents: 10_000,
						costBasisCents: null,
						currency: 'USD',
						priceAsOf: '2026-08-31'
					}
				]
			})
		);
		const response = await accountBuyTiming(ACCOUNT_ID);
		expect(response.coverage).toMatchObject({
			buyCount: 8,
			includedBuyCount: 2,
			excludedBuyCount: 6,
			excludedAmountCents: 50_000
		});
		expect(response.comparison).toMatchObject({ status: 'available', totalInvestedCents: 20_000 });
		expect(adjustedMarketSeries).toHaveBeenCalledWith(['AAA'], '2024-08-31', '2026-08-31');
		expect(response.coverage.exclusions.find((item) => item.reason === 'Non-USD purchase')).toEqual(
			{
				reason: 'Non-USD purchase',
				count: 1,
				amountCents: 0
			}
		);
	});

	it('starts the schedule at the first retained buy after whole-symbol metadata exclusions', async () => {
		savedActivity([
			buy('2026-01-02', 'AAA', { pending: true }),
			buy('2026-07-01', 'BBB'),
			buy('2026-07-15'),
			buy('2026-08-14')
		]);
		vi.mocked(adjustedMarketSeries).mockResolvedValue([
			series(),
			series('BBB', { currency: 'CAD' })
		]);
		const response = await accountBuyTiming(ACCOUNT_ID);
		expect(response.coverage).toMatchObject({
			rangeStartDate: '2026-07-15',
			excludedBuyCount: 2,
			includedBuyCount: 2
		});
		expect(response.comparison).toMatchObject({
			status: 'available',
			startDate: '2026-07-15',
			scheduleDates: ['2026-07-15', '2026-08-03']
		});
	});

	it('rejects a multiplier mismatch for the whole ambiguous symbol', async () => {
		savedActivity([
			buy(),
			buy('2026-08-03'),
			buy('2026-07-15', 'OPT'),
			buy('2026-08-14', 'OPT', { amountCents: 1_000_000 })
		]);
		const response = await accountBuyTiming(ACCOUNT_ID);
		expect(response.coverage).toMatchObject({ includedBuyCount: 2, excludedBuyCount: 2 });
		expect(response.comparison).toMatchObject({ status: 'available', totalInvestedCents: 20_000 });
		expect(adjustedMarketSeries).toHaveBeenCalledWith(['AAA'], '2024-08-31', '2026-08-31');
	});

	it.each([
		{ currency: 'CAD' },
		{ instrumentType: 'CRYPTOCURRENCY' },
		{ exchangeTimezoneName: 'Europe/London' },
		{ instrumentType: null }
	])(
		'excludes every buy in an unsupported or unverified symbol from both budgets: %j',
		async (metadata) => {
			savedActivity([buy(), buy('2026-08-03'), buy('2026-07-15', 'BBB'), buy('2026-08-14', 'BBB')]);
			vi.mocked(adjustedMarketSeries).mockResolvedValue([series(), series('BBB', metadata)]);
			const response = await accountBuyTiming(ACCOUNT_ID);
			expect(response.coverage).toMatchObject({
				buyCount: 4,
				includedBuyCount: 2,
				excludedBuyCount: 2,
				excludedAmountCents: 20_000
			});
			expect(response.comparison).toMatchObject({
				status: 'available',
				totalInvestedCents: 20_000,
				securities: [{ symbol: 'AAA', budgetCents: 20_000 }]
			});
		}
	);

	it.each(['empty', 'missing-day', 'provider-failure'])(
		'blocks the comparison when an otherwise eligible symbol has %s prices',
		async (kind) => {
			savedActivity([buy(), buy('2026-08-03'), buy('2026-07-15', 'BBB')]);
			vi.mocked(adjustedMarketSeries).mockResolvedValue([
				series(),
				series('BBB', {
					prices:
						kind !== 'missing-day'
							? []
							: series('BBB').prices.filter((point) => point.date !== '2026-07-15'),
					...(kind === 'provider-failure'
						? { currency: null, instrumentType: null, exchangeTimezoneName: null }
						: {})
				})
			]);
			const response = await accountBuyTiming(ACCOUNT_ID);
			expect(response.comparison.status).toBe('unavailable');
			expect(response.coverage).toMatchObject({ includedBuyCount: 3, excludedBuyCount: 0 });
		}
	);

	it('does not roll posting-only weekend purchases to a later market day', async () => {
		savedActivity([buy(), buy('2026-08-01', 'AAA', { authorizedDate: null })]);
		const response = await accountBuyTiming(ACCOUNT_ID);
		expect(response.comparison.status).toBe('unavailable');
		expect(response.coverage.postedDateBuyCount).toBe(1);
	});

	it('anchors analysis to the last completed New York session at activity sync', async () => {
		savedActivity([buy(), buy('2026-08-03'), buy('2026-08-31')], '2026-08-31T15:00:00.000Z');
		await accountBuyTiming(ACCOUNT_ID, '3M', 'weekly');
		expect(adjustedMarketSeries).toHaveBeenCalledWith(['AAA'], '2026-05-30', '2026-08-30');
	});

	it('does not fetch price data before the tenant-scoped account lookup succeeds', async () => {
		const tenantId = '20000000-0000-4000-8000-000000000002';
		vi.mocked(getFinancialAccount).mockImplementation(async () => {
			expect(currentTenantId()).toBe(tenantId);
			throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.', 404);
		});
		await expect(runAsTenant(tenantId, () => accountBuyTiming(ACCOUNT_ID))).rejects.toMatchObject({
			code: 'ACCOUNT_NOT_FOUND'
		});
		expect(listFinancialAccountTransactions).not.toHaveBeenCalled();
		expect(adjustedMarketSeries).not.toHaveBeenCalled();
		expect(spyBenchmarkSeries).not.toHaveBeenCalled();
	});

	it.each([
		{ source: 'manual' },
		{ transactionHistoryEnabled: false },
		{ currency: 'EUR' }
	] as const)(
		'returns unavailable before loading data for unsupported accounts: %j',
		async (changes) => {
			vi.mocked(getFinancialAccount).mockResolvedValue(account(changes));
			expect((await accountBuyTiming(ACCOUNT_ID)).comparison.status).toBe('unavailable');
			expect(listFinancialAccountTransactions).not.toHaveBeenCalled();
			expect(adjustedMarketSeries).not.toHaveBeenCalled();
		}
	);

	it('does not silently truncate portfolios above the market symbol limit', async () => {
		savedActivity(
			Array.from({ length: 13 }, (_, index) =>
				buy('2026-07-01', `A${String.fromCharCode(65 + index)}`)
			)
		);
		expect((await accountBuyTiming(ACCOUNT_ID)).comparison).toMatchObject({
			status: 'unavailable',
			reason: 'too_many_symbols'
		});
		expect(adjustedMarketSeries).not.toHaveBeenCalled();
		expect(spyBenchmarkSeries).not.toHaveBeenCalled();
	});

	it('reports the saved-activity cap without presenting that history as complete', async () => {
		const unrelated = { ...buy(), investmentDetails: undefined };
		savedActivity([buy(), buy('2026-08-03'), ...Array.from({ length: 9998 }, () => unrelated)]);
		const response = await accountBuyTiming(ACCOUNT_ID);
		expect(response.coverage).toMatchObject({
			capped: true,
			transactionCount: 10_000,
			buyCount: 2
		});
	});
});
