import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATCH } from '../../routes/api/connections/[id]/+server';
import {
	resetCloudDatabaseForTests,
	setCloudDatabaseAdapterForTests,
	type CloudDatabaseAdapter,
	type CloudRow
} from './cloud-database';
import { encryptSecret } from './crypto';
import {
	listPlaidConnections,
	listPlaidConnectionTenants,
	publicPlaidConnection,
	removeLocalPlaidItem,
	setPlaidConnectionSyncPaused
} from './plaid-store';
import { plaidItemReference, runAsTenant, tenantReference } from './tenant';

const FIRST_TENANT = '10000000-0000-4000-8000-000000000001';
const SECOND_TENANT = '20000000-0000-4000-8000-000000000002';
const FIRST_CONNECTION = '30000000-0000-4000-8000-000000000003';
const SECOND_CONNECTION = '40000000-0000-4000-8000-000000000004';

class SyncPreferenceCloudAdapter implements CloudDatabaseAdapter {
	readonly metadata = new Map<string, string>();
	readonly items = new Map<string, CloudRow>();
	readonly queries: Array<{ text: string; params: unknown[] }> = [];

	seedConnection(id: string, tenantId: string): void {
		this.items.set(id, {
			id,
			item_ref: plaidItemReference(`provider-${id}`, tenantId),
			tenant_ref: tenantReference(tenantId),
			institution_name_enc: encryptSecret('Synthetic Bank', `plaid-institution:${id}`),
			status: 'healthy',
			last_synced_at: null,
			created_at: '2026-09-12T18:00:00.000Z'
		});
	}

	async query<T extends CloudRow>(text: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ text, params });
		if (text.includes('carddue_metadata')) {
			if (text.startsWith('INSERT INTO')) {
				this.metadata.set(String(params[0]), String(params[1]));
				return [];
			}
			if (text.startsWith('DELETE FROM')) {
				for (const key of params) this.metadata.delete(String(key));
				return [];
			}
			if (text.startsWith('SELECT key, value') && text.includes('WHERE key = ANY($1::text[])')) {
				return (params[0] as string[]).flatMap((key) => {
					const value = this.metadata.get(key);
					return value === undefined ? [] : [{ key, value }];
				}) as unknown as T[];
			}
		}
		if (text.includes('FROM public.carddue_plaid_items')) {
			const rows = [...this.items.values()].filter((row) => {
				if (text.includes('WHERE tenant_ref = $1') && row.tenant_ref !== params[0]) return false;
				return !text.includes('AND id = $2') || row.id === String(params[1]).toLowerCase();
			});
			if (text.startsWith('DELETE FROM')) {
				for (const row of rows) this.items.delete(String(row.id));
			}
			return rows as T[];
		}
		throw new Error('Unexpected query in sync preference cloud test.');
	}

	async transaction(): Promise<CloudRow[][]> {
		throw new Error('Sync preferences must not require a schema migration.');
	}
}

