import { randomUUID } from 'node:crypto';
import type { FinancialConnection } from '$lib/types';
import { cloudQuery } from './cloud-database';
import { decryptJson, decryptSecret, encryptJson, encryptSecret, privateUuid } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
import type { PlaidClientConfiguration } from './plaid-config';
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

interface PlaidItemIdentityRow extends Record<string, unknown> {
	id: string;
	item_ref: string;
}

interface StoredPlaidItemConfiguration {
	version: 1;
	clientId: string;
	secret: string;
	environment: 'sandbox' | 'production';
}

interface StoredPlaidLinkAlternation {
	version: 1;
	nextClientId: string;
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
	configuration: PlaidClientConfiguration | null;
}

const ITEM_CONFIGURATION_KEY_PREFIX = 'plaid_item_config_v1:';
const LINK_ALTERNATION_KEY_PREFIX = 'plaid_link_alternation_v1:';

function itemConfigurationKey(tenantId: string, itemId: string): string {
	return `${ITEM_CONFIGURATION_KEY_PREFIX}${tenantId}:${itemId}`;
}

function itemConfigurationContext(tenantId: string, itemId: string): string {
	return `plaid-item-config:${tenantId}:${itemId}`;
}

function linkAlternationKey(tenantId: string): string {
	return `${LINK_ALTERNATION_KEY_PREFIX}${tenantId}`;
}

function linkAlternationContext(tenantId: string): string {
	return `plaid-link-alternation:${tenantId}`;
}

function validCredential(value: unknown): value is string {
	return typeof value === 'string' && value.length >= 8 && value.length <= 256;
}

function parseItemConfiguration(
	value: string,
	tenantId: string,
	itemId: string
): PlaidClientConfiguration {
	const configuration = decryptJson<Partial<StoredPlaidItemConfiguration>>(
		value,
		itemConfigurationContext(tenantId, itemId)
	);
	if (
		configuration?.version !== 1 ||
		!validCredential(configuration.clientId) ||
		!validCredential(configuration.secret) ||
		!['sandbox', 'production'].includes(configuration.environment ?? '')
	) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return {
		clientId: configuration.clientId,
		secret: configuration.secret,
		environment: configuration.environment as 'sandbox' | 'production'
	};
}

async function readItemConfiguration(
	itemId: string,
	tenantId: string
): Promise<PlaidClientConfiguration | null> {
	const key = itemConfigurationKey(tenantId, itemId);
	const row =
		getRuntimeMode() === 'cloud'
			? (
					await cloudQuery<{ value: string }>(
						`SELECT value FROM public.carddue_metadata WHERE key = $1`,
						[key]
					)
				)[0]
			: (getDatabase().prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
					{ value: string } | undefined);
	return row ? parseItemConfiguration(row.value, tenantId, itemId) : null;
}

async function saveItemConfiguration(
	itemId: string,
	tenantId: string,
	configuration: PlaidClientConfiguration,
	overwrite = true
): Promise<void> {
	const key = itemConfigurationKey(tenantId, itemId);
	const encrypted = encryptJson(
		{
			version: 1,
			clientId: configuration.clientId,
			secret: configuration.secret,
			environment: configuration.environment
		},
		itemConfigurationContext(tenantId, itemId)
	);
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			overwrite
				? `INSERT INTO public.carddue_metadata AS current_config (key, value)
				   VALUES ($1, $2)
				   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
				: `INSERT INTO public.carddue_metadata (key, value) VALUES ($1, $2)
				   ON CONFLICT (key) DO NOTHING`,
			[key, encrypted]
		);
		return;
	}
	getDatabase()
		.prepare(
			overwrite
				? `INSERT INTO metadata (key, value) VALUES (?, ?)
				   ON CONFLICT (key) DO UPDATE SET value = excluded.value`
				: `INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)`
		)
		.run(key, encrypted);
}

async function listItemIdentityRows(): Promise<PlaidItemIdentityRow[]> {
	return getRuntimeMode() === 'cloud'
		? await cloudQuery<PlaidItemIdentityRow>(
				`SELECT id::text, item_ref FROM public.carddue_plaid_items
				 WHERE tenant_ref = $1 ORDER BY created_at`,
				[tenantReference()]
			)
		: (getDatabase()
				.prepare(`SELECT id, item_ref FROM plaid_items ORDER BY created_at`)
				.all() as PlaidItemIdentityRow[]);
}

async function itemConfigurationSummary(): Promise<{
	configurations: PlaidClientConfiguration[];
	itemCount: number;
}> {
	const tenantId = currentTenantId();
	const rows = (await listItemIdentityRows()).filter((row) =>
		plaidItemBelongsToCurrentTenant(row.item_ref)
	);
	const configurations = await Promise.all(
		rows.map((row) => readItemConfiguration(row.id, tenantId))
	);
	const distinct = new Map<string, PlaidClientConfiguration>();
	for (const configuration of configurations) {
		if (configuration && !distinct.has(configuration.clientId)) {
			distinct.set(configuration.clientId, configuration);
		}
	}
	return { configurations: [...distinct.values()], itemCount: rows.length };
}

async function readNextPlaidClientId(): Promise<string | null> {
	const tenantId = currentTenantId();
	const key = linkAlternationKey(tenantId);
	const row =
		getRuntimeMode() === 'cloud'
			? (
					await cloudQuery<{ value: string }>(
						`SELECT value FROM public.carddue_metadata WHERE key = $1`,
						[key]
					)
				)[0]
			: (getDatabase().prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
					{ value: string } | undefined);
	if (!row) return null;
	const state = decryptJson<Partial<StoredPlaidLinkAlternation>>(
		row.value,
		linkAlternationContext(tenantId)
	);
	if (state?.version !== 1 || !validCredential(state.nextClientId)) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return state.nextClientId;
}

async function saveNextPlaidClientId(clientId: string): Promise<void> {
	const tenantId = currentTenantId();
	const key = linkAlternationKey(tenantId);
	const value = encryptJson(
		{ version: 1, nextClientId: clientId },
		linkAlternationContext(tenantId)
	);
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`INSERT INTO public.carddue_metadata AS link_alternation (key, value)
			 VALUES ($1, $2)
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			[key, value]
		);
		return;
	}
	getDatabase()
		.prepare(
			`INSERT INTO metadata (key, value) VALUES (?, ?)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value`
		)
		.run(key, value);
}

