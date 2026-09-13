import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionHistoryStatus } from '$lib/types';
import { GET } from '../../routes/api/bonuses/tracking/+server';
import { listAutomaticBonusTracking } from './bonus-churn-tracking';
import { listCards, replaceConnectedCards, type StoredFinancialTransaction } from './cards';
import { resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests, getDatabase } from './database';
import * as financialRecords from './financial-records';
import {
	createBonus,
	getBonus,
	listFinancialAccounts,
	listFinancialAccountTransactions,
	replaceConnectedFinancialAccounts,
	updateFinancialAccount,
	type ConnectedFinancialAccountSnapshot
} from './financial-records';
import { savePlaidItem } from './plaid-store';
import { createBonusSchema, type CreateBonusData } from './schemas';
import { runAsTenant } from './tenant';

const FIRST_TENANT = '10000000-0000-4000-8000-000000000001';
const SECOND_TENANT = '20000000-0000-4000-8000-000000000002';
const EMPTY_TENANT = '30000000-0000-4000-8000-000000000003';
const NOW = '2026-09-13T19:00:00.000Z';
const WELLS_OFFER = 'wells-fargo-business-checking-2026-09-08';

function payout(overrides: Partial<StoredFinancialTransaction> = {}): StoredFinancialTransaction {
	return {
		transactionId: 'synthetic-bonus-credit',
		name: 'WELLS FARGO BUSINESS CHECKING BONUS',
		merchantName: null,
		amountCents: -82_500,
		currency: 'USD',
		date: '2026-08-01',
		authorizedDate: null,
		pending: false,
		categoryPrimary: 'INCOME',
		categoryDetailed: 'INCOME_OTHER_INCOME',
		...overrides
	};
}

function ordinaryExpense(index: number): StoredFinancialTransaction {
	return payout({
		transactionId: `synthetic-expense-${index}`,
		name: `Synthetic office supplies ${index}`,
		amountCents: 1_200 + index,
		date: '2026-09-12',
		categoryPrimary: 'GENERAL_MERCHANDISE',
		categoryDetailed: 'GENERAL_MERCHANDISE_OFFICE_SUPPLIES'
	});
}

async function connectedBusiness(
	key: string,
	transactions: StoredFinancialTransaction[] = [],
	status: TransactionHistoryStatus = 'historical_complete'
) {
	const connectionId = await savePlaidItem(
		`synthetic-item-${key}`,
		`synthetic-provider-token-${key}`,
		'Wells Fargo'
	);
	const snapshot: ConnectedFinancialAccountSnapshot = {
		accountId: `synthetic-provider-account-${key}`,
		nickname: `Synthetic business checking ${key}`,
		institution: 'Wells Fargo',
		institutionLogoBase64: null,
		accountType: 'checking',
		last4: '1234',
		currency: 'USD',
		currentBalanceCents: 2_582_500,
		costBasisCents: null,
		holdings: null
	};
	async function sync(
		nextTransactions: StoredFinancialTransaction[],
		nextStatus: TransactionHistoryStatus = 'historical_complete',
		syncedAt = NOW
	) {
		await replaceConnectedFinancialAccounts(
			'plaid',
			connectionId,
			[
				{
					...snapshot,
					transactionHistory: {
						enabled: true,
						cursor: `synthetic-cursor-${key}`,
						status: nextStatus,
						transactions: nextTransactions
					}
				}
			],
			syncedAt
		);
	}
	await sync(transactions, status);
	const account = (await listFinancialAccounts()).find(
		(candidate) => candidate.connectionId === connectionId
	)!;
	await updateFinancialAccount(account.id, { ownerType: 'business', openedDate: '2026-05-01' });
	return { accountId: account.id, connectionId, sync };
}

function wellsBonus(accountId: string, overrides: Partial<CreateBonusData> = {}) {
	return createBonus(
		createBonusSchema.parse({
			accountId,
			offerTemplateId: WELLS_OFFER,
			name: 'Synthetic Wells Fargo business checking bonus',
			institution: 'Wells Fargo',
			rewardCents: 82_500,
			openedDate: '2026-05-01',
			status: 'pending',
			...overrides
		})
	);
}

