import { randomUUID } from 'node:crypto';
import type { FinancialConnection } from '$lib/types';
import { cloudQuery } from './cloud-database';
import { decryptSecret, encryptSecret, privateUuid } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';
import {
	currentTenantId,
	plaidItemBelongsToCurrentTenant,
	plaidItemReference,
	tenantReference,
	tenantIdFromPlaidItemReference
} from './tenant';

interface PlaidItemRow extends Record<string, unknown> {
	id: string;
	item_ref: string;
	item_id_enc: string;
	access_token_enc: string;
	institution_name_enc: string | null;
	status: 'healthy' | 'needs_update';
	last_synced_at: string | null;
	created_at: string;
}

interface PublicPlaidItemRow extends Record<string, unknown> {
	id: string;
	item_ref: string;
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

function publicRowToConnection(row: PublicPlaidItemRow): FinancialConnection {
	return {
		id: row.id,
		provider: 'plaid',
		institutionName: row.institution_name_enc
			? decryptSecret(row.institution_name_enc, `plaid-institution:${row.id}`)
			: null,
		status: row.status,
		lastSyncedAt: row.last_synced_at,
		createdAt: row.created_at
	};
}

export async function listPlaidConnections(): Promise<FinancialConnection[]> {
	const rows =
		getRuntimeMode() === 'cloud'
			? await cloudQuery<PublicPlaidItemRow>(
					`SELECT id::text, item_ref, institution_name_enc, status, last_synced_at, created_at
					 FROM public.carddue_plaid_items
					 WHERE tenant_ref = $1 ORDER BY created_at`,
					[tenantReference()]
				)
			: (getDatabase()
					.prepare(
						`SELECT id, item_ref, institution_name_enc, status, last_synced_at, created_at
						 FROM plaid_items ORDER BY created_at`
					)
					.all() as PublicPlaidItemRow[]);
	return rows
		.filter((row) => plaidItemBelongsToCurrentTenant(row.item_ref))
		.map(publicRowToConnection);
}

export async function getPrivatePlaidItem(id: string): Promise<PrivatePlaidItem> {
	const row =
		getRuntimeMode() === 'cloud'
			? (
					await cloudQuery<PlaidItemRow>(
						`SELECT id::text, item_ref, item_id_enc, access_token_enc, institution_name_enc,
						        status, last_synced_at, created_at
						 FROM public.carddue_plaid_items WHERE tenant_ref = $1 AND id = $2`,
						[tenantReference(), id]
					)
				)[0]
			: (getDatabase()
					.prepare(
						`SELECT id, item_ref, item_id_enc, access_token_enc, institution_name_enc, status,
						        last_synced_at, created_at
						 FROM plaid_items WHERE id = ?`
					)
					.get(id) as PlaidItemRow | undefined);
	if (!row || !plaidItemBelongsToCurrentTenant(row.item_ref)) {
		throw new AppError('PLAID_ITEM_NOT_FOUND', 'Connection not found.', 404);
	}
	return decodeItem(row);
}

export async function savePlaidItem(
	itemId: string,
	accessToken: string,
	institutionName: string | null
): Promise<string> {
	const tenantId = currentTenantId();
	const reference = plaidItemReference(itemId, tenantId);
	const cloud = getRuntimeMode() === 'cloud';
	let id: string;
	let existing: { id: string } | undefined;

	if (cloud) {
		id = privateUuid(itemId, `plaid-item:${tenantId}`);
	} else {
		existing = getDatabase()
			.prepare(`SELECT id FROM plaid_items WHERE item_ref = ?`)
			.get(reference) as { id: string } | undefined;
		id = existing?.id ?? randomUUID();
	}

	const now = new Date().toISOString();
	const itemIdEncrypted = encryptSecret(itemId, `plaid-item-id:${id}`);
	const accessTokenEncrypted = encryptSecret(accessToken, `plaid-access-token:${id}`);
	const institutionEncrypted = institutionName
		? encryptSecret(institutionName, `plaid-institution:${id}`)
		: null;

	if (cloud) {
		await cloudQuery(
			`INSERT INTO public.carddue_plaid_items AS current_item
			 (id, item_ref, item_id_enc, access_token_enc, institution_name_enc, status,
			  last_synced_at, created_at, updated_at, tenant_ref)
			 VALUES ($1, $2, $3, $4, $5, 'healthy', NULL, $6, $6, $7)
			 ON CONFLICT (item_ref) DO UPDATE SET
			 item_id_enc = EXCLUDED.item_id_enc,
			 access_token_enc = EXCLUDED.access_token_enc,
			 institution_name_enc = COALESCE(
			   EXCLUDED.institution_name_enc,
			   current_item.institution_name_enc
			 ),
			 status = 'healthy',
			 tenant_ref = EXCLUDED.tenant_ref,
			 updated_at = EXCLUDED.updated_at`,
			[
				id,
				reference,
				itemIdEncrypted,
				accessTokenEncrypted,
				institutionEncrypted,
				now,
				tenantReference(tenantId)
			]
		);
	} else if (existing) {
		getDatabase()
			.prepare(
				`UPDATE plaid_items
				 SET item_id_enc = ?, access_token_enc = ?, institution_name_enc = ?,
				     status = 'healthy', updated_at = ?
				 WHERE id = ?`
			)
			.run(itemIdEncrypted, accessTokenEncrypted, institutionEncrypted, now, id);
	} else {
		getDatabase()
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

export async function markPlaidItemSynced(id: string, syncedAt: string): Promise<void> {
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`UPDATE public.carddue_plaid_items
			 SET status = 'healthy', last_synced_at = $1, updated_at = $1
			 WHERE tenant_ref = $2 AND id = $3`,
			[syncedAt, tenantReference(), id]
		);
	} else {
		getDatabase()
			.prepare(
				`UPDATE plaid_items
				 SET status = 'healthy', last_synced_at = ?, updated_at = ? WHERE id = ?`
			)
			.run(syncedAt, syncedAt, id);
	}
}

export async function markPlaidItemNeedsUpdate(id: string): Promise<void> {
	const now = new Date().toISOString();
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`UPDATE public.carddue_plaid_items
			 SET status = 'needs_update', updated_at = $1 WHERE tenant_ref = $2 AND id = $3`,
			[now, tenantReference(), id]
		);
	} else {
		getDatabase()
			.prepare(`UPDATE plaid_items SET status = 'needs_update', updated_at = ? WHERE id = ?`)
			.run(now, id);
	}
}

