import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AccountBonus, BonusRequirement, FinancialAccount } from '$lib/types';
import { cloudQuery } from './cloud-database';
import { decryptJson, encryptJson } from './crypto';
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
	payload_enc: string;
	created_at: string;
	updated_at: string;
}

const dateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.nullable();
const nullableTextSchema = z.string().nullable();
const nullableCentsSchema = z.number().int().nullable();

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
	openedDate: dateSchema,
	notes: nullableTextSchema
});

const bonusPayloadSchema = z.object({
	recordType: z.literal('bonus'),
	accountId: z.string().uuid().nullable(),
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
		nickname: payload.nickname,
		institution: payload.institution,
		accountType: payload.accountType,
		ownerType: payload.ownerType,
		status: payload.status,
		last4: payload.last4,
		currency: payload.currency,
		currentBalanceCents: payload.currentBalanceCents,
		costBasisCents: payload.costBasisCents,
		openedDate: payload.openedDate,
		notes: payload.notes,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function rowToBonus(row: PrivateRecordRow, payload: BonusPayload): AccountBonus {
	return {
		id: row.id,
		accountId: payload.accountId,
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

async function listManualRows(): Promise<PrivateRecordRow[]> {
	return getRuntimeMode() === 'cloud'
		? await cloudQuery<PrivateRecordRow>(
				`SELECT id::text, payload_enc, created_at, updated_at
				 FROM public.carddue_cards WHERE source = 'manual'`
			)
		: (getDatabase()
				.prepare(
					`SELECT id, payload_enc, created_at, updated_at
					 FROM cards WHERE source = 'manual'`
				)
				.all() as PrivateRecordRow[]);
}

async function getManualRow(id: string): Promise<PrivateRecordRow | undefined> {
	return getRuntimeMode() === 'cloud'
		? (
				await cloudQuery<PrivateRecordRow>(
					`SELECT id::text, payload_enc, created_at, updated_at
					 FROM public.carddue_cards WHERE id = $1 AND source = 'manual'`,
					[id]
				)
			)[0]
		: (getDatabase()
				.prepare(
					`SELECT id, payload_enc, created_at, updated_at
					 FROM cards WHERE id = ? AND source = 'manual'`
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
			 WHERE id = $3 AND source = 'manual' RETURNING id::text`,
			[encrypted, now, id]
		);
		if (!rows[0]) throw new AppError('RECORD_NOT_FOUND', 'Record not found.', 404);
		return;
	}
	const result = getDatabase()
		.prepare(`UPDATE cards SET payload_enc = ?, updated_at = ? WHERE id = ? AND source = 'manual'`)
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
	for (const row of await listManualRows()) {
		const payload = decodeRecord(row);
		if (payload?.recordType === 'account') accounts.push(rowToAccount(row, payload));
	}
	return accounts.sort((left, right) => left.nickname.localeCompare(right.nickname));
}

export async function getFinancialAccount(id: string): Promise<FinancialAccount> {
	const row = await getManualRow(id);
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
	await insertRecord(id, { recordType: 'account', ...input }, now);
	return getFinancialAccount(id);
}

export async function updateFinancialAccount(
	id: string,
	changes: UpdateFinancialAccountData
): Promise<FinancialAccount> {
	const existing = await getFinancialAccount(id);
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
		openedDate: changes.openedDate === undefined ? existing.openedDate : changes.openedDate,
		notes: changes.notes === undefined ? existing.notes : changes.notes
	};
	await updateRecord(id, payload, new Date().toISOString());
	return getFinancialAccount(id);
}

export async function deleteFinancialAccount(id: string): Promise<void> {
	await getFinancialAccount(id);
	await deleteRecord(id);
}

export async function listBonuses(): Promise<AccountBonus[]> {
	const bonuses: AccountBonus[] = [];
	for (const row of await listManualRows()) {
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
	const row = await getManualRow(id);
	const payload = row ? decodeRecord(row) : null;
	if (!row || payload?.recordType !== 'bonus') {
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
