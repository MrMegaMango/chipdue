import { randomUUID } from 'node:crypto';
import type { Card, CardSource, CardTransaction, TransactionHistoryStatus } from '$lib/types';
import { cloudQuery, cloudTransaction, type CloudStatement } from './cloud-database';
import { decryptJson, encryptJson, privateFingerprint, privateUuid } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';
import type { CreateManualCardData, UpdateManualCardData } from './schemas';

interface CardPayload {
	nickname: string;
	issuer: string | null;
	issuerLogoBase64?: string | null;
	last4: string | null;
	currency: string;
	statementBalanceCents: number | null;
	minimumPaymentCents: number | null;
	currentBalanceCents: number | null;
	dueDate: string | null;
	statementDate: string | null;
	isOverdue: boolean | null;
	autopayEnabled: boolean;
	transactionHistory?: StoredTransactionHistory;
}

export interface StoredPlaidTransaction {
	transactionId: string;
	name: string;
	merchantName: string | null;
	amountCents: number;
	currency: string;
	date: string;
	authorizedDate: string | null;
	pending: boolean;
	categoryPrimary: string | null;
	categoryDetailed: string | null;
}

export interface StoredTransactionHistory {
	enabled: true;
	cursor: string | null;
	status: TransactionHistoryStatus;
	transactions: StoredPlaidTransaction[];
}

