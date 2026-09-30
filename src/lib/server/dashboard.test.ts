import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_ACTIVITY_LIMIT } from '$lib/dashboard';
import { GET as dashboardEndpoint } from '../../routes/api/dashboard/+server';
import { GET as cardsEndpoint } from '../../routes/api/cards/+server';
import { handle } from '../../hooks.server';
import * as cards from './cards';
import {
	resetCloudDatabaseForTests,
	setCloudDatabaseAdapterForTests,
	type CloudDatabaseAdapter,
	type CloudRow
} from './cloud-database';
import { decryptJson, encryptJson, resetCryptoStateForTests } from './crypto';
import { loadDashboard } from './dashboard';
import {
	createBonus,
	createFinancialAccount,
	listBonuses,
	listFinancialAccounts
} from './financial-records';
import * as connections from './financial-connections';
import type { PrivateRecordRow } from './record-rows';
import {
	createBonusSchema,
	createFinancialAccountSchema,
	createManualCardSchema,
	updateManualCardSchema
} from './schemas';
import { runAsTenant, tenantPayloadFields, tenantReference } from './tenant';

const FIRST_TENANT = '10000000-0000-4000-8000-000000000001';
const SECOND_TENANT = '20000000-0000-4000-8000-000000000002';
const ENV_KEYS = [
	'CARDDUE_MODE',
	'DATABASE_URL',
	'CARDDUE_MASTER_KEY',
	'CARDDUE_OWNER_PASSWORD_HASH',
	'CARDDUE_AUTH_MODE',
	'CARDDUE_ALLOWED_HOSTS',
	'CARDDUE_GOOGLE_CLIENT_ID',
	'CARDDUE_GOOGLE_CLIENT_SECRET',
	'CARDDUE_GOOGLE_BOOTSTRAP_HASH',
	'CARDDUE_SESSION_TTL_HOURS',
	'PLAID_CLIENT_ID',
	'PLAID_SECRET',
	'VERCEL'
] as const;

type TestRow = PrivateRecordRow & { tenant_ref: string };

class DashboardAdapter implements CloudDatabaseAdapter {
	readonly rows = new Map<string, TestRow>();
	readonly reads: Array<{ text: string; params: unknown[] }> = [];
	failReads = false;

	async query<T extends CloudRow>(text: string, params: unknown[] = []): Promise<T[]> {
		if (text.includes('INSERT INTO public.carddue_cards')) {
			const [id, payload, now, tenantRef] = params as string[];
			this.rows.set(id, {
				id,
				source: 'manual',
				plaid_item_id: null,
				external_account_ref: null,
				payload_enc: payload,
				last_synced_at: null,
				created_at: now,
				updated_at: now,
				tenant_ref: tenantRef
			});
			return [];
		}
		if (text.includes('UPDATE public.carddue_cards')) {
			const [payload, now, tenantRef, id] = params as string[];
			const row = this.rows.get(id);
			if (!row || row.tenant_ref !== tenantRef) return [];
			Object.assign(row, { payload_enc: payload, updated_at: now });
			return [{ ...row }] as unknown as T[];
		}
		if (text.includes('FROM public.carddue_cards')) {
			this.reads.push({ text, params });
			if (this.failReads) throw new Error('private database diagnostic');
			const [tenantRef, id] = params;
			return [...this.rows.values()]
				.filter((row) => row.tenant_ref === tenantRef && (id === undefined || row.id === id))
				.map((row) => ({ ...row })) as unknown as T[];
		}
		if (
			text.includes('FROM public.carddue_metadata') ||
			text.includes('FROM public.carddue_plaid_items')
		)
			return [];
		throw new Error('Unexpected dashboard test query');
	}

	async transaction(): Promise<CloudRow[][]> {
		return [];
	}
}