async function connectedUpgradeCard(key: string) {
	const connectionId = await savePlaidItem(
		`synthetic-card-item-${key}`,
		`synthetic-card-token-${key}`,
		'American Express'
	);
	await replaceConnectedCards(
		'plaid',
		connectionId,
		[
			{
				accountId: `synthetic-provider-card-${key}`,
				nickname: 'Synthetic Blue Cash Preferred Card',
				issuer: 'American Express',
				last4: '4321',
				currency: 'USD',
				statementBalanceCents: 25_000,
				minimumPaymentCents: 4_000,
				currentBalanceCents: 20_000,
				dueDate: '2026-09-25',
				statementDate: '2026-08-31',
				isOverdue: false,
				autopayEnabled: false,
				transactionHistory: {
					enabled: true,
					cursor: `synthetic-card-cursor-${key}`,
					status: 'current',
					transactions: [
						payout({
							transactionId: `synthetic-upgrade-credit-${key}`,
							name: 'AMERICAN EXPRESS UPGRADE BONUS',
							amountCents: -15_000,
							date: '2026-08-20'
						})
					]
				}
			}
		],
		NOW
	);
	return (await listCards()).find((card) => card.connectionId === connectionId)!;
}

function persistedState() {
	const database = getDatabase();
	return {
		cards: database.prepare('SELECT * FROM cards ORDER BY id').all(),
		connections: database.prepare('SELECT * FROM plaid_items ORDER BY id').all(),
		metadata: database.prepare('SELECT * FROM metadata ORDER BY key').all()
	};
}

async function getTracking() {
	const request = new Request('http://localhost/api/bonuses/tracking');
	return (await GET({ request, url: new URL(request.url) } as never)) as Response;
}

