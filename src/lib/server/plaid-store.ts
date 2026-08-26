import { randomUUID } from 'node:crypto';
import type { PlaidConnection } from '$lib/types';
import { decryptSecret, encryptSecret, privateFingerprint } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';

interface PlaidItemRow {
	id: string;
	item_id_enc: string;
	access_token_enc: string;
	institution_name_enc: string | null;
	status: 'healthy' | 'needs_update';
	last_synced_at: string | null;
	created_at: string;
}

interface PublicPlaidItemRow {
	id: string;
	institution_name_enc: string | null;
	status: 'healthy' | 'needs_update';
	last_synced_at: string | null;
	created_at: string;
}

export interface PrivatePlaidItem {
	id: string;
	itemId: string;
	accessToken: string;
	institutionName: string | null;
	status: 'healthy' | 'needs_update';
	lastSyncedAt: string | null;
	createdAt: string;
}

function decodeItem(row: PlaidItemRow): PrivatePlaidItem {
	return {
		id: row.id,
		itemId: decryptSecret(row.item_id_enc, `plaid-item-id:${row.id}`),
		accessToken: decryptSecret(row.access_token_enc, `plaid-access-token:${row.id}`),
		institutionName: row.institution_name_enc
			? decryptSecret(row.institution_name_enc, `plaid-institution:${row.id}`)
			: null,
		status: row.status,
		lastSyncedAt: row.last_synced_at,
		createdAt: row.created_at
	};
}

function publicRowToConnection(row: PublicPlaidItemRow): PlaidConnection {
	return {
		id: row.id,
		institutionName: row.institution_name_enc
			? decryptSecret(row.institution_name_enc, `plaid-institution:${row.id}`)
			: null,
		status: row.status,
		lastSyncedAt: row.last_synced_at,
		createdAt: row.created_at
	};
}

export function listPlaidConnections(): PlaidConnection[] {
	const rows = getDatabase()
		.prepare(
			`SELECT id, institution_name_enc, status,
			        last_synced_at, created_at
			 FROM plaid_items ORDER BY created_at`
		)
		.all() as PublicPlaidItemRow[];
	return rows.map(publicRowToConnection);
}

export function getPrivatePlaidItem(id: string): PrivatePlaidItem {
	const row = getDatabase()
		.prepare(
			`SELECT id, item_id_enc, access_token_enc, institution_name_enc, status,
			        last_synced_at, created_at
			 FROM plaid_items WHERE id = ?`
		)
		.get(id) as PlaidItemRow | undefined;
	if (!row) throw new AppError('PLAID_ITEM_NOT_FOUND', 'Connection not found.', 404);
	return decodeItem(row);
}

export function savePlaidItem(
	itemId: string,
	accessToken: string,
	institutionName: string | null
): string {
	const database = getDatabase();
	const reference = privateFingerprint(itemId, 'plaid-item');
	const existing = database
		.prepare(`SELECT id FROM plaid_items WHERE item_ref = ?`)
		.get(reference) as { id: string } | undefined;
	const id = existing?.id ?? randomUUID();
	const now = new Date().toISOString();
	const itemIdEncrypted = encryptSecret(itemId, `plaid-item-id:${id}`);
	const accessTokenEncrypted = encryptSecret(accessToken, `plaid-access-token:${id}`);
	const institutionEncrypted = institutionName
		? encryptSecret(institutionName, `plaid-institution:${id}`)
		: null;

	if (existing) {
		database
			.prepare(
				`UPDATE plaid_items
				 SET item_id_enc = ?, access_token_enc = ?, institution_name_enc = ?,
				     status = 'healthy', updated_at = ?
				 WHERE id = ?`
			)
			.run(itemIdEncrypted, accessTokenEncrypted, institutionEncrypted, now, id);
	} else {
		database
			.prepare(
				`INSERT INTO plaid_items
				 (id, item_ref, item_id_enc, access_token_enc, institution_name_enc, status,
				  last_synced_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'healthy', NULL, ?, ?)`
			)
			.run(id, reference, itemIdEncrypted, accessTokenEncrypted, institutionEncrypted, now, now);
	}
	return id;
}

export function markPlaidItemSynced(id: string, syncedAt: string): void {
	getDatabase()
		.prepare(
			`UPDATE plaid_items
			 SET status = 'healthy', last_synced_at = ?, updated_at = ?
			 WHERE id = ?`
		)
		.run(syncedAt, syncedAt, id);
}

export function markPlaidItemNeedsUpdate(id: string): void {
	getDatabase()
		.prepare(`UPDATE plaid_items SET status = 'needs_update', updated_at = ? WHERE id = ?`)
		.run(new Date().toISOString(), id);
}

export function removeLocalPlaidItem(id: string): void {
	const result = getDatabase().prepare(`DELETE FROM plaid_items WHERE id = ?`).run(id);
	if (result.changes !== 1)
		throw new AppError('PLAID_ITEM_NOT_FOUND', 'Connection not found.', 404);
}

export function publicPlaidConnection(id: string): PlaidConnection {
	const row = getDatabase()
		.prepare(
			`SELECT id, institution_name_enc, status, last_synced_at, created_at
			 FROM plaid_items WHERE id = ?`
		)
		.get(id) as PublicPlaidItemRow | undefined;
	if (!row) throw new AppError('PLAID_ITEM_NOT_FOUND', 'Connection not found.', 404);
	return publicRowToConnection(row);
}
