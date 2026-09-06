import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CreditScoreEntry } from '$lib/credit-score-types';
import { cloudQuery } from './cloud-database';
import {
	creditBureauSchema,
	type CreateCreditScoreData,
	type UpdateCreditScoreData
} from './credit-score-schemas';
import { decryptJson, encryptJson } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';
import { payloadBelongsToCurrentTenant, tenantPayloadFields, tenantReference } from './tenant';

interface CreditScoreRow extends Record<string, unknown> {
	id: string;
	source: 'manual';
	payload_enc: string;
	created_at: string;
	updated_at: string;
}

const creditScorePayloadSchema = z.object({
	tenantRef: z
		.string()
		.regex(/^[A-Za-z0-9_-]{43}$/)
		.optional(),
	recordType: z.literal('credit_score'),
	score: z.number().int().min(300).max(850),
	bureau: creditBureauSchema,
	model: z.string().max(80).nullable(),
	source: z.string().max(80).nullable(),
	recordedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	notes: z.string().max(2_000).nullable()
});

type CreditScorePayload = z.infer<typeof creditScorePayloadSchema>;

function decodeCreditScore(row: CreditScoreRow): CreditScorePayload | null {
	const value = decryptJson<unknown>(row.payload_enc, `card:${row.id}`);
	if (!value || typeof value !== 'object') return null;
	if (!payloadBelongsToCurrentTenant(value as { tenantRef?: unknown })) return null;
	if ((value as { recordType?: unknown }).recordType !== 'credit_score') return null;
	const parsed = creditScorePayloadSchema.safeParse(value);
	if (!parsed.success) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return parsed.data;
}

function toCreditScore(row: CreditScoreRow, payload: CreditScorePayload): CreditScoreEntry {
	return {
		id: row.id,
		score: payload.score,
		bureau: payload.bureau,
		model: payload.model,
		source: payload.source,
		recordedDate: payload.recordedDate,
		notes: payload.notes,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

async function listRows(): Promise<CreditScoreRow[]> {
	return getRuntimeMode() === 'cloud'
		? await cloudQuery<CreditScoreRow>(
				`SELECT id::text, source, payload_enc, created_at, updated_at
				 FROM public.carddue_cards
				 WHERE tenant_ref = $1 AND source = 'manual'`,
				[tenantReference()]
			)
		: (getDatabase()
				.prepare(
					`SELECT id, source, payload_enc, created_at, updated_at
					 FROM cards WHERE source = 'manual'`
				)
				.all() as CreditScoreRow[]);
}

async function getRow(id: string): Promise<CreditScoreRow | undefined> {
	return getRuntimeMode() === 'cloud'
		? (
				await cloudQuery<CreditScoreRow>(
					`SELECT id::text, source, payload_enc, created_at, updated_at
					 FROM public.carddue_cards
					 WHERE tenant_ref = $1 AND id = $2 AND source = 'manual'`,
					[tenantReference(), id]
				)
			)[0]
		: (getDatabase()
				.prepare(
					`SELECT id, source, payload_enc, created_at, updated_at
					 FROM cards WHERE id = ? AND source = 'manual'`
				)
				.get(id) as CreditScoreRow | undefined);
}

export async function listCreditScores(): Promise<CreditScoreEntry[]> {
	const entries = (await listRows()).flatMap((row) => {
		const payload = decodeCreditScore(row);
		return payload ? [toCreditScore(row, payload)] : [];
	});
	return entries.sort(
		(left, right) =>
			right.recordedDate.localeCompare(left.recordedDate) ||
			right.createdAt.localeCompare(left.createdAt)
	);
}

export async function getCreditScore(id: string): Promise<CreditScoreEntry> {
	const row = await getRow(id);
	const payload = row ? decodeCreditScore(row) : null;
	if (!row || !payload) {
		throw new AppError('CREDIT_SCORE_NOT_FOUND', 'Credit score reading not found.', 404);
	}
	return toCreditScore(row, payload);
}

export async function createCreditScore(input: CreateCreditScoreData): Promise<CreditScoreEntry> {
	const id = randomUUID();
	const now = new Date().toISOString();
	const payload: CreditScorePayload = {
		...tenantPayloadFields(),
		recordType: 'credit_score',
		...input
	};
	const encrypted = encryptJson(payload, `card:${id}`);
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`INSERT INTO public.carddue_cards
			 (id, source, plaid_item_id, external_account_ref, payload_enc,
			  last_synced_at, created_at, updated_at, tenant_ref)
			 VALUES ($1, 'manual', NULL, NULL, $2, NULL, $3, $3, $4)`,
			[id, encrypted, now, tenantReference()]
		);
	} else {
		getDatabase()
			.prepare(
				`INSERT INTO cards
				 (id, source, plaid_item_id, external_account_ref, payload_enc,
				  last_synced_at, created_at, updated_at)
				 VALUES (?, 'manual', NULL, NULL, ?, NULL, ?, ?)`
			)
			.run(id, encrypted, now, now);
	}
	return getCreditScore(id);
}

export async function updateCreditScore(
	id: string,
	changes: UpdateCreditScoreData
): Promise<CreditScoreEntry> {
	const existing = await getCreditScore(id);
	const payload: CreditScorePayload = {
		...tenantPayloadFields(),
		recordType: 'credit_score',
		score: changes.score ?? existing.score,
		bureau: changes.bureau ?? existing.bureau,
		model: changes.model === undefined ? existing.model : changes.model,
		source: changes.source === undefined ? existing.source : changes.source,
		recordedDate: changes.recordedDate ?? existing.recordedDate,
		notes: changes.notes === undefined ? existing.notes : changes.notes
	};
	const now = new Date().toISOString();
	const encrypted = encryptJson(payload, `card:${id}`);
	if (getRuntimeMode() === 'cloud') {
		const rows = await cloudQuery<{ id: string }>(
			`UPDATE public.carddue_cards SET payload_enc = $1, updated_at = $2
			 WHERE tenant_ref = $3 AND id = $4 AND source = 'manual'
			 RETURNING id::text`,
			[encrypted, now, tenantReference(), id]
		);
		if (!rows[0])
			throw new AppError('CREDIT_SCORE_NOT_FOUND', 'Credit score reading not found.', 404);
	} else {
		const result = getDatabase()
			.prepare(
				`UPDATE cards SET payload_enc = ?, updated_at = ? WHERE id = ? AND source = 'manual'`
			)
			.run(encrypted, now, id);
		if (result.changes !== 1) {
			throw new AppError('CREDIT_SCORE_NOT_FOUND', 'Credit score reading not found.', 404);
		}
	}
	return getCreditScore(id);
}

export async function deleteCreditScore(id: string): Promise<void> {
	await getCreditScore(id);
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`DELETE FROM public.carddue_cards
			 WHERE tenant_ref = $1 AND id = $2 AND source = 'manual'`,
			[tenantReference(), id]
		);
		return;
	}
	getDatabase().prepare(`DELETE FROM cards WHERE id = ? AND source = 'manual'`).run(id);
}
