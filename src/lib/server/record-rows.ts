import { cloudQuery } from './cloud-database';
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
