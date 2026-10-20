import { cloudQuery } from './cloud-database';
import { privateFingerprint } from './crypto';
import { getDatabase } from './database';
import type { StoredRecordSource } from './provider-storage';
import { getRuntimeMode } from './runtime';
import { tenantReference } from './tenant';

export interface PrivateRecordRow extends Record<string, unknown> {
	id: string;
	source: StoredRecordSource;
	plaid_item_id: string | null;
	external_account_ref: string | null;
	payload_enc: string;
	last_synced_at: string | null;
	created_at: string;
	updated_at: string;
}

export async function recordRowsRevision(): Promise<string> {
	const tenantRef = tenantReference();
	if (getRuntimeMode() === 'cloud') {
		const [row] = await cloudQuery<{ revision: string }>(
			`SELECT md5(COALESCE(string_agg(
			   id::text || ':' || updated_at || ':' || xmin::text, ',' ORDER BY id
			 ), '')) AS revision
			 FROM public.carddue_cards WHERE tenant_ref = $1`,
			[tenantRef]
		);
		return privateFingerprint(JSON.stringify([tenantRef, row.revision]), 'record-rows-revision');
	}

	// Each encrypted write gets a fresh nonce. The v1 header holds the nonce and
	// authentication tag, so same-millisecond local writes also change the revision.
	const rows = getDatabase()
		.prepare(
			`SELECT id, updated_at, substr(payload_enc, 1, 42) AS payload_revision
			 FROM cards ORDER BY id`
		)
		.all();
	return privateFingerprint(JSON.stringify([tenantRef, rows]), 'record-rows-revision');
}

export async function listRecordRows(): Promise<PrivateRecordRow[]> {
	return getRuntimeMode() === 'cloud'
		? await cloudQuery<PrivateRecordRow>(
				`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
				        last_synced_at, created_at, updated_at
				 FROM public.carddue_cards WHERE tenant_ref = $1`,
				[tenantReference()]
			)
		: (getDatabase()
				.prepare(
					`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
					        last_synced_at, created_at, updated_at
					 FROM cards`
				)
				.all() as PrivateRecordRow[]);
}
