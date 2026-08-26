import { randomUUID } from 'node:crypto';
import type { Card, CardSource } from '$lib/types';
import { decryptJson, encryptJson, privateFingerprint } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
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

interface CardRow {
	id: string;
	source: CardSource;
	payload_enc: string;
	last_synced_at: string | null;
	created_at: string;
	updated_at: string;
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
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted local data could not be read.', 500);
	}
	return payload;
}

function rowToCard(row: CardRow): Card {
	const payload = decodePayload(row);
	return {
		id: row.id,
		source: row.source,
		...payload,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastSyncedAt: row.last_synced_at
	};
}

export function listCards(): Card[] {
	const rows = getDatabase()
		.prepare(
			`SELECT id, source, payload_enc, last_synced_at, created_at, updated_at
			 FROM cards`
		)
		.all() as CardRow[];

	return rows.map(rowToCard).sort((left, right) => {
		if (left.dueDate && right.dueDate && left.dueDate !== right.dueDate) {
			return left.dueDate.localeCompare(right.dueDate);
		}
		if (left.dueDate && !right.dueDate) return -1;
		if (!left.dueDate && right.dueDate) return 1;
		return left.nickname.localeCompare(right.nickname);
	});
}

export function getCard(id: string): Card {
	const row = getDatabase()
		.prepare(
			`SELECT id, source, payload_enc, last_synced_at, created_at, updated_at
			 FROM cards WHERE id = ?`
		)
		.get(id) as CardRow | undefined;
	if (!row) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	return rowToCard(row);
}

export function createManualCard(input: CreateManualCardData): Card {
	const database = getDatabase();
	const id = randomUUID();
	const now = new Date().toISOString();
	const payload: CardPayload = { ...input };

	database
		.prepare(
			`INSERT INTO cards
			 (id, source, plaid_item_id, external_account_ref, payload_enc, last_synced_at, created_at, updated_at)
			 VALUES (?, 'manual', NULL, NULL, ?, NULL, ?, ?)`
		)
		.run(id, encryptJson(payload, `card:${id}`), now, now);
	return getCard(id);
}

export function updateManualCard(id: string, changes: UpdateManualCardData): Card {
	const existing = getCard(id);
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

	const result = getDatabase()
		.prepare(`UPDATE cards SET payload_enc = ?, updated_at = ? WHERE id = ? AND source = 'manual'`)
		.run(encryptJson(payload, `card:${id}`), new Date().toISOString(), id);
	if (result.changes !== 1) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	return getCard(id);
}

export function deleteManualCard(id: string): void {
	const existing = getCard(id);
	if (existing.source !== 'manual') {
		throw new AppError(
			'PLAID_CARD_READ_ONLY',
			'Disconnect the institution to remove synced cards.',
			409
		);
	}
	getDatabase().prepare(`DELETE FROM cards WHERE id = ? AND source = 'manual'`).run(id);
}

export function replacePlaidCards(
	plaidItemId: string,
	snapshots: PlaidCardSnapshot[],
	syncedAt: string
): Card[] {
	const database = getDatabase();
	const transaction = database.transaction(() => {
		const existingRows = database
			.prepare(
				`SELECT id, source, payload_enc, last_synced_at, created_at, updated_at,
				        external_account_ref
				 FROM cards WHERE plaid_item_id = ? AND source = 'plaid'`
			)
			.all(plaidItemId) as Array<CardRow & { external_account_ref: string }>;
		const existingByReference = new Map(existingRows.map((row) => [row.external_account_ref, row]));
		const seenReferences = new Set<string>();

		for (const snapshot of snapshots) {
			const reference = privateFingerprint(snapshot.accountId, 'plaid-account');
			seenReferences.add(reference);
			const current = existingByReference.get(reference);
			const id = current?.id ?? randomUUID();
			const payload: CardPayload = {
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
			const encrypted = encryptJson(payload, `card:${id}`);

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
	return listCards().filter((card) => card.source === 'plaid' && card.lastSyncedAt === syncedAt);
}