describe.sequential('automatic bonus tracking from encrypted stored history', () => {
	let temporaryDirectory: string;
	let network: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-bonus-churn-tracking-'));
		vi.stubEnv('CARDDUE_DATA_DIR', temporaryDirectory);
		vi.stubEnv('CARDDUE_MASTER_KEY_PATH', join(temporaryDirectory, 'master.key'));
		vi.stubEnv('CARDDUE_MODE', 'local');
		vi.stubEnv('DATABASE_URL', '');
		vi.stubEnv('VERCEL', '');
		closeDatabaseForTests();
		resetCryptoStateForTests();
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		network = vi.fn(() => {
			throw new Error('Tracking must use stored activity without contacting a provider.');
		});
		vi.stubGlobal('fetch', network);
	});

	afterEach(() => {
		expect(network).not.toHaveBeenCalled();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		closeDatabaseForTests();
		resetCryptoStateForTests();
		vi.unstubAllEnvs();
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('matches an accepted offer and finds its payout beyond the 500-transaction activity preview', async () => {
		const { accountId } = await connectedBusiness('long-history', [
			payout(),
			...Array.from({ length: 501 }, (_, index) => ordinaryExpense(index))
		]);
		const bonus = await wellsBonus(accountId);
		const preview = await listFinancialAccountTransactions(accountId);
		expect(preview.transactions).toHaveLength(500);
		expect(preview.transactions.every((transaction) => transaction.amountCents > 0)).toBe(true);

		const result = (await listAutomaticBonusTracking())[bonus.id];
		expect(result).toMatchObject({
			ruleSource: 'automatic',
			effectiveRule: { presetId: 'wells-fargo-business-2026-09-13', mode: 'rules' },
			paidDate: '2026-08-01',
			dateSources: { paidDate: 'transaction' },
			checkedAt: NOW,
			ruleVerifiedAt: '2026-09-13'
		});
		expect(await getBonus(bonus.id)).toEqual(bonus);
	});

	it('GET returns private tracking without writing inferred dates, terms, or raw provider data', async () => {
		const { accountId } = await connectedBusiness('read-only', [payout()]);
		const bonus = await wellsBonus(accountId);
		const before = persistedState();
		expect(JSON.stringify(before)).not.toContain('WELLS FARGO BUSINESS CHECKING BONUS');
		expect(JSON.stringify(before)).not.toContain('synthetic-provider-token-read-only');

		const response = await getTracking();
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(response.headers.get('pragma')).toBe('no-cache');
		const body = await response.json();
		expect(body).toMatchObject({
			tracking: { [bonus.id]: { ruleSource: 'automatic', paidDate: '2026-08-01' } }
		});
		expect(body.tracking[bonus.id]).not.toHaveProperty('transactions');
		expect(JSON.stringify(body)).not.toContain('synthetic-provider-token-read-only');
		expect(JSON.stringify(body)).not.toContain('synthetic-cursor-read-only');
		expect(persistedState()).toEqual(before);
		expect(await getBonus(bonus.id)).toEqual(bonus);
	});

	it('uses the next stored sync automatically while leaving the saved bonus untouched', async () => {
		const { accountId, sync } = await connectedBusiness('resync', [payout({ pending: true })]);
		const bonus = await wellsBonus(accountId);
		expect((await listAutomaticBonusTracking())[bonus.id]).toMatchObject({
			ruleSource: 'automatic',
			paidDate: null,
			dateSources: { paidDate: null }
		});

		vi.setSystemTime(new Date('2026-09-13T19:05:00.000Z'));
		await sync([payout({ date: '2026-08-02' })], 'current', '2026-09-13T19:05:00.000Z');
		expect((await listAutomaticBonusTracking())[bonus.id]).toMatchObject({
			paidDate: '2026-08-02',
			dateSources: { paidDate: 'transaction' },
			checkedAt: '2026-09-13T19:05:00.000Z'
		});
		expect(await getBonus(bonus.id)).toEqual(bonus);
	});

	it('keeps explicit dates and a manual review rule ahead of new connected evidence', async () => {
		const { accountId } = await connectedBusiness('override', [payout()]);
		const bonus = await wellsBonus(accountId, {
			paidDate: '2026-08-05',
			churn: createBonusSchema.parse({
				name: 'Unused schema defaults',
				churn: { mode: 'manual', manualEligibleDate: '2029-04-15' }
			}).churn
		});
		const result = (await listAutomaticBonusTracking())[bonus.id];
		expect(result).toMatchObject({
			ruleSource: 'saved',
			effectiveRule: { mode: 'manual', manualEligibleDate: '2029-04-15' },
			paidDate: '2026-08-05',
			dateSources: { paidDate: 'saved' },
			tracker: { reviewDate: '2029-04-15' }
		});
		expect(await getBonus(bonus.id)).toEqual(bonus);
	});

	it('does not assign one posted credit to two overlapping saved bonuses', async () => {
		const { accountId } = await connectedBusiness('shared-credit', [payout()]);
		const first = await wellsBonus(accountId);
		const second = await wellsBonus(accountId, {
			name: 'Synthetic second offer with overlapping dates',
			openedDate: '2026-05-10'
		});
		const tracking = await listAutomaticBonusTracking();
		for (const bonus of [first, second]) {
			expect(tracking[bonus.id]).toMatchObject({
				ruleSource: 'automatic',
				paidDate: null,
				dateSources: { paidDate: null },
				payoutTransactionId: null,
				statusLabel: 'Payout review required'
			});
			expect(await getBonus(bonus.id)).toEqual(bonus);
		}
	});

	it('reserves a credit already identified by a saved payment date for that bonus', async () => {
		const { accountId } = await connectedBusiness('saved-credit', [payout()]);
		const paid = await wellsBonus(accountId, { paidDate: '2026-08-01', status: 'paid' });
		const unpaid = await wellsBonus(accountId, {
			name: 'Synthetic unpaid offer with overlapping dates',
			openedDate: '2026-05-10'
		});
		const tracking = await listAutomaticBonusTracking();

		expect(tracking[paid.id]).toMatchObject({
			paidDate: '2026-08-01',
			dateSources: { paidDate: 'saved' }
		});
		expect(tracking[unpaid.id]).toMatchObject({
			paidDate: null,
			dateSources: { paidDate: null },
			payoutTransactionId: null,
			statusLabel: 'Payout review required'
		});
		expect(await getBonus(paid.id)).toEqual(paid);
		expect(await getBonus(unpaid.id)).toEqual(unpaid);
	});

	it.each([
		['unknown', null],
		['preparing', null],
		['current', '2026-08-01'],
		['historical_complete', '2026-08-01']
	] as const)('respects the stored %s activity status', async (status, paidDate) => {
		const { accountId } = await connectedBusiness(status, [payout()], status);
		const bonus = await wellsBonus(accountId);
		expect((await listAutomaticBonusTracking())[bonus.id]).toMatchObject({
			ruleSource: 'automatic',
			paidDate,
			dateSources: { paidDate: paidDate ? 'transaction' : null }
		});
	});

	it('isolates unavailable history so another account still resolves in the same GET', async () => {
		const unavailable = await connectedBusiness('unavailable', [payout()]);
		const healthy = await connectedBusiness('healthy', [payout()]);
		const unavailableBonus = await wellsBonus(unavailable.accountId);
		const healthyBonus = await wellsBonus(healthy.accountId);
		const readHistory = financialRecords.listFinancialAccountTransactions;
		vi.spyOn(financialRecords, 'listFinancialAccountTransactions').mockImplementation(
			async (accountId, limit) => {
				if (accountId === unavailable.accountId) throw new Error('Synthetic history unavailable');
				return readHistory(accountId, limit);
			}
		);

		const response = await getTracking();
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			tracking: {
				[unavailableBonus.id]: { paidDate: null, dateSources: { paidDate: null } },
				[healthyBonus.id]: { paidDate: '2026-08-01', dateSources: { paidDate: 'transaction' } }
			}
		});
	});

	it('scopes inventory, linked history, and API results to the current tenant', async () => {
		const foreign = await runAsTenant(SECOND_TENANT, async () => {
			const { accountId } = await connectedBusiness('shared-provider-id', [
				payout({ date: '2026-08-09' })
			]);
			const bonus = await wellsBonus(accountId, { name: 'Synthetic other tenant bonus' });
			const card = await connectedUpgradeCard('foreign');
			return { accountId, bonusId: bonus.id, cardId: card.id };
		});
		await runAsTenant(FIRST_TENANT, async () => {
			const { accountId } = await connectedBusiness('shared-provider-id', [payout()]);
			const ownBonus = await wellsBonus(accountId);
			const foreignAccountLink = await wellsBonus(foreign.accountId);
			const foreignCardLink = await createBonus(
				createBonusSchema.parse({
					cardId: foreign.cardId,
					name: 'Synthetic Blue Cash Preferred upgrade bonus',
					institution: 'American Express',
					rewardCents: 15_000,
					openedDate: '2026-07-01'
				})
			);
			const historySpy = vi.spyOn(financialRecords, 'listFinancialAccountTransactions');
			const response = await getTracking();
			const body = await response.json();
			expect(response.status).toBe(200);
			expect(Object.keys(body.tracking).sort()).toEqual(
				[ownBonus.id, foreignAccountLink.id, foreignCardLink.id].sort()
			);
			expect(body.tracking[ownBonus.id].paidDate).toBe('2026-08-01');
			for (const linkedBonus of [foreignAccountLink, foreignCardLink]) {
				expect(body.tracking[linkedBonus.id]).toMatchObject({
					paidDate: null,
					dateSources: { paidDate: null }
				});
			}
			expect(body.tracking).not.toHaveProperty(foreign.bonusId);
			expect(historySpy.mock.calls.map(([id]) => id)).not.toContain(foreign.accountId);
		});
		await runAsTenant(EMPTY_TENANT, async () => {
			expect(await listAutomaticBonusTracking()).toEqual({});
		});
	});

	it('reads connected card history for an upgrade payout without inventing a repeat date', async () => {
		const card = await connectedUpgradeCard('own');
		const bonus = await createBonus(
			createBonusSchema.parse({
				cardId: card.id,
				name: 'Synthetic Blue Cash Preferred upgrade bonus',
				institution: 'American Express',
				rewardCents: 15_000,
				openedDate: '2026-07-01'
			})
		);
		expect((await listAutomaticBonusTracking())[bonus.id]).toMatchObject({
			ruleSource: 'unmatched',
			effectiveRule: null,
			paidDate: '2026-08-20',
			dateSources: { paidDate: 'transaction' },
			tracker: { reviewDate: null },
			statusLabel: 'Offer-specific terms'
		});
		expect(await getBonus(bonus.id)).toEqual(bonus);
	});
});