function connectedCard(
	adapter: DashboardAdapter,
	id: string,
	overrides: Record<string, unknown> = {}
): TestRow {
	const payload = {
		...createManualCardSchema.parse({
			nickname: 'Synthetic rewards card',
			issuer: 'Synthetic Bank',
			last4: id.slice(-4)
		}),
		...tenantPayloadFields(),
		rewards: {
			programName: 'Synthetic Rewards',
			cashValueCents: null,
			rewardType: 'cash_back',
			baseRate: 1,
			source: 'manual',
			categories: [
				{
					id: '50000000-0000-4000-8000-000000000001',
					name: 'Groceries',
					multiplier: 3,
					matchCategory: 'groceries',
					annualSpendCapCents: 100_000
				}
			]
		},
		transactionHistory: {
			enabled: true,
			cursor: 'private-cursor',
			status: 'historical_complete',
			transactions: Array.from({ length: 501 }, (_, index) => ({
				transactionId: `private-transaction-${index}`,
				name: `Transaction ${String(index).padStart(3, '0')}`,
				merchantName: null,
				amountCents: 100,
				currency: 'USD',
				date: '2026-09-01',
				authorizedDate: null,
				pending: false,
				categoryPrimary: 'FOOD_AND_DRINK',
				categoryDetailed: 'FOOD_AND_DRINK_GROCERIES'
			}))
		},
		...overrides
	};
	const row: TestRow = {
		id,
		source: 'plaid',
		plaid_item_id: '30000000-0000-4000-8000-000000000001',
		external_account_ref: `synthetic-account-${id}`,
		payload_enc: encryptJson(payload, `card:${id}`),
		last_synced_at: '2026-09-29T16:00:00.000Z',
		created_at: '2026-09-01T16:00:00.000Z',
		updated_at: '2026-09-29T16:00:00.000Z',
		tenant_ref: tenantReference()
	};
	adapter.rows.set(id, row);
	return row;
}

async function fixture(adapter: DashboardAdapter) {
	const manual = await cards.createManualCard(
		createManualCardSchema.parse({ nickname: 'Manual card' })
	);
	const account = await createFinancialAccount(
		createFinancialAccountSchema.parse({
			nickname: 'Synthetic savings',
			accountType: 'savings',
			currentBalanceCents: 120_000
		})
	);
	await createBonus(
		createBonusSchema.parse({
			accountId: account.id,
			name: 'Opening bonus',
			requirements: [{ label: 'Deposit requirement' }]
		})
	);
	const connected = connectedCard(adapter, '40000000-0000-4000-8000-000000000001');
	return { manual, account, connected };
}

