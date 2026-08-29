import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
	AccountBonus,
	BonusRequirement,
	FinancialAccount,
	FinancialAccountTransaction,
	InvestmentHolding,
	TransactionHistoryStatus
} from '$lib/types';
import type { StoredTransactionHistory } from './cards';
import { cloudQuery, cloudTransaction, type CloudStatement } from './cloud-database';
import { decryptJson, encryptJson, privateFingerprint, privateUuid } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';
import {
	bonusStatusSchema,
	financialAccountOwnerSchema,
	financialAccountStatusSchema,
	financialAccountTypeSchema,
	type CreateBonusData,
	type CreateFinancialAccountData,
	type UpdateBonusData,
	type UpdateFinancialAccountData
} from './schemas';

interface PrivateRecordRow extends Record<string, unknown> {
	id: string;
	source: 'manual' | 'plaid';
	plaid_item_id: string | null;
	external_account_ref: string | null;
	payload_enc: string;
	last_synced_at: string | null;
	created_at: string;
	updated_at: string;
}

interface PlaidAccountRow extends PrivateRecordRow {
	source: 'plaid';
	plaid_item_id: string;
	external_account_ref: string;
}

export interface PlaidFinancialAccountSnapshot {
	accountId: string;
	nickname: string;
	institution: string | null;
	accountType: 'checking' | 'savings' | 'brokerage' | 'cash_management' | 'other';
	last4: string | null;
	currency: string;
	currentBalanceCents: number | null;
	costBasisCents: number | null;
	holdings: InvestmentHolding[] | null;
	transactionHistory?: StoredTransactionHistory;
}

const dateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.nullable();
const nullableTextSchema = z.string().nullable();
const nullableCentsSchema = z.number().int().nullable();
const investmentHoldingSchema = z.object({
	name: z.string(),
	tickerSymbol: nullableTextSchema,
	securityType: nullableTextSchema,
	quantity: z.number().finite(),
	priceMicros: z.number().int(),
	valueCents: nullableCentsSchema,
	costBasisCents: nullableCentsSchema,
	currency: z.string(),
	priceAsOf: dateSchema
});
const transactionHistoryStatusSchema = z.enum([
	'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
	'NOT_READY',
	'INITIAL_UPDATE_COMPLETE',
	'HISTORICAL_UPDATE_COMPLETE'
]);
const storedTransactionSchema = z.object({
	transactionId: z.string().min(1).max(256),
	name: z.string().min(1).max(160),
	merchantName: z.string().max(120).nullable(),
	amountCents: z.number().int().min(-100_000_000_000).max(100_000_000_000),
	currency: z.string().regex(/^[A-Z]{3}$/),
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	authorizedDate: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.nullable(),
	pending: z.boolean(),
	categoryPrimary: z.string().max(80).nullable(),
	categoryDetailed: z.string().max(120).nullable()
});
const storedTransactionHistorySchema = z.object({
	enabled: z.literal(true),
	accountReference: z
		.string()
		.regex(/^[A-Za-z0-9_-]{43}$/)
		.optional(),
	cursor: z.string().max(256).nullable(),
	status: transactionHistoryStatusSchema,
	transactions: z.array(storedTransactionSchema).max(10_000)
});

const accountPayloadSchema = z.object({
	recordType: z.literal('account'),
	nickname: z.string(),
	institution: nullableTextSchema,
	accountType: financialAccountTypeSchema,
	ownerType: financialAccountOwnerSchema,
	status: financialAccountStatusSchema,
	last4: nullableTextSchema,
	currency: z.string(),
	currentBalanceCents: nullableCentsSchema,
	costBasisCents: nullableCentsSchema,
	holdings: z.array(investmentHoldingSchema).default([]),
	transactionHistory: storedTransactionHistorySchema.optional(),
	openedDate: dateSchema,
	notes: nullableTextSchema
});

const bonusPayloadSchema = z.object({
	recordType: z.literal('bonus'),
	accountId: z.string().uuid().nullable(),
	offerTemplateId: z.string().max(100).nullable().optional().default(null),
	name: z.string(),
	institution: nullableTextSchema,
	rewardCents: nullableCentsSchema,
	currency: z.string(),
	status: bonusStatusSchema,
	openedDate: dateSchema,
	requirementDeadline: dateSchema,
	expectedPayoutDate: dateSchema,
	paidDate: dateSchema,
	safeToCloseDate: dateSchema,
	requirements: z.array(
		z.object({ id: z.string().uuid(), label: z.string(), completed: z.boolean() })
	),
	notes: nullableTextSchema
});

