import { randomUUID } from 'node:crypto';
import type { Card, CardSource } from '$lib/types';
import { cloudQuery, cloudTransaction, type CloudStatement } from './cloud-database';
import { decryptJson, encryptJson, privateFingerprint, privateUuid } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';
import type { CreateManualCardData, UpdateManualCardData } from './schemas';

interface CardPayload {
	nickname: string;
	issuer: string | null;
	last4: string | null;
	currency: string;
	statementBalanceCents: number | null;
	minimumPaymentCents: number | null;
	currentBalanceCents: number | null;
	dueDate: string | null;
	statementDate: string | null;
	isOverdue: boolean | null;
	autopayEnabled: boolean;
}

interface CardRow extends Record<string, unknown> {
	id: string;
	source: CardSource;
	payload_enc: string;
	last_synced_at: string | null;
	created_at: string;
	updated_at: string;
}

interface PlaidCardRow extends CardRow {
	external_account_ref: string;
}

export interface PlaidCardSnapshot extends CardPayload {
	accountId: string;
}

function decodePayload(row: CardRow): CardPayload {
	const payload = decryptJson<CardPayload>(row.payload_enc, `card:${row.id}`);
	if (
		!payload ||
		typeof payload.nickname !== 'string' ||
		typeof payload.currency !== 'string' ||
		!('dueDate' in payload)
	) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return payload;
}

function rowToCard(row: CardRow): Card {
	return {
		id: row.id,
		source: row.source,
		...decodePayload(row),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastSyncedAt: row.last_synced_at
	};
}

function sortCards(cards: Card[]): Card[] {
	return cards.sort((left, right) => {
		if (left.dueDate && right.dueDate && left.dueDate !== right.dueDate) {
			return left.dueDate.localeCompare(right.dueDate);
		}
		if (left.dueDate && !right.dueDate) return -1;
		if (!left.dueDate && right.dueDate) return 1;
		return left.nickname.localeCompare(right.nickname);
	});
}

function snapshotPayload(snapshot: PlaidCardSnapshot): CardPayload {
	return {
		nickname: snapshot.nickname,
		issuer: snapshot.issuer,
		last4: snapshot.last4,
		currency: snapshot.currency,
		statementBalanceCents: snapshot.statementBalanceCents,
		minimumPaymentCents: snapshot.minimumPaymentCents,
		currentBalanceCents: snapshot.currentBalanceCents,
		dueDate: snapshot.dueDate,
		statementDate: snapshot.statementDate,
		isOverdue: snapshot.isOverdue,
		autopayEnabled: snapshot.autopayEnabled
	};
}

export async function listCards(): Promise<Card[]> {
	const rows =
		getRuntimeMode() === 'cloud'
			? await cloudQuery<CardRow>(
					`SELECT id::text, source, payload_enc, last_synced_at, created_at, updated_at
					 FROM public.carddue_cards`
				)
			: (getDatabase()
					.prepare(
						`SELECT id, source, payload_enc, last_synced_at, created_at, updated_at
						 FROM cards`
					)
					.all() as CardRow[]);
	return sortCards(rows.map(rowToCard));
}

export async function getCard(id: string): Promise<Card> {
	const row =
		getRuntimeMode() === 'cloud'
			? (
					await cloudQuery<CardRow>(
						`SELECT id::text, source, payload_enc, last_synced_at, created_at, updated_at
						 FROM public.carddue_cards WHERE id = $1`,
						[id]
					)
				)[0]
			: (getDatabase()
					.prepare(
						`SELECT id, source, payload_enc, last_synced_at, created_at, updated_at
						 FROM cards WHERE id = ?`
					)
					.get(id) as CardRow | undefined);
	if (!row) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	return rowToCard(row);
}

export async function createManualCard(input: CreateManualCardData): Promise<Card> {
	const id = randomUUID();
	const now = new Date().toISOString();
	const payload: CardPayload = { ...input };
	const payloadEncrypted = encryptJson(payload, `card:${id}`);

	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`INSERT INTO public.carddue_cards
			 (id, source, plaid_item_id, external_account_ref, payload_enc,
			  last_synced_at, created_at, updated_at)
			 VALUES ($1, 'manual', NULL, NULL, $2, NULL, $3, $3)`,
			[id, payloadEncrypted, now]
		);
	} else {
		getDatabase()
			.prepare(
				`INSERT INTO cards
				 (id, source, plaid_item_id, external_account_ref, payload_enc,
				  last_synced_at, created_at, updated_at)
				 VALUES (?, 'manual', NULL, NULL, ?, NULL, ?, ?)`
			)
			.run(id, payloadEncrypted, now, now);
	}
	return getCard(id);
}