describe.sequential('dashboard shared encrypted record reads', () => {
	let adapter: DashboardAdapter;
	let previous: Record<string, string | undefined>;

	beforeEach(() => {
		previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		for (const key of ENV_KEYS) delete process.env[key];
		process.env.CARDDUE_MODE = 'cloud';
		process.env.DATABASE_URL = [
			'postgresql://carddue_runtime:synthetic-password',
			'ep-chipdue-test.us-west-2.aws.neon.tech/carddue?sslmode=require'
		].join('@');
		process.env.CARDDUE_MASTER_KEY = Buffer.alloc(32, 4).toString('base64url');
		process.env.CARDDUE_OWNER_PASSWORD_HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 2).toString('base64url')}$${Buffer.alloc(32, 3).toString('base64url')}`;
		process.env.CARDDUE_ALLOWED_HOSTS = 'cards.example.test';
		adapter = new DashboardAdapter();
		setCloudDatabaseAdapterForTests(adapter);
		resetCryptoStateForTests();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-09-29T19:00:00.000Z'));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
		resetCloudDatabaseForTests();
		resetCryptoStateForTests();
		for (const key of ENV_KEYS) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	});

	it('matches ordinary projections and full-history rewards with one tenant record query', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			const { connected } = await fixture(adapter);
			const expectedCards = await (await cardsEndpoint({} as never)).json();
			const expectedAccounts = await listFinancialAccounts();
			const expectedBonuses = await listBonuses();
			const expectedActivity = await cards.listCardTransactions(
				connected.id,
				DASHBOARD_ACTIVITY_LIMIT
			);
			adapter.reads.length = 0;
			const response = await loadDashboard({ includeActivity: true });
			expect(response.cards).toEqual({ ok: true, data: expectedCards });
			expect(response.workspace).toEqual({
				ok: true,
				data: { accounts: expectedAccounts, bonuses: expectedBonuses }
			});
			expect(response.recentActivity).toEqual({
				[connected.id]: { ok: true, data: expectedActivity }
			});
			expect(expectedActivity.transactions).toHaveLength(500);
			expect(expectedActivity.rewardCategorySpending[0].spentCents).toBe(50_100);
			expect(adapter.reads).toHaveLength(1);
			expect(adapter.reads[0].text).toContain('WHERE tenant_ref = $1');
			expect(adapter.reads[0].params).toEqual([tenantReference()]);
			const serialized = JSON.stringify(response);
			for (const privateField of [
				'payload_enc',
				'private-cursor',
				'private-transaction-',
				'tenant_ref'
			])
				expect(serialized).not.toContain(privateField);
		});
	});

	it('keeps Venmo ranked rewards identical to the full-history calculation', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			const row = connectedCard(adapter, '40000000-0000-4000-8000-000000000002', {
				rewards: {
					programName: 'Venmo Cash Back',
					cashValueCents: null,
					rewardType: 'cash_back',
					baseRate: 1,
					source: 'manual',
					calculation: 'venmo_spend_ranked',
					categories: []
				}
			});
			const expected = await cards.listCardTransactions(row.id, 500);
			const actual = await loadDashboard({ includeActivity: true });
			expect(actual.recentActivity[row.id]).toEqual({ ok: true, data: expected });
		});
	});

	it('isolates simultaneous tenants and rechecks encrypted payload ownership', async () => {
		await runAsTenant(FIRST_TENANT, () => fixture(adapter));
		await runAsTenant(SECOND_TENANT, async () => {
			await cards.createManualCard(
				createManualCardSchema.parse({ nickname: 'Second tenant only' })
			);
			const misplaced = connectedCard(adapter, '40000000-0000-4000-8000-000000000003');
			misplaced.tenant_ref = tenantReference(FIRST_TENANT);
		});
		adapter.reads.length = 0;
		const [first, second] = await Promise.all([
			runAsTenant(FIRST_TENANT, () => loadDashboard({ includeActivity: true })),
			runAsTenant(SECOND_TENANT, () => loadDashboard({ includeActivity: true }))
		]);
		expect(first.cards.ok && first.cards.data.cards).toHaveLength(2);
		expect(Object.keys(first.recentActivity)).toEqual(['40000000-0000-4000-8000-000000000001']);
		expect(second.cards).toMatchObject({
			ok: true,
			data: { cards: [{ nickname: 'Second tenant only' }] }
		});
		expect(second.workspace).toEqual({ ok: true, data: { accounts: [], bonuses: [] } });
		expect(second.recentActivity).toEqual({});
		expect(adapter.reads).toHaveLength(2);
		expect(new Set(adapter.reads.map((read) => read.params[0])).size).toBe(2);
	});

	it('loads fresh rows after mutations without retaining an earlier request snapshot', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			const { manual } = await fixture(adapter);
			const before = await loadDashboard({ includeActivity: true });
			await cards.updateManualCard(
				manual.id,
				updateManualCardSchema.parse({ nickname: 'Changed card' })
			);
			await cards.createManualCard(createManualCardSchema.parse({ nickname: 'New card' }));
			adapter.reads.length = 0;
			const after = await loadDashboard({ includeActivity: true });
			expect(
				before.cards.ok && before.cards.data.cards.find((card) => card.id === manual.id)?.nickname
			).toBe('Manual card');
			expect(
				after.cards.ok && after.cards.data.cards.find((card) => card.id === manual.id)?.nickname
			).toBe('Changed card');
			expect(after.cards.ok && after.cards.data.cards).toHaveLength(3);
			expect(adapter.reads).toHaveLength(1);
		});
	});

	it('keeps cards usable when workspace decoding fails', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			const { account } = await fixture(adapter);
			const row = adapter.rows.get(account.id)!;
			const payload = decryptJson<Record<string, unknown>>(row.payload_enc, `card:${row.id}`);
			row.payload_enc = encryptJson(
				{ ...payload, accountType: 'private-invalid-account-type' },
				`card:${row.id}`
			);
			const response = await loadDashboard({ includeActivity: true });
			expect(response.cards.ok).toBe(true);
			expect(response.workspace).toEqual({
				ok: false,
				error: { code: 'ENCRYPTED_DATA_UNREADABLE', message: 'Encrypted data could not be read.' }
			});
			expect(Object.keys(response.recentActivity)).toHaveLength(1);
			expect(JSON.stringify(response)).not.toContain('private-invalid-account-type');
		});
	});

	it('isolates card activity failures and hides unexpected diagnostics', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			const first = connectedCard(adapter, '40000000-0000-4000-8000-000000000001');
			const second = connectedCard(adapter, '40000000-0000-4000-8000-000000000002');
			const original = cards.cardTransactionsFromRow;
			vi.spyOn(cards, 'cardTransactionsFromRow').mockImplementation((row, limit) => {
				if (row.id === first.id) throw new Error('private calculation diagnostic');
				return original(row, limit);
			});
			const response = await loadDashboard({ includeActivity: true });
			expect(response.cards.ok).toBe(true);
			expect(response.recentActivity[first.id]).toEqual({
				ok: false,
				error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' }
			});
			expect(response.recentActivity[second.id].ok).toBe(true);
			expect(JSON.stringify(response)).not.toContain('private calculation diagnostic');
		});
	});

	it('keeps workspace available if connection status fails', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			await fixture(adapter);
			vi.spyOn(connections, 'financialConnectionsStatus').mockRejectedValueOnce(
				new Error('private status diagnostic')
			);
			const response = await loadDashboard({ includeActivity: true });
			expect(response.cards.ok).toBe(false);
			expect(response.workspace.ok).toBe(true);
			expect(response.recentActivity).toEqual({});
			expect(JSON.stringify(response)).not.toContain('private status diagnostic');
		});
	});

	it('does not fetch unused published APYs during dashboard loading', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			const account = await createFinancialAccount(
				createFinancialAccountSchema.parse({
					nickname: 'SoFi savings',
					institution: 'SoFi',
					accountType: 'savings'
				})
			);
			const row = adapter.rows.get(account.id)!;
			row.source = 'plaid';
			row.plaid_item_id = '30000000-0000-4000-8000-000000000001';
			row.external_account_ref = 'synthetic-savings';
			const fetch = vi.fn().mockRejectedValue(new Error('Unexpected APY fetch'));
			vi.stubGlobal('fetch', fetch);
			expect((await loadDashboard({ includeActivity: true })).workspace.ok).toBe(true);
			expect(fetch).not.toHaveBeenCalled();
		});
	});

	it('returns private no-store responses and sanitizes read failures', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			await fixture(adapter);
			const response = await dashboardEndpoint({
				url: new URL('https://cards.example.test/api/dashboard')
			} as never);
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toContain('no-store');
			expect((await response.json()).recentActivity).toEqual({});
			adapter.reads.length = 0;
			const withActivity = await dashboardEndpoint({
				url: new URL('https://cards.example.test/api/dashboard?includeActivity=1')
			} as never);
			const activity = (await withActivity.json()).recentActivity;
			expect(activity['40000000-0000-4000-8000-000000000001'].data.transactions).toHaveLength(500);
			expect(adapter.reads).toHaveLength(1);
			adapter.failReads = true;
			const failed = await dashboardEndpoint({
				url: new URL('https://cards.example.test/api/dashboard')
			} as never);
			expect(failed.status).toBe(503);
			expect(await failed.json()).toEqual({
				error: { code: 'DATABASE_UNAVAILABLE', message: 'Encrypted cloud storage is unavailable.' }
			});
		});
	});

	it('requires authentication before the new endpoint can load rows', async () => {
		const request = new Request('https://cards.example.test/api/dashboard', {
			headers: { host: 'cards.example.test' }
		});
		const resolve = vi.fn(() => new Response('unexpected'));
		const response = await handle({
			event: {
				request,
				url: new URL(request.url),
				route: { id: '/api/dashboard' },
				cookies: { get: () => undefined }
			} as never,
			resolve: resolve as never
		});
		expect(response.status).toBe(401);
		expect(resolve).not.toHaveBeenCalled();
		expect(adapter.reads).toHaveLength(0);
	});
});