interface CardRow extends Record<string, unknown> {
	id: string;
	source: CardSource;
	plaid_item_id: string | null;
	external_account_ref: string | null;
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

export interface PlaidTransactionState {
	enabled: boolean;
	cursor: string | null;
	status: TransactionHistoryStatus;
	byAccountReference: Map<string, StoredPlaidTransaction[]>;
}

const TRANSACTION_HISTORY_STATUSES = new Set<TransactionHistoryStatus>([
	'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
	'NOT_READY',
	'INITIAL_UPDATE_COMPLETE',
	'HISTORICAL_UPDATE_COMPLETE'
]);
const MAX_STORED_TRANSACTIONS = 10_000;

function isStoredPlaidTransaction(value: unknown): value is StoredPlaidTransaction {
	if (!value || typeof value !== 'object') return false;
	const transaction = value as Partial<StoredPlaidTransaction>;
	return (
		typeof transaction.transactionId === 'string' &&
		transaction.transactionId.length > 0 &&
		transaction.transactionId.length <= 256 &&
		typeof transaction.name === 'string' &&
		transaction.name.length > 0 &&
		transaction.name.length <= 160 &&
		(transaction.merchantName === null ||
			(typeof transaction.merchantName === 'string' && transaction.merchantName.length <= 120)) &&
		typeof transaction.amountCents === 'number' &&
		Number.isSafeInteger(transaction.amountCents) &&
		Math.abs(transaction.amountCents) <= 100_000_000_000 &&
		typeof transaction.currency === 'string' &&
		/^[A-Z]{3}$/.test(transaction.currency) &&
		typeof transaction.date === 'string' &&
		/^\d{4}-\d{2}-\d{2}$/.test(transaction.date) &&
		(transaction.authorizedDate === null ||
			(typeof transaction.authorizedDate === 'string' &&
				/^\d{4}-\d{2}-\d{2}$/.test(transaction.authorizedDate))) &&
		typeof transaction.pending === 'boolean' &&
		(transaction.categoryPrimary === null ||
			(typeof transaction.categoryPrimary === 'string' &&
				transaction.categoryPrimary.length <= 80)) &&
		(transaction.categoryDetailed === null ||
			(typeof transaction.categoryDetailed === 'string' &&
				transaction.categoryDetailed.length <= 120))
	);
}

function isStoredTransactionHistory(value: unknown): value is StoredTransactionHistory {
	if (!value || typeof value !== 'object') return false;
	const history = value as Partial<StoredTransactionHistory>;
	return (
		history.enabled === true &&
		(history.cursor === null ||
			(typeof history.cursor === 'string' && history.cursor.length <= 256)) &&
		typeof history.status === 'string' &&
		TRANSACTION_HISTORY_STATUSES.has(history.status as TransactionHistoryStatus) &&
		Array.isArray(history.transactions) &&
		history.transactions.length <= MAX_STORED_TRANSACTIONS &&
		history.transactions.every(isStoredPlaidTransaction)
	);
}

function isStoredIssuerLogo(value: unknown): value is string | null | undefined {
	return (
		value === undefined ||
		value === null ||
		(typeof value === 'string' &&
			value.length > 0 &&
			value.length <= 350_000 &&
			/^[A-Za-z0-9+/]+={0,2}$/.test(value))
	);
}

function decodePayload(row: CardRow): CardPayload | null {
	const payload = decryptJson<CardPayload & { recordType?: unknown }>(
		row.payload_enc,
		`card:${row.id}`
	);
	if (payload && (payload.recordType === 'account' || payload.recordType === 'bonus')) return null;
	if (
		!payload ||
		typeof payload.nickname !== 'string' ||
		typeof payload.currency !== 'string' ||
		!('dueDate' in payload)
	) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	if (
		payload.transactionHistory !== undefined &&
		!isStoredTransactionHistory(payload.transactionHistory)
	) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	if (!isStoredIssuerLogo(payload.issuerLogoBase64)) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return payload;
}

function rowToCard(row: CardRow): Card | null {
	const payload = decodePayload(row);
	if (!payload) return null;
	return {
		id: row.id,
		source: row.source,
		nickname: payload.nickname,
		issuer: payload.issuer,
		issuerLogoUrl: payload.issuerLogoBase64
			? `data:image/png;base64,${payload.issuerLogoBase64}`
			: null,
		last4: payload.last4,
		currency: payload.currency,
		statementBalanceCents: payload.statementBalanceCents,
		minimumPaymentCents: payload.minimumPaymentCents,
		currentBalanceCents: payload.currentBalanceCents,
		dueDate: payload.dueDate,
		statementDate: payload.statementDate,
		isOverdue: payload.isOverdue,
		autopayEnabled: payload.autopayEnabled,
		transactionHistoryEnabled: payload.transactionHistory?.enabled === true,
		transactionHistoryStatus: payload.transactionHistory?.status ?? null,
		plaidConnectionId: row.source === 'plaid' ? row.plaid_item_id : null,
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
		...(snapshot.issuerLogoBase64 ? { issuerLogoBase64: snapshot.issuerLogoBase64 } : {}),
		last4: snapshot.last4,
		currency: snapshot.currency,
		statementBalanceCents: snapshot.statementBalanceCents,
		minimumPaymentCents: snapshot.minimumPaymentCents,
		currentBalanceCents: snapshot.currentBalanceCents,
		dueDate: snapshot.dueDate,
		statementDate: snapshot.statementDate,
		isOverdue: snapshot.isOverdue,
		autopayEnabled: snapshot.autopayEnabled,
		...(snapshot.transactionHistory ? { transactionHistory: snapshot.transactionHistory } : {})
	};
}

export async function listCards(): Promise<Card[]> {
	const rows =
		getRuntimeMode() === 'cloud'
			? await cloudQuery<CardRow>(
					`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
					        last_synced_at, created_at, updated_at
					 FROM public.carddue_cards`
				)
			: (getDatabase()
					.prepare(
						`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
						 FROM cards`
					)
					.all() as CardRow[]);
	return sortCards(rows.map(rowToCard).filter((card): card is Card => card !== null));
}

export async function getCard(id: string): Promise<Card> {
	const row =
		getRuntimeMode() === 'cloud'
			? (
					await cloudQuery<CardRow>(
						`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
						 FROM public.carddue_cards WHERE id = $1`,
						[id]
					)
				)[0]
			: (getDatabase()
					.prepare(
						`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
						 FROM cards WHERE id = ?`
					)
					.get(id) as CardRow | undefined);
	if (!row) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	const card = rowToCard(row);
	if (!card) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	return card;
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
			 RETURNING id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
			           last_synced_at, created_at, updated_at`,
			[encrypted, now, id]
		);
		if (!rows[0]) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
		const card = rowToCard(rows[0]);
		if (!card) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
		return card;
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

export async function readPlaidTransactionState(
	plaidItemId: string
): Promise<PlaidTransactionState> {
	const rows =
		getRuntimeMode() === 'cloud'
			? await cloudQuery<CardRow>(
					`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
					        last_synced_at, created_at, updated_at
					 FROM public.carddue_cards
					 WHERE plaid_item_id = $1 AND source = 'plaid'`,
					[plaidItemId]
				)
			: (getDatabase()
					.prepare(
						`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
						 FROM cards WHERE plaid_item_id = ? AND source = 'plaid'`
					)
					.all(plaidItemId) as CardRow[]);
	const enabledRows = rows
		.map((row) => ({ row, history: decodePayload(row)?.transactionHistory }))
		.filter(
			(value): value is { row: CardRow; history: StoredTransactionHistory } =>
				value.history !== undefined
		);
	if (enabledRows.length === 0) {
		return {
			enabled: false,
			cursor: null,
			status: 'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
			byAccountReference: new Map()
		};
	}

	const cursor = enabledRows[0].history.cursor;
	const status = enabledRows[0].history.status;
	if (enabledRows.some(({ history }) => history.cursor !== cursor || history.status !== status)) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return {
		enabled: true,
		cursor,
		status,
		byAccountReference: new Map(
			enabledRows.flatMap(({ row, history }) =>
				row.external_account_ref ? [[row.external_account_ref, history.transactions] as const] : []
			)
		)
	};
}

export async function listCardTransactions(
	cardId: string,
	limit = 500
): Promise<{
	transactions: CardTransaction[];
	status: TransactionHistoryStatus;
	lastSyncedAt: string | null;
}> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
		throw new AppError('INVALID_REQUEST', 'The request is invalid.', 400);
	}
	const row =
		getRuntimeMode() === 'cloud'
			? (
					await cloudQuery<CardRow>(
						`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
						 FROM public.carddue_cards WHERE id = $1`,
						[cardId]
					)
				)[0]
			: (getDatabase()
					.prepare(
						`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
						 FROM cards WHERE id = ?`
					)
					.get(cardId) as CardRow | undefined);
	if (!row) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	if (row.source !== 'plaid') {
		throw new AppError(
			'TRANSACTION_HISTORY_UNAVAILABLE',
			'Transaction history is available for Plaid cards only.',
			409
		);
	}
	const history = decodePayload(row)?.transactionHistory;
	if (!history) {
		throw new AppError(
			'TRANSACTION_HISTORY_NOT_ENABLED',
			'Transaction history has not been enabled for this connection.',
			409
		);
	}
	const transactions = history.transactions
		.map<CardTransaction>((transaction) => ({
			id: privateUuid(transaction.transactionId, `plaid-transaction:${cardId}`),
			name: transaction.name,
			merchantName: transaction.merchantName,
			amountCents: transaction.amountCents,
			currency: transaction.currency,
			date: transaction.date,
			authorizedDate: transaction.authorizedDate,
			pending: transaction.pending,
			categoryPrimary: transaction.categoryPrimary,
			categoryDetailed: transaction.categoryDetailed
		}))
		.sort(
			(left, right) => right.date.localeCompare(left.date) || left.name.localeCompare(right.name)
		)
		.slice(0, limit);
	return { transactions, status: history.status, lastSyncedAt: row.last_synced_at };
}
