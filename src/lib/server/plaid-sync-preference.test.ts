import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATCH } from '../../routes/api/connections/[id]/+server';
import { resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests, getDatabase } from './database';
import {
	listPlaidConnections,
	listPlaidConnectionTenants,
	markPlaidItemNeedsUpdate,
	markPlaidItemSynced,
	publicPlaidConnection,
	removeLocalPlaidItem,
	savePlaidItem,
	setPlaidConnectionSyncPaused
} from './plaid-store';
import { runAsTenant } from './tenant';

const FIRST_TENANT = '10000000-0000-4000-8000-000000000001';
const SECOND_TENANT = '20000000-0000-4000-8000-000000000002';
const MISSING_CONNECTION = '30000000-0000-4000-8000-000000000003';

async function patchConnection(
	id: string,
	body: unknown,
	options: { origin?: string; contentType?: string; rawBody?: string } = {}
): Promise<Response> {
	const request = new Request(`http://localhost/api/connections/${id}`, {
		method: 'PATCH',
		headers: {
			origin: options.origin ?? 'http://localhost',
			'content-type': options.contentType ?? 'application/json'
		},
		body: options.rawBody ?? JSON.stringify(body)
	});
	return (await PATCH({ params: { id }, request, url: new URL(request.url) } as never)) as Response;
}

