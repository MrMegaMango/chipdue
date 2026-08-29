import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FinancialAccount } from '$lib/types';
import { addPublishedAccountApys, resetPublishedApyCacheForTests } from './published-apy';

function connectedAccount(
	id: string,
	nickname: string,
	institution: string,
	accountType: FinancialAccount['accountType']
): FinancialAccount {
	return {
		id,
		source: 'connected',
		nickname,
		institution,
		institutionLogoUrl: null,
		accountType,
		ownerType: 'personal',
		status: 'active',
		hidden: false,
		last4: '1234',
		currency: 'USD',
		currentBalanceCents: 100_000,
		apyBasisPoints: null,
		apySource: null,
		apyUpdatedAt: null,
		costBasisCents: null,
		netContributionsCents: null,
		balanceHistory: [],
		holdings: [],
		transactionHistoryEnabled: true,
		transactionHistoryStatus: 'current',
		openedDate: null,
		notes: null,
		connectionId: 'connection-1',
		connectionProvider: 'plaid',
		lastSyncedAt: '2026-08-29T20:54:00.000Z',
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-29T20:54:00.000Z'
	};
}

describe('published account APYs', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
		resetPublishedApyCacheForTests();
	});

	it('fills rates that Plaid omits from official institution pages', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-29T21:00:00.000Z'));
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes('sofi.com')) {
				return new Response('<h3>High-Yield APY</h3><p class="apy">3.10% <span>APY</span></p>');
			}
			if (url.includes('viobank.com')) {
				return new Response(
					'<header>Online Savings</header><div class="featured-product-card__rate js-rate-target">3.99</div>'
				);
			}
			return new Response('After that, you will earn the base 3.30% APY.');
		});
		vi.stubGlobal('fetch', fetchMock);

		const accounts = [
			connectedAccount('sofi', 'SoFi Savings', 'SoFi', 'savings'),
			connectedAccount('vio', 'ONLINE SAVINGS', 'Vio Bank - Personal', 'savings'),
			connectedAccount('wealthfront', 'Individual Cash Account', 'Wealthfront', 'cash_management')
		];
		const first = await addPublishedAccountApys(accounts);

		expect(first).toMatchObject([
			{ id: 'sofi', apyBasisPoints: 310, apySource: 'published' },
			{ id: 'vio', apyBasisPoints: 399, apySource: 'published' },
			{ id: 'wealthfront', apyBasisPoints: 330, apySource: 'published' }
		]);
		expect(first.every((account) => account.apyUpdatedAt === '2026-08-29T21:00:00.000Z')).toBe(
			true
		);
		expect(fetchMock).toHaveBeenCalledTimes(3);

		await addPublishedAccountApys(accounts);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('keeps provider APYs authoritative and leaves unknown institutions unchanged', async () => {
		const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
		vi.stubGlobal('fetch', fetchMock);
		const providerAccount = {
			...connectedAccount('provider', 'SoFi Savings', 'SoFi', 'savings'),
			apyBasisPoints: 450,
			apySource: 'provider' as const,
			apyUpdatedAt: '2026-08-29T20:54:00.000Z'
		};
		const unknownAccount = connectedAccount('unknown', 'Savings', 'Example Bank', 'savings');

		await expect(addPublishedAccountApys([providerAccount, unknownAccount])).resolves.toEqual([
			providerAccount,
			unknownAccount
		]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('retains an existing fallback when a published page is unavailable', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 503 }))
		);
		const account = {
			...connectedAccount('sofi', 'SoFi Savings', 'SoFi', 'savings'),
			apyBasisPoints: 300,
			apySource: 'manual' as const,
			apyUpdatedAt: '2026-08-01T00:00:00.000Z'
		};

		await expect(addPublishedAccountApys([account])).resolves.toEqual([account]);
	});
});