export async function removeLocalPlaidItem(id: string): Promise<void> {
	if (getRuntimeMode() === 'cloud') {
		const rows = await cloudQuery<{ id: string }>(
			`DELETE FROM public.carddue_plaid_items
			 WHERE tenant_ref = $1 AND id = $2 RETURNING id::text`,
			[tenantReference(), id]
		);
		if (!rows[0]) throw new AppError('PLAID_ITEM_NOT_FOUND', 'Connection not found.', 404);
	} else {
		const result = getDatabase().prepare(`DELETE FROM plaid_items WHERE id = ?`).run(id);
		if (result.changes !== 1) {
			throw new AppError('PLAID_ITEM_NOT_FOUND', 'Connection not found.', 404);
		}
	}
}

export async function publicPlaidConnection(id: string): Promise<FinancialConnection> {
	const row =
		getRuntimeMode() === 'cloud'
			? (
					await cloudQuery<PublicPlaidItemRow>(
						`SELECT id::text, item_ref, institution_name_enc, status, last_synced_at, created_at
						 FROM public.carddue_plaid_items WHERE tenant_ref = $1 AND id = $2`,
						[tenantReference(), id]
					)
				)[0]
			: (getDatabase()
					.prepare(
						`SELECT id, item_ref, institution_name_enc, status, last_synced_at, created_at
						 FROM plaid_items WHERE id = ?`
					)
					.get(id) as PublicPlaidItemRow | undefined);
	if (!row || !plaidItemBelongsToCurrentTenant(row.item_ref)) {
		throw new AppError('PLAID_ITEM_NOT_FOUND', 'Connection not found.', 404);
	}
	return publicRowToConnection(row);
}

export async function listPlaidConnectionTenants(): Promise<
	Array<{ tenantId: string; connection: FinancialConnection }>
> {
	const rows =
		getRuntimeMode() === 'cloud'
			? await cloudQuery<PublicPlaidItemRow>(
					`SELECT id::text, item_ref, institution_name_enc, status, last_synced_at, created_at
					 FROM public.carddue_plaid_items ORDER BY created_at`
				)
			: (getDatabase()
					.prepare(
						`SELECT id, item_ref, institution_name_enc, status, last_synced_at, created_at
						 FROM plaid_items ORDER BY created_at`
					)
					.all() as PublicPlaidItemRow[]);
	return rows.flatMap((row) => {
		const tenantId = tenantIdFromPlaidItemReference(row.item_ref);
		return tenantId ? [{ tenantId, connection: publicRowToConnection(row) }] : [];
	});
}