export async function resetPlaidLinkAlternation(): Promise<void> {
	const key = linkAlternationKey(currentTenantId());
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(`DELETE FROM public.carddue_metadata WHERE key = $1`, [key]);
		return;
	}
	getDatabase().prepare(`DELETE FROM metadata WHERE key = ?`).run(key);
}

export type PlaidLinkTeam = 'current' | 'original';

export interface PlaidLinkRouting {
	configuration: PlaidClientConfiguration;
	alternating: boolean;
	nextTeam: PlaidLinkTeam;
}

export async function getPlaidLinkRouting(
	current: PlaidClientConfiguration,
	fallbackOriginal: PlaidClientConfiguration | null = null
): Promise<PlaidLinkRouting> {
	const summary = await itemConfigurationSummary();
	const original =
		summary.configurations.find((configuration) => configuration.clientId !== current.clientId) ??
		(summary.itemCount > 0 && fallbackOriginal?.clientId !== current.clientId
			? fallbackOriginal
			: null);
	if (!original) {
		return { configuration: current, alternating: false, nextTeam: 'current' };
	}

	const nextClientId = await readNextPlaidClientId();
	const useOriginal = nextClientId === original.clientId;
	return {
		configuration: useOriginal ? original : current,
		alternating: true,
		nextTeam: useOriginal ? 'original' : 'current'
	};
}

export async function advancePlaidLinkAlternation(
	current: PlaidClientConfiguration,
	used: PlaidClientConfiguration,
	fallbackOriginal: PlaidClientConfiguration | null = null
): Promise<void> {
	const summary = await itemConfigurationSummary();
	const original =
		summary.configurations.find((configuration) => configuration.clientId !== current.clientId) ??
		(summary.itemCount > 0 && fallbackOriginal?.clientId !== current.clientId
			? fallbackOriginal
			: null);
	if (!original) {
		await resetPlaidLinkAlternation();
		return;
	}
	await saveNextPlaidClientId(
		used.clientId === current.clientId ? original.clientId : current.clientId
	);
}

export async function preparePlaidItemsForConfigurationChange(
	current: PlaidClientConfiguration,
	candidate: PlaidClientConfiguration
): Promise<void> {
	const tenantId = currentTenantId();
	const sameClient = current.clientId === candidate.clientId;
	const rows = (await listItemIdentityRows()).filter((row) =>
		plaidItemBelongsToCurrentTenant(row.item_ref)
	);
	await Promise.all(
		rows.map(async (row) => {
			const stored = await readItemConfiguration(row.id, tenantId);
			if (!stored) {
				await saveItemConfiguration(row.id, tenantId, sameClient ? candidate : current, false);
				return;
			}
			if (stored.clientId === candidate.clientId) {
				await saveItemConfiguration(row.id, tenantId, candidate);
			}
		})
	);
}

function decodeItem(
	row: PlaidItemRow,
	configuration: PlaidClientConfiguration | null
): PrivatePlaidItem {
	return {
		id: row.id,
		itemId: decryptSecret(row.item_id_enc, `plaid-item-id:${row.id}`),
		accessToken: decryptSecret(row.access_token_enc, `plaid-access-token:${row.id}`),
		institutionName: row.institution_name_enc
			? decryptSecret(row.institution_name_enc, `plaid-institution:${row.id}`)
			: null,
		status: row.status,
		lastSyncedAt: row.last_synced_at,
		createdAt: row.created_at,
		configuration
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
	const tenantId = currentTenantId();
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
	return decodeItem(row, await readItemConfiguration(id, tenantId));
}

export async function savePlaidItem(
	itemId: string,
	accessToken: string,
	institutionName: string | null,
	configuration?: PlaidClientConfiguration
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
	if (configuration) await saveItemConfiguration(id, tenantId, configuration);
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
	const tenantId = currentTenantId();
	if (getRuntimeMode() === 'cloud') {
		const rows = await cloudQuery<{ id: string }>(
			`DELETE FROM public.carddue_plaid_items
			 WHERE tenant_ref = $1 AND id = $2 RETURNING id::text`,
			[tenantReference(), id]
		);
		if (!rows[0]) throw new AppError('PLAID_ITEM_NOT_FOUND', 'Connection not found.', 404);
		await cloudQuery(`DELETE FROM public.carddue_metadata WHERE key = $1`, [
			itemConfigurationKey(tenantId, id)
		]);
	} else {
		const result = getDatabase().prepare(`DELETE FROM plaid_items WHERE id = ?`).run(id);
		if (result.changes !== 1) {
			throw new AppError('PLAID_ITEM_NOT_FOUND', 'Connection not found.', 404);
		}
		getDatabase()
			.prepare(`DELETE FROM metadata WHERE key = ?`)
			.run(itemConfigurationKey(tenantId, id));
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