export async function updateManualCard(id: string, changes: UpdateManualCardData): Promise<Card> {
	const existing = await getCard(id);
	if (existing.source !== 'manual') {
		throw new AppError(
			'PLAID_CARD_READ_ONLY',
			'Synced cards must be changed at their institution.',
			409
		);
	}

	const payload: CardPayload = {
		nickname: changes.nickname ?? existing.nickname,
		issuer: changes.issuer === undefined ? existing.issuer : changes.issuer,
		last4: changes.last4 === undefined ? existing.last4 : changes.last4,
		currency: changes.currency ?? existing.currency,
		statementBalanceCents:
			changes.statementBalanceCents === undefined
				? existing.statementBalanceCents
				: changes.statementBalanceCents,
		minimumPaymentCents:
			changes.minimumPaymentCents === undefined
				? existing.minimumPaymentCents
				: changes.minimumPaymentCents,
		currentBalanceCents:
			changes.currentBalanceCents === undefined
				? existing.currentBalanceCents
				: changes.currentBalanceCents,
		dueDate: changes.dueDate === undefined ? existing.dueDate : changes.dueDate,
		statementDate:
			changes.statementDate === undefined ? existing.statementDate : changes.statementDate,
		isOverdue: changes.isOverdue === undefined ? existing.isOverdue : changes.isOverdue,
		autopayEnabled:
			changes.autopayEnabled === undefined ? existing.autopayEnabled : changes.autopayEnabled
	};
	const encrypted = encryptJson(payload, `card:${id}`);
	const now = new Date().toISOString();

	if (getRuntimeMode() === 'cloud') {
		const rows = await cloudQuery<CardRow>(
			`UPDATE public.carddue_cards SET payload_enc = $1, updated_at = $2
			 WHERE id = $3 AND source = 'manual'
			 RETURNING id::text, source, payload_enc, last_synced_at, created_at, updated_at`,
			[encrypted, now, id]
		);
		if (!rows[0]) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
		return rowToCard(rows[0]);
	}

	const result = getDatabase()
		.prepare(`UPDATE cards SET payload_enc = ?, updated_at = ? WHERE id = ? AND source = 'manual'`)
		.run(encrypted, now, id);
	if (result.changes !== 1) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	return getCard(id);
}

export async function deleteManualCard(id: string): Promise<void> {
	const existing = await getCard(id);
	if (existing.source !== 'manual') {
		throw new AppError(
			'PLAID_CARD_READ_ONLY',
			'Disconnect the institution to remove synced cards.',
			409
		);
	}
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(`DELETE FROM public.carddue_cards WHERE id = $1 AND source = 'manual'`, [id]);
	} else {
		getDatabase().prepare(`DELETE FROM cards WHERE id = ? AND source = 'manual'`).run(id);
	}
}

async function replaceCloudPlaidCards(
	plaidItemId: string,
	snapshots: PlaidCardSnapshot[],
	syncedAt: string
): Promise<void> {
	const references: string[] = [];
	const statements: CloudStatement[] = snapshots.map((snapshot) => {
		const reference = privateFingerprint(snapshot.accountId, 'plaid-account');
		const id = privateUuid(snapshot.accountId, `plaid-card:${plaidItemId}`);
		references.push(reference);
		return {
			text: `INSERT INTO public.carddue_cards
			       (id, source, plaid_item_id, external_account_ref, payload_enc,
			        last_synced_at, created_at, updated_at)
			       VALUES ($1, 'plaid', $2, $3, $4, $5, $5, $5)
			       ON CONFLICT (plaid_item_id, external_account_ref) DO UPDATE SET
			       payload_enc = EXCLUDED.payload_enc,
			       last_synced_at = EXCLUDED.last_synced_at,
			       updated_at = EXCLUDED.updated_at`,
			params: [
				id,
				plaidItemId,
				reference,
				encryptJson(snapshotPayload(snapshot), `card:${id}`),
				syncedAt
			]
		};
	});
	statements.push(
		references.length
			? {
					text: `DELETE FROM public.carddue_cards
					       WHERE plaid_item_id = $1 AND source = 'plaid'
					       AND NOT (external_account_ref = ANY($2::text[]))`,
					params: [plaidItemId, references]
				}
			: {
					text: `DELETE FROM public.carddue_cards
					       WHERE plaid_item_id = $1 AND source = 'plaid'`,
					params: [plaidItemId]
				}
	);
	await cloudTransaction(statements);
}

function replaceLocalPlaidCards(
	plaidItemId: string,
	snapshots: PlaidCardSnapshot[],
	syncedAt: string
): void {
	const database = getDatabase();
	const transaction = database.transaction(() => {
		const existingRows = database
			.prepare(
				`SELECT id, source, payload_enc, last_synced_at, created_at, updated_at,
				        external_account_ref
				 FROM cards WHERE plaid_item_id = ? AND source = 'plaid'`
			)
			.all(plaidItemId) as PlaidCardRow[];
		const existingByReference = new Map(existingRows.map((row) => [row.external_account_ref, row]));
		const seenReferences = new Set<string>();

		for (const snapshot of snapshots) {
			const reference = privateFingerprint(snapshot.accountId, 'plaid-account');
			seenReferences.add(reference);
			const current = existingByReference.get(reference);
			const id = current?.id ?? randomUUID();
			const encrypted = encryptJson(snapshotPayload(snapshot), `card:${id}`);
			if (current) {
				database
					.prepare(
						`UPDATE cards SET payload_enc = ?, last_synced_at = ?, updated_at = ?
						 WHERE id = ?`
					)
					.run(encrypted, syncedAt, syncedAt, id);
			} else {
				database
					.prepare(
						`INSERT INTO cards
						 (id, source, plaid_item_id, external_account_ref, payload_enc,
						  last_synced_at, created_at, updated_at)
						 VALUES (?, 'plaid', ?, ?, ?, ?, ?, ?)`
					)
					.run(id, plaidItemId, reference, encrypted, syncedAt, syncedAt, syncedAt);
			}
		}

		for (const row of existingRows) {
			if (!seenReferences.has(row.external_account_ref)) {
				database.prepare(`DELETE FROM cards WHERE id = ? AND source = 'plaid'`).run(row.id);
			}
		}
	});
	transaction();
}

export async function replacePlaidCards(
	plaidItemId: string,
	snapshots: PlaidCardSnapshot[],
	syncedAt: string
): Promise<void> {
	if (getRuntimeMode() === 'cloud') {
		await replaceCloudPlaidCards(plaidItemId, snapshots, syncedAt);
	} else {
		replaceLocalPlaidCards(plaidItemId, snapshots, syncedAt);
	}
}