describe.sequential('cloud connection sync preferences', () => {
	let adapter: SyncPreferenceCloudAdapter;

	beforeEach(() => {
		vi.stubEnv('CARDDUE_MODE', 'cloud');
		vi.stubEnv(
			'DATABASE_URL',
			[
				'postgresql://carddue_runtime:synthetic',
				'ep-chipdue-test.us-west-2.aws.neon.tech/carddue?sslmode=require'
			].join('@')
		);
		vi.stubEnv('CARDDUE_MASTER_KEY', Buffer.alloc(32, 7).toString('base64url'));
		vi.stubEnv('CARDDUE_AUTH_MODE', 'google');
		vi.stubEnv('CARDDUE_OWNER_PASSWORD_HASH', undefined);
		vi.stubEnv('CARDDUE_GOOGLE_CLIENT_ID', 'synthetic.apps.googleusercontent.com');
		vi.stubEnv('CARDDUE_GOOGLE_CLIENT_SECRET', 'synthetic-google-secret');
		vi.stubEnv('CARDDUE_ALLOWED_HOSTS', 'cards.example.test');
		vi.stubEnv('CARDDUE_GOOGLE_BOOTSTRAP_HASH', undefined);
		vi.stubEnv('CARDDUE_SESSION_TTL_HOURS', undefined);
		resetCloudDatabaseForTests();
		adapter = new SyncPreferenceCloudAdapter();
		setCloudDatabaseAdapterForTests(adapter);
		adapter.seedConnection(FIRST_CONNECTION, FIRST_TENANT);
		adapter.seedConnection(SECOND_CONNECTION, SECOND_TENANT);
	});

	afterEach(() => {
		resetCloudDatabaseForTests();
		vi.unstubAllEnvs();
	});

	it('encrypts cloud pause writes, scopes them by tenant and connection, and reads them for scheduled sync', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			expect(await listPlaidConnections()).toMatchObject([
				{ id: FIRST_CONNECTION, syncPaused: false }
			]);
			await setPlaidConnectionSyncPaused(FIRST_CONNECTION, true);
			expect(await publicPlaidConnection(FIRST_CONNECTION)).toMatchObject({ syncPaused: true });
		});
		await runAsTenant(SECOND_TENANT, async () => {
			const queriesBefore = adapter.queries.length;
			await expect(setPlaidConnectionSyncPaused(FIRST_CONNECTION, false)).rejects.toMatchObject({
				status: 404
			});
			expect(adapter.queries.slice(queriesBefore)).toHaveLength(1);
			expect(adapter.queries.at(-1)).toMatchObject({
				params: [tenantReference(SECOND_TENANT), FIRST_CONNECTION]
			});
			expect(await listPlaidConnections()).toMatchObject([
				{ id: SECOND_CONNECTION, syncPaused: false }
			]);
			const beforeListing = adapter.queries.length;
			const connections = await listPlaidConnectionTenants();
			expect(adapter.queries.slice(beforeListing)).toHaveLength(2);
			expect(adapter.queries.at(-1)?.params).toEqual([
				[
					`plaid_sync_preference_v1:${FIRST_TENANT}:${FIRST_CONNECTION}`,
					`plaid_sync_preference_v1:${SECOND_TENANT}:${SECOND_CONNECTION}`
				]
			]);
			expect(
				connections.map(({ tenantId, connection }) => ({
					tenantId,
					id: connection.id,
					syncPaused: connection.syncPaused
				}))
			).toEqual([
				{ tenantId: FIRST_TENANT, id: FIRST_CONNECTION, syncPaused: true },
				{ tenantId: SECOND_TENANT, id: SECOND_CONNECTION, syncPaused: false }
			]);
		});
		const key = `plaid_sync_preference_v1:${FIRST_TENANT}:${FIRST_CONNECTION}`;
		expect([...adapter.metadata.keys()]).toEqual([key]);
		expect(adapter.metadata.get(key)).toMatch(/^v1\./);
		expect(adapter.metadata.get(key)).not.toContain('syncPaused');
		expect(
			adapter.queries.some(
				(query) =>
					query.text.includes('SELECT key, value') && (query.params[0] as string[]).includes(key)
			)
		).toBe(true);
		await runAsTenant(FIRST_TENANT, async () => {
			await setPlaidConnectionSyncPaused(FIRST_CONNECTION, false);
			expect(await listPlaidConnections()).toMatchObject([{ syncPaused: false }]);
		});
	});

	it('removes cloud metadata on disconnect without touching another tenant', async () => {
		await runAsTenant(FIRST_TENANT, () => setPlaidConnectionSyncPaused(FIRST_CONNECTION, true));
		await runAsTenant(SECOND_TENANT, () => setPlaidConnectionSyncPaused(SECOND_CONNECTION, true));
		await runAsTenant(SECOND_TENANT, async () => {
			await expect(removeLocalPlaidItem(FIRST_CONNECTION)).rejects.toMatchObject({ status: 404 });
			expect(adapter.metadata.size).toBe(2);
		});
		await runAsTenant(FIRST_TENANT, async () => {
			await removeLocalPlaidItem(FIRST_CONNECTION);
			expect(await listPlaidConnections()).toEqual([]);
		});
		expect([...adapter.metadata.keys()]).toEqual([
			`plaid_sync_preference_v1:${SECOND_TENANT}:${SECOND_CONNECTION}`
		]);
		await runAsTenant(SECOND_TENANT, async () => {
			expect(await publicPlaidConnection(SECOND_CONNECTION)).toMatchObject({ syncPaused: true });
		});
		expect(adapter.queries.every(({ text }) => !/\b(?:CREATE|ALTER|DROP)\b/.test(text))).toBe(true);
	});

	it('uses canonical UUIDs for pause writes, reads, resume, and disconnect when a request uses uppercase', async () => {
		const id = 'abcdefab-1234-4567-89ab-abcdef123456';
		const requestedId = id.toUpperCase();
		adapter.seedConnection(id, FIRST_TENANT);
		await runAsTenant(FIRST_TENANT, async () => {
			const request = new Request(`https://cards.example.test/api/connections/${requestedId}`, {
				method: 'PATCH',
				headers: {
					host: 'cards.example.test',
					origin: 'https://cards.example.test',
					'content-type': 'application/json'
				},
				body: JSON.stringify({ syncPaused: true })
			});
			const response = await PATCH({
				params: { id: requestedId },
				request,
				url: new URL(request.url)
			} as never);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ connection: { id, syncPaused: true } });
			expect(await publicPlaidConnection(requestedId)).toMatchObject({ id, syncPaused: true });
			expect(await listPlaidConnections()).toEqual(
				expect.arrayContaining([expect.objectContaining({ id, syncPaused: true })])
			);
			expect([...adapter.metadata.keys()]).toEqual([
				`plaid_sync_preference_v1:${FIRST_TENANT}:${id}`
			]);
			await setPlaidConnectionSyncPaused(requestedId, false);
			expect(await publicPlaidConnection(id)).toMatchObject({ syncPaused: false });
			await removeLocalPlaidItem(requestedId);
			expect(adapter.metadata.size).toBe(0);
			expect(adapter.items.has(id)).toBe(false);
		});
	});
});