describe.sequential('connection sync preferences', () => {
	let temporaryDirectory: string;

	beforeEach(() => {
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-sync-preference-'));
		vi.stubEnv('CARDDUE_DATA_DIR', temporaryDirectory);
		vi.stubEnv('CARDDUE_MODE', 'local');
		vi.stubEnv('DATABASE_URL', '');
		vi.stubEnv('VERCEL', '');
		closeDatabaseForTests();
		resetCryptoStateForTests();
	});

	afterEach(() => {
		closeDatabaseForTests();
		resetCryptoStateForTests();
		vi.unstubAllEnvs();
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('defaults existing connections to active and persists an encrypted pause across restarts', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			const id = await savePlaidItem('provider-item', 'synthetic-access-token', 'Synthetic Bank');
			expect(await publicPlaidConnection(id)).toMatchObject({ syncPaused: false });
			expect(await listPlaidConnections()).toMatchObject([{ id, syncPaused: false }]);
			const connection = await setPlaidConnectionSyncPaused(id, true);
			expect(connection).toMatchObject({ id, syncPaused: true });
			expect(connection).not.toHaveProperty('accessToken');
			const rows = getDatabase().prepare('SELECT value FROM metadata').all();
			expect(rows).toHaveLength(1);
			expect(JSON.stringify(rows)).not.toContain('syncPaused');
			expect(JSON.stringify(rows)).not.toContain('synthetic-access-token');
			closeDatabaseForTests();
			resetCryptoStateForTests();
			expect(await publicPlaidConnection(id)).toMatchObject({ syncPaused: true });
		});
	});

	it('keeps pauses after a manual sync and connection repair, and supports resuming', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			const id = await savePlaidItem('provider-item', 'synthetic-access-token', 'Synthetic Bank');
			await setPlaidConnectionSyncPaused(id, true);
			await markPlaidItemNeedsUpdate(id);
			const repairedId = await savePlaidItem(
				'provider-item',
				'replacement-token',
				'Synthetic Bank'
			);
			expect(repairedId).toBe(id);
			expect(await publicPlaidConnection(id)).toMatchObject({
				status: 'healthy',
				syncPaused: true
			});
			const syncedAt = '2026-09-12T18:00:00.000Z';
			await markPlaidItemSynced(id, syncedAt);
			expect(await publicPlaidConnection(id)).toMatchObject({
				syncPaused: true,
				lastSyncedAt: syncedAt
			});
			expect(await setPlaidConnectionSyncPaused(id, false)).toMatchObject({ syncPaused: false });
			expect(await listPlaidConnections()).toMatchObject([{ syncPaused: false }]);
		});
	});

	it('enforces ownership and resolves each pause under its own tenant during scheduled listing', async () => {
		const firstId = await runAsTenant(FIRST_TENANT, async () => {
			const id = await savePlaidItem('same-provider-item', 'first-token', 'First Bank');
			await setPlaidConnectionSyncPaused(id, true);
			return id;
		});
		const secondId = await runAsTenant(SECOND_TENANT, async () => {
			const id = await savePlaidItem('same-provider-item', 'second-token', 'Second Bank');
			await expect(setPlaidConnectionSyncPaused(firstId, false)).rejects.toMatchObject({
				status: 404
			});
			await expect(publicPlaidConnection(firstId)).rejects.toMatchObject({ status: 404 });
			await expect(removeLocalPlaidItem(firstId)).rejects.toMatchObject({ status: 404 });
			expect(await listPlaidConnections()).toMatchObject([{ id, syncPaused: false }]);
			return id;
		});
		const all = await runAsTenant(SECOND_TENANT, () => listPlaidConnectionTenants());
		expect(all).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					tenantId: FIRST_TENANT,
					connection: expect.objectContaining({ id: firstId, syncPaused: true })
				}),
				expect.objectContaining({
					tenantId: SECOND_TENANT,
					connection: expect.objectContaining({ id: secondId, syncPaused: false })
				})
			])
		);
		expect(getDatabase().prepare('SELECT key FROM metadata').all()).toHaveLength(1);
	});

	it('binds encrypted preferences to the connection and removes them on disconnect', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			const firstId = await savePlaidItem('first-item', 'first-token', 'First Bank');
			const secondId = await savePlaidItem('second-item', 'second-token', 'Second Bank');
			await setPlaidConnectionSyncPaused(firstId, true);
			await setPlaidConnectionSyncPaused(secondId, false);
			const firstKey = `plaid_sync_preference_v1:${FIRST_TENANT}:${firstId}`;
			const secondKey = `plaid_sync_preference_v1:${FIRST_TENANT}:${secondId}`;
			const original = getDatabase()
				.prepare('SELECT value FROM metadata WHERE key = ?')
				.get(firstKey) as { value: string };
			getDatabase()
				.prepare('UPDATE metadata SET value = ? WHERE key = ?')
				.run(original.value, secondKey);
			await expect(publicPlaidConnection(secondId)).rejects.toMatchObject({
				code: 'ENCRYPTED_DATA_UNREADABLE'
			});
			await removeLocalPlaidItem(firstId);
			expect(
				getDatabase().prepare('SELECT key FROM metadata WHERE key = ?').get(firstKey)
			).toBeUndefined();
			expect(
				getDatabase().prepare('SELECT key FROM metadata WHERE key = ?').get(secondKey)
			).toBeDefined();
			await expect(publicPlaidConnection(firstId)).rejects.toMatchObject({ status: 404 });
		});
	});

	it('PATCH returns the saved preference without secrets and rejects other tenant IDs', async () => {
		const id = await runAsTenant(FIRST_TENANT, () =>
			savePlaidItem('item', 'synthetic-token', 'Synthetic Bank')
		);
		await runAsTenant(FIRST_TENANT, async () => {
			const response = await patchConnection(id, { syncPaused: true });
			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toContain('no-store');
			const body = await response.json();
			expect(body).toMatchObject({ connection: { id, syncPaused: true } });
			expect(JSON.stringify(body)).not.toContain('synthetic-token');
		});
		await runAsTenant(SECOND_TENANT, async () => {
			const response = await patchConnection(id, { syncPaused: false });
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ error: { message: 'Connection not found.' } });
		});
		await runAsTenant(FIRST_TENANT, async () => {
			expect(await publicPlaidConnection(id)).toMatchObject({ syncPaused: true });
			const response = await patchConnection(id, { syncPaused: false });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ connection: { syncPaused: false } });
		});
	});

	it.each([
		null,
		[],
		{},
		{ syncPaused: 'true' },
		{ syncPaused: 1 },
		{ syncPaused: true, status: 'healthy' }
	])('PATCH rejects invalid preference %j without changing stored state', async (body) => {
		await runAsTenant(FIRST_TENANT, async () => {
			const id = await savePlaidItem('item', 'synthetic-token', 'Synthetic Bank');
			const response = await patchConnection(id, body);
			expect(response.status).toBe(400);
			expect(await publicPlaidConnection(id)).toMatchObject({ syncPaused: false });
			expect(getDatabase().prepare('SELECT key FROM metadata').all()).toHaveLength(0);
		});
	});

	it('PATCH rejects cross-origin requests, malformed JSON, non-JSON bodies, invalid and missing IDs', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			const id = await savePlaidItem('item', 'synthetic-token', 'Synthetic Bank');
			expect(
				(await patchConnection(id, { syncPaused: true }, { origin: 'https://untrusted.example' }))
					.status
			).toBe(403);
			expect((await patchConnection(id, {}, { rawBody: '{' })).status).toBe(400);
			expect(
				(await patchConnection(id, { syncPaused: true }, { contentType: 'text/plain' })).status
			).toBe(415);
			expect((await patchConnection('invalid-id', { syncPaused: true })).status).toBe(400);
			expect((await patchConnection(MISSING_CONNECTION, { syncPaused: true })).status).toBe(404);
			expect(await publicPlaidConnection(id)).toMatchObject({ syncPaused: false });
		});
	});
});