type AccountPayload = z.infer<typeof accountPayloadSchema>;
type BonusPayload = z.infer<typeof bonusPayloadSchema>;
type PrivateRecordPayload = AccountPayload | BonusPayload;

function decodeRecord(row: PrivateRecordRow): PrivateRecordPayload | null {
	// The legacy encryption context remains stable so existing cloud storage needs no migration.
	const payload = decryptJson<unknown>(row.payload_enc, `card:${row.id}`);
	if (!payload || typeof payload !== 'object' || !('recordType' in payload)) return null;
	const recordType = (payload as { recordType?: unknown }).recordType;
	const parsed =
		recordType === 'account'
			? accountPayloadSchema.safeParse(payload)
			: recordType === 'bonus'
				? bonusPayloadSchema.safeParse(payload)
				: null;
	if (!parsed?.success) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return parsed.data;
}

function rowToAccount(row: PrivateRecordRow, payload: AccountPayload): FinancialAccount {
	return {
		id: row.id,
		source: row.source,
		nickname: payload.nickname,
		institution: payload.institution,
		accountType: payload.accountType,
		ownerType: payload.ownerType,
		status: payload.status,
		last4: payload.last4,
		currency: payload.currency,
		currentBalanceCents: payload.currentBalanceCents,
		costBasisCents: payload.costBasisCents,
		holdings: payload.holdings,
		transactionHistoryEnabled: payload.transactionHistory?.enabled === true,
		transactionHistoryStatus: payload.transactionHistory?.status ?? null,
		openedDate: payload.openedDate,
		notes: payload.notes,
		plaidConnectionId: row.source === 'plaid' ? row.plaid_item_id : null,
		lastSyncedAt: row.last_synced_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function rowToBonus(row: PrivateRecordRow, payload: BonusPayload): AccountBonus {
	return {
		id: row.id,
		accountId: payload.accountId,
		offerTemplateId: payload.offerTemplateId,
		name: payload.name,
		institution: payload.institution,
		rewardCents: payload.rewardCents,
		currency: payload.currency,
		status: payload.status,
		openedDate: payload.openedDate,
		requirementDeadline: payload.requirementDeadline,
		expectedPayoutDate: payload.expectedPayoutDate,
		paidDate: payload.paidDate,
		safeToCloseDate: payload.safeToCloseDate,
		requirements: payload.requirements,
		notes: payload.notes,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

async function listRows(): Promise<PrivateRecordRow[]> {
	return getRuntimeMode() === 'cloud'
		? await cloudQuery<PrivateRecordRow>(
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
				.all() as PrivateRecordRow[]);
}

async function getRow(id: string): Promise<PrivateRecordRow | undefined> {
	return getRuntimeMode() === 'cloud'
		? (
				await cloudQuery<PrivateRecordRow>(
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
				.get(id) as PrivateRecordRow | undefined);
}

async function insertRecord(id: string, payload: PrivateRecordPayload, now: string): Promise<void> {
	const encrypted = encryptJson(payload, `card:${id}`);
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`INSERT INTO public.carddue_cards
			 (id, source, plaid_item_id, external_account_ref, payload_enc,
			  last_synced_at, created_at, updated_at)
			 VALUES ($1, 'manual', NULL, NULL, $2, NULL, $3, $3)`,
			[id, encrypted, now]
		);
		return;
	}
	getDatabase()
		.prepare(
			`INSERT INTO cards
			 (id, source, plaid_item_id, external_account_ref, payload_enc,
			  last_synced_at, created_at, updated_at)
			 VALUES (?, 'manual', NULL, NULL, ?, NULL, ?, ?)`
		)
		.run(id, encrypted, now, now);
}

async function updateRecord(id: string, payload: PrivateRecordPayload, now: string): Promise<void> {
	const encrypted = encryptJson(payload, `card:${id}`);
	if (getRuntimeMode() === 'cloud') {
		const rows = await cloudQuery<{ id: string }>(
			`UPDATE public.carddue_cards SET payload_enc = $1, updated_at = $2
			 WHERE id = $3 RETURNING id::text`,
			[encrypted, now, id]
		);
		if (!rows[0]) throw new AppError('RECORD_NOT_FOUND', 'Record not found.', 404);
		return;
	}
	const result = getDatabase()
		.prepare(`UPDATE cards SET payload_enc = ?, updated_at = ? WHERE id = ?`)
		.run(encrypted, now, id);
	if (result.changes !== 1) throw new AppError('RECORD_NOT_FOUND', 'Record not found.', 404);
}

async function deleteRecord(id: string): Promise<void> {
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(`DELETE FROM public.carddue_cards WHERE id = $1 AND source = 'manual'`, [id]);
		return;
	}
	getDatabase().prepare(`DELETE FROM cards WHERE id = ? AND source = 'manual'`).run(id);
}

function normalizeRequirements(requirements: CreateBonusData['requirements']): BonusRequirement[] {
	return requirements.map((requirement) => ({
		id: requirement.id ?? randomUUID(),
		label: requirement.label,
		completed: requirement.completed
	}));
}

export async function listFinancialAccounts(): Promise<FinancialAccount[]> {
	const accounts: FinancialAccount[] = [];
	for (const row of await listRows()) {
		const payload = decodeRecord(row);
		if (payload?.recordType === 'account') accounts.push(rowToAccount(row, payload));
	}
	return accounts.sort((left, right) => left.nickname.localeCompare(right.nickname));
}

export async function getFinancialAccount(id: string): Promise<FinancialAccount> {
	const row = await getRow(id);
	const payload = row ? decodeRecord(row) : null;
	if (!row || payload?.recordType !== 'account') {
		throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.', 404);
	}
	return rowToAccount(row, payload);
}

export async function createFinancialAccount(
	input: CreateFinancialAccountData
): Promise<FinancialAccount> {
	const id = randomUUID();
	const now = new Date().toISOString();
	await insertRecord(id, { recordType: 'account', ...input, holdings: [] }, now);
	return getFinancialAccount(id);
}

export async function updateFinancialAccount(
	id: string,
	changes: UpdateFinancialAccountData
): Promise<FinancialAccount> {
	const row = await getRow(id);
	const existingPayload = row ? decodeRecord(row) : null;
	if (!row || existingPayload?.recordType !== 'account') {
		throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.', 404);
	}
	const existing = rowToAccount(row, existingPayload);
	if (
		existing.source === 'plaid' &&
		(changes.institution !== undefined ||
			changes.accountType !== undefined ||
			changes.status !== undefined ||
			changes.last4 !== undefined ||
			changes.currency !== undefined ||
			changes.currentBalanceCents !== undefined)
	) {
		throw new AppError(
			'PLAID_ACCOUNT_READ_ONLY',
			'Synced account balances and bank details are updated through Plaid.',
			409
		);
	}
	const payload: AccountPayload = {
		recordType: 'account',
		nickname: changes.nickname ?? existing.nickname,
		institution: changes.institution === undefined ? existing.institution : changes.institution,
		accountType: changes.accountType ?? existing.accountType,
		ownerType: changes.ownerType ?? existing.ownerType,
		status: changes.status ?? existing.status,
		last4: changes.last4 === undefined ? existing.last4 : changes.last4,
		currency: changes.currency ?? existing.currency,
		currentBalanceCents:
			changes.currentBalanceCents === undefined
				? existing.currentBalanceCents
				: changes.currentBalanceCents,
		costBasisCents:
			changes.costBasisCents === undefined ? existing.costBasisCents : changes.costBasisCents,
		holdings: existing.holdings,
		transactionHistory: existingPayload.transactionHistory,
		openedDate: changes.openedDate === undefined ? existing.openedDate : changes.openedDate,
		notes: changes.notes === undefined ? existing.notes : changes.notes
	};
	await updateRecord(id, payload, new Date().toISOString());
	return getFinancialAccount(id);
}

export async function deleteFinancialAccount(id: string): Promise<void> {
	const existing = await getFinancialAccount(id);
	if (existing.source === 'plaid') {
		throw new AppError(
			'PLAID_ACCOUNT_READ_ONLY',
			'Disconnect the institution to remove a synced account.',
			409
		);
	}
	await deleteRecord(id);
}

function plaidAccountPayload(
	snapshot: PlaidFinancialAccountSnapshot,
	existing?: AccountPayload
): AccountPayload {
	return {
		recordType: 'account',
		nickname: existing?.nickname ?? snapshot.nickname,
		institution: snapshot.institution,
		accountType: snapshot.accountType,
		ownerType: existing?.ownerType ?? 'personal',
		status: existing?.status ?? 'active',
		last4: snapshot.last4,
		currency: snapshot.currency,
		currentBalanceCents: snapshot.currentBalanceCents,
		costBasisCents: snapshot.costBasisCents ?? existing?.costBasisCents ?? null,
		holdings: snapshot.holdings ?? existing?.holdings ?? [],
		transactionHistory: snapshot.transactionHistory ?? existing?.transactionHistory,
		openedDate: existing?.openedDate ?? null,
		notes: existing?.notes ?? null
	};
}

function accountRows(rows: PrivateRecordRow[]): Array<{
	row: PlaidAccountRow;
	payload: AccountPayload;
}> {
	return rows.flatMap((row) => {
		if (row.source !== 'plaid' || !row.plaid_item_id || !row.external_account_ref) {
			return [];
		}
		const payload = decodeRecord(row);
		return payload?.recordType === 'account' ? [{ row: row as PlaidAccountRow, payload }] : [];
	});
}

async function replaceCloudPlaidAccounts(
	plaidItemId: string,
	snapshots: PlaidFinancialAccountSnapshot[],
	syncedAt: string
): Promise<void> {
	const existing = accountRows(
		await cloudQuery<PrivateRecordRow>(
			`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
			        last_synced_at, created_at, updated_at
			 FROM public.carddue_cards WHERE plaid_item_id = $1 AND source = 'plaid'`,
			[plaidItemId]
		)
	);
	const existingByReference = new Map(
		existing.map(({ row, payload }) => [row.external_account_ref, { row, payload }])
	);
	const seenIds = new Set<string>();
	const statements: CloudStatement[] = [];

	for (const snapshot of snapshots) {
		const reference = privateFingerprint(snapshot.accountId, 'plaid-financial-account');
		const current = existingByReference.get(reference);
		const id = current?.row.id ?? privateUuid(snapshot.accountId, `plaid-account:${plaidItemId}`);
		seenIds.add(id);
		const encrypted = encryptJson(plaidAccountPayload(snapshot, current?.payload), `card:${id}`);
		statements.push({
			text: `INSERT INTO public.carddue_cards
			       (id, source, plaid_item_id, external_account_ref, payload_enc,
			        last_synced_at, created_at, updated_at)
			       VALUES ($1, 'plaid', $2, $3, $4, $5, $5, $5)
			       ON CONFLICT (plaid_item_id, external_account_ref) DO UPDATE SET
			       payload_enc = EXCLUDED.payload_enc,
			       last_synced_at = EXCLUDED.last_synced_at,
			       updated_at = EXCLUDED.updated_at`,
			params: [id, plaidItemId, reference, encrypted, syncedAt]
		});
	}

	for (const { row } of existing) {
		if (!seenIds.has(row.id)) {
			statements.push({
				text: `DELETE FROM public.carddue_cards WHERE id = $1 AND source = 'plaid'`,
				params: [row.id]
			});
		}
	}
	if (statements.length > 0) await cloudTransaction(statements);
}

function replaceLocalPlaidAccounts(
	plaidItemId: string,
	snapshots: PlaidFinancialAccountSnapshot[],
	syncedAt: string
): void {
	const database = getDatabase();
	const transaction = database.transaction(() => {
		const existing = accountRows(
			database
				.prepare(
					`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
					        last_synced_at, created_at, updated_at
					 FROM cards WHERE plaid_item_id = ? AND source = 'plaid'`
				)
				.all(plaidItemId) as PrivateRecordRow[]
		);
		const existingByReference = new Map(
			existing.map(({ row, payload }) => [row.external_account_ref, { row, payload }])
		);
		const seenIds = new Set<string>();

		for (const snapshot of snapshots) {
			const reference = privateFingerprint(snapshot.accountId, 'plaid-financial-account');
			const current = existingByReference.get(reference);
			const id = current?.row.id ?? randomUUID();
			seenIds.add(id);
			const encrypted = encryptJson(plaidAccountPayload(snapshot, current?.payload), `card:${id}`);
			if (current) {
				database
					.prepare(
						`UPDATE cards SET payload_enc = ?, last_synced_at = ?, updated_at = ?
						 WHERE id = ? AND source = 'plaid'`
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

		for (const { row } of existing) {
			if (!seenIds.has(row.id)) {
				database.prepare(`DELETE FROM cards WHERE id = ? AND source = 'plaid'`).run(row.id);
			}
		}
	});
	transaction();
}

export async function replacePlaidFinancialAccounts(
	plaidItemId: string,
	snapshots: PlaidFinancialAccountSnapshot[],
	syncedAt: string
): Promise<void> {
	if (getRuntimeMode() === 'cloud') {
		await replaceCloudPlaidAccounts(plaidItemId, snapshots, syncedAt);
	} else {
		replaceLocalPlaidAccounts(plaidItemId, snapshots, syncedAt);
	}
}

export async function listFinancialAccountTransactions(
	accountId: string,
	limit = 500
): Promise<{
	transactions: FinancialAccountTransaction[];
	status: TransactionHistoryStatus;
	lastSyncedAt: string | null;
}> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
		throw new AppError('INVALID_REQUEST', 'The request is invalid.', 400);
	}
	const row = await getRow(accountId);
	const payload = row ? decodeRecord(row) : null;
	if (!row || payload?.recordType !== 'account') {
		throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.', 404);
	}
	if (row.source !== 'plaid') {
		throw new AppError(
			'TRANSACTION_HISTORY_UNAVAILABLE',
			'Transaction history is available for linked accounts only.',
			409
		);
	}
	const history = payload.transactionHistory;
	if (!history) {
		throw new AppError(
			'TRANSACTION_HISTORY_NOT_ENABLED',
			'Account activity has not been synced for this connection.',
			409
		);
	}
	const transactions = history.transactions
		.map<FinancialAccountTransaction>((transaction) => ({
			id: privateUuid(transaction.transactionId, `plaid-transaction:${accountId}`),
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

export async function listBonuses(): Promise<AccountBonus[]> {
	const bonuses: AccountBonus[] = [];
	for (const row of await listRows()) {
		if (row.source !== 'manual') continue;
		const payload = decodeRecord(row);
		if (payload?.recordType === 'bonus') bonuses.push(rowToBonus(row, payload));
	}
	return bonuses.sort((left, right) => {
		if (left.requirementDeadline && right.requirementDeadline) {
			return left.requirementDeadline.localeCompare(right.requirementDeadline);
		}
		if (left.requirementDeadline) return -1;
		if (right.requirementDeadline) return 1;
		return left.name.localeCompare(right.name);
	});
}

export async function getBonus(id: string): Promise<AccountBonus> {
	const row = await getRow(id);
	const payload = row ? decodeRecord(row) : null;
	if (!row || row.source !== 'manual' || payload?.recordType !== 'bonus') {
		throw new AppError('BONUS_NOT_FOUND', 'Bonus not found.', 404);
	}
	return rowToBonus(row, payload);
}

export async function createBonus(input: CreateBonusData): Promise<AccountBonus> {
	const id = randomUUID();
	const now = new Date().toISOString();
	await insertRecord(
		id,
		{ recordType: 'bonus', ...input, requirements: normalizeRequirements(input.requirements) },
		now
	);
	return getBonus(id);
}

export async function updateBonus(id: string, changes: UpdateBonusData): Promise<AccountBonus> {
	const existing = await getBonus(id);
	const payload: BonusPayload = {
		recordType: 'bonus',
		accountId: changes.accountId === undefined ? existing.accountId : changes.accountId,
		offerTemplateId:
			changes.offerTemplateId === undefined ? existing.offerTemplateId : changes.offerTemplateId,
		name: changes.name ?? existing.name,
		institution: changes.institution === undefined ? existing.institution : changes.institution,
		rewardCents: changes.rewardCents === undefined ? existing.rewardCents : changes.rewardCents,
		currency: changes.currency ?? existing.currency,
		status: changes.status ?? existing.status,
		openedDate: changes.openedDate === undefined ? existing.openedDate : changes.openedDate,
		requirementDeadline:
			changes.requirementDeadline === undefined
				? existing.requirementDeadline
				: changes.requirementDeadline,
		expectedPayoutDate:
			changes.expectedPayoutDate === undefined
				? existing.expectedPayoutDate
				: changes.expectedPayoutDate,
		paidDate: changes.paidDate === undefined ? existing.paidDate : changes.paidDate,
		safeToCloseDate:
			changes.safeToCloseDate === undefined ? existing.safeToCloseDate : changes.safeToCloseDate,
		requirements:
			changes.requirements === undefined
				? existing.requirements
				: normalizeRequirements(changes.requirements),
		notes: changes.notes === undefined ? existing.notes : changes.notes
	};
	await updateRecord(id, payload, new Date().toISOString());
	return getBonus(id);
}

export async function deleteBonus(id: string): Promise<void> {
	await getBonus(id);
	await deleteRecord(id);
}
