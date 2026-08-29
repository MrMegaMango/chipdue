import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
	normalizeTransactionHistoryStatus,
	type StoredTransactionHistoryStatus
} from '$lib/financial-data';
import type {
	AccountBonus,
	AccountBalanceHistoryPoint,
	BonusRequirement,
	FinancialDataProvider,
	FinancialAccount,
	FinancialAccountTransaction,
	InvestmentHolding,
	TransactionHistoryStatus
} from '$lib/types';
import type { StoredTransactionHistory } from './cards';
import { cloudQuery, cloudTransaction, type CloudStatement } from './cloud-database';
import { decryptJson, encryptJson } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';
import {
	providerAccountReference,
	providerForStoredSource,
	providerRecordId,
	providerTransactionId,
	publicSourceForStoredSource,
	storedSourceForProvider,
	type StoredRecordSource
} from './provider-storage';
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
import { payloadBelongsToCurrentTenant, tenantPayloadFields, tenantReference } from './tenant';

interface PrivateRecordRow extends Record<string, unknown> {
	id: string;
	source: StoredRecordSource;
	plaid_item_id: string | null;
	external_account_ref: string | null;
	payload_enc: string;
	last_synced_at: string | null;
	created_at: string;
	updated_at: string;
}

interface ConnectedAccountRow extends PrivateRecordRow {
	source: 'plaid';
	plaid_item_id: string;
	external_account_ref: string;
}

export interface ConnectedFinancialAccountSnapshot {
	accountId: string;
	nickname: string;
	institution: string | null;
	institutionLogoBase64: string | null;
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
const MAX_BALANCE_HISTORY_POINTS = 5_000;
const institutionLogoSchema = z
	.string()
	.min(1)
	.max(350_000)
	.regex(/^[A-Za-z0-9+/]+={0,2}$/)
	.nullable()
	.optional()
	.default(null);
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
const balanceHistoryPointSchema = z.object({
	recordedAt: z.string().refine((value) => Number.isFinite(new Date(value).getTime())),
	balanceCents: z.number().int().min(-100_000_000_000).max(100_000_000_000),
	source: z.enum(['observed', 'estimated']).optional(),
	netContributionsCents: z
		.number()
		.int()
		.min(-100_000_000_000)
		.max(100_000_000_000)
		.nullable()
		.optional()
});
const transactionHistoryStatusSchema = z
	.enum([
		'unknown',
		'preparing',
		'current',
		'historical_complete',
		'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
		'NOT_READY',
		'INITIAL_UPDATE_COMPLETE',
		'HISTORICAL_UPDATE_COMPLETE'
	])
	.transform((status) =>
		normalizeTransactionHistoryStatus(status as StoredTransactionHistoryStatus)
	);
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
	categoryDetailed: z.string().max(120).nullable(),
	investmentDetails: z
		.object({
			type: z.string().min(1).max(40),
			subtype: z.string().min(1).max(80),
			securityName: z.string().max(160).nullable(),
			tickerSymbol: z.string().max(32).nullable(),
			quantity: z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000),
			priceMicros: z.number().int().min(-100_000_000_000_000).max(100_000_000_000_000),
			feesCents: z.number().int().min(-100_000_000_000).max(100_000_000_000).nullable()
		})
		.optional()
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
	tenantRef: z
		.string()
		.regex(/^[A-Za-z0-9_-]{43}$/)
		.optional(),
	recordType: z.literal('account'),
	nickname: z.string(),
	institution: nullableTextSchema,
	institutionLogoBase64: institutionLogoSchema,
	accountType: financialAccountTypeSchema,
	ownerType: financialAccountOwnerSchema,
	status: financialAccountStatusSchema,
	hidden: z.boolean().optional().default(false),
	last4: nullableTextSchema,
	currency: z.string(),
	currentBalanceCents: nullableCentsSchema,
	apyBasisPoints: z.number().int().min(0).max(100_000).nullable().optional().default(null),
	costBasisCents: nullableCentsSchema,
	netContributionsCents: nullableCentsSchema.optional(),
	balanceHistory: z
		.array(balanceHistoryPointSchema)
		.max(MAX_BALANCE_HISTORY_POINTS)
		.optional()
		.default([]),
	holdings: z.array(investmentHoldingSchema).default([]),
	transactionHistory: storedTransactionHistorySchema.optional(),
	openedDate: dateSchema,
	notes: nullableTextSchema
});

const bonusPayloadSchema = z.object({
	tenantRef: z
		.string()
		.regex(/^[A-Za-z0-9_-]{43}$/)
		.optional(),
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

function appendBalanceHistoryPoint(
	history: AccountBalanceHistoryPoint[],
	accountType: AccountPayload['accountType'],
	balanceCents: number | null,
	netContributionsCents: number | null,
	recordedAt: string
): AccountBalanceHistoryPoint[] {
	if (accountType !== 'brokerage') return [];
	if (balanceCents === null || !Number.isFinite(new Date(recordedAt).getTime())) return history;

	const next = [
		...history,
		{ recordedAt, balanceCents, netContributionsCents, source: 'observed' as const }
	]
		.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
		.filter(
			(point, index, points) =>
				index === points.length - 1 || point.recordedAt !== points[index + 1].recordedAt
		);
	return next.slice(-MAX_BALANCE_HISTORY_POINTS);
}

function accountBalanceHistory(
	payload: AccountPayload,
	row: Pick<PrivateRecordRow, 'last_synced_at' | 'updated_at' | 'created_at'>
): AccountBalanceHistoryPoint[] {
	if (payload.accountType !== 'brokerage') return [];
	const netContributionsCents = accountNetContributions(payload);
	if (payload.balanceHistory.length > 0) {
		return payload.balanceHistory.map((point, index) => ({
			...point,
			source: point.source ?? 'observed',
			netContributionsCents:
				point.netContributionsCents === undefined
					? index === payload.balanceHistory.length - 1
						? netContributionsCents
						: null
					: point.netContributionsCents
		}));
	}
	if (payload.currentBalanceCents === null) return [];
	return [
		{
			recordedAt: row.last_synced_at ?? row.updated_at ?? row.created_at,
			balanceCents: payload.currentBalanceCents,
			netContributionsCents,
			source: 'observed'
		}
	];
}

export async function replaceEstimatedFinancialAccountHistory(
	id: string,
	estimatedPoints: AccountBalanceHistoryPoint[],
	options: { latestObservedNetContributionsCents?: number | null } = {}
): Promise<FinancialAccount> {
	const row = await getRow(id);
	const payload = row ? decodeRecord(row) : null;
	if (!row || payload?.recordType !== 'account') {
		throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.', 404);
	}
	if (payload.accountType !== 'brokerage') {
		throw new AppError(
			'ACCOUNT_NOT_BROKERAGE',
			'Historical estimates require a brokerage account.',
			409
		);
	}
	let observed = accountBalanceHistory(payload, row).filter((point) => point.source === 'observed');
	if (
		payload.netContributionsCents === null &&
		options.latestObservedNetContributionsCents !== undefined &&
		options.latestObservedNetContributionsCents !== null &&
		observed.length > 0
	) {
		observed = observed.map((point, index) =>
			index === observed.length - 1
				? {
						...point,
						netContributionsCents: options.latestObservedNetContributionsCents ?? null
					}
				: point
		);
	}
	const firstObservedAt = observed[0]?.recordedAt ?? null;
	const sanitized = estimatedPoints
		.filter(
			(point) =>
				point.source === 'estimated' &&
				Number.isSafeInteger(point.balanceCents) &&
				Number.isFinite(Date.parse(point.recordedAt)) &&
				(firstObservedAt === null || point.recordedAt < firstObservedAt)
		)
		.map((point) => ({ ...point, source: 'estimated' as const }));
	const balanceHistory = [...sanitized, ...observed]
		.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
		.filter(
			(point, index, points) =>
				index === points.length - 1 || point.recordedAt !== points[index + 1].recordedAt
		)
		.slice(-MAX_BALANCE_HISTORY_POINTS);
	await updateRecord(id, { ...payload, balanceHistory }, new Date().toISOString());
	return getFinancialAccount(id);
}

function accountNetContributions(payload: AccountPayload): number | null {
	if (payload.accountType !== 'brokerage') return null;
	return payload.netContributionsCents ?? null;
}

function decodeRecord(row: PrivateRecordRow): PrivateRecordPayload | null {
	// The legacy encryption context remains stable so existing cloud storage needs no migration.
	const payload = decryptJson<unknown>(row.payload_enc, `card:${row.id}`);
	if (!payload || typeof payload !== 'object' || !('recordType' in payload)) return null;
	if (!payloadBelongsToCurrentTenant(payload as { tenantRef?: unknown })) return null;
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
		source: publicSourceForStoredSource(row.source),
		nickname: payload.nickname,
		institution: payload.institution,
		institutionLogoUrl: payload.institutionLogoBase64
			? `data:image/png;base64,${payload.institutionLogoBase64}`
			: null,
		accountType: payload.accountType,
		ownerType: payload.ownerType,
		status: payload.status,
		hidden: payload.hidden,
		last4: payload.last4,
		currency: payload.currency,
		currentBalanceCents: payload.currentBalanceCents,
		apyBasisPoints: payload.apyBasisPoints,
		costBasisCents: payload.costBasisCents,
		netContributionsCents: accountNetContributions(payload),
		balanceHistory: accountBalanceHistory(payload, row),
		holdings: payload.holdings,
		transactionHistoryEnabled: payload.transactionHistory?.enabled === true,
		transactionHistoryStatus: payload.transactionHistory?.status ?? null,
		openedDate: payload.openedDate,
		notes: payload.notes,
		connectionId: row.source === 'manual' ? null : row.plaid_item_id,
		connectionProvider: providerForStoredSource(row.source),
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

async function getRow(id: string): Promise<PrivateRecordRow | undefined> {
	return getRuntimeMode() === 'cloud'
		? (
				await cloudQuery<PrivateRecordRow>(
					`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
					        last_synced_at, created_at, updated_at
					 FROM public.carddue_cards WHERE tenant_ref = $1 AND id = $2`,
					[tenantReference(), id]
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
	const encrypted = encryptJson({ ...payload, ...tenantPayloadFields() }, `card:${id}`);
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`INSERT INTO public.carddue_cards
			 (id, source, plaid_item_id, external_account_ref, payload_enc,
			  last_synced_at, created_at, updated_at, tenant_ref)
			 VALUES ($1, 'manual', NULL, NULL, $2, NULL, $3, $3, $4)`,
			[id, encrypted, now, tenantReference()]
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
	const encrypted = encryptJson({ ...payload, ...tenantPayloadFields() }, `card:${id}`);
	if (getRuntimeMode() === 'cloud') {
		const rows = await cloudQuery<{ id: string }>(
			`UPDATE public.carddue_cards SET payload_enc = $1, updated_at = $2
			 WHERE tenant_ref = $3 AND id = $4 RETURNING id::text`,
			[encrypted, now, tenantReference(), id]
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
		await cloudQuery(
			`DELETE FROM public.carddue_cards
			 WHERE tenant_ref = $1 AND id = $2 AND source = 'manual'`,
			[tenantReference(), id]
		);
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
	await insertRecord(
		id,
		{
			recordType: 'account',
			...input,
			institutionLogoBase64: null,
			hidden: false,
			balanceHistory: appendBalanceHistoryPoint(
				[],
				input.accountType,
				input.currentBalanceCents,
				input.netContributionsCents,
				now
			),
			holdings: []
		},
		now
	);
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
		existing.source === 'connected' &&
		(changes.institution !== undefined ||
			changes.accountType !== undefined ||
			changes.status !== undefined ||
			changes.last4 !== undefined ||
			changes.currency !== undefined ||
			changes.currentBalanceCents !== undefined)
	) {
		throw new AppError(
			'CONNECTED_ACCOUNT_READ_ONLY',
			'Synced account balances and institution details are updated through its provider.',
			409
		);
	}
	const accountType = changes.accountType ?? existing.accountType;
	const currentBalanceCents =
		changes.currentBalanceCents === undefined
			? existing.currentBalanceCents
			: changes.currentBalanceCents;
	const netContributionsCents =
		changes.netContributionsCents === undefined
			? existing.netContributionsCents
			: changes.netContributionsCents;
	const shouldRecordBalance =
		accountType === 'brokerage' &&
		currentBalanceCents !== null &&
		(existing.accountType !== 'brokerage' ||
			(changes.currentBalanceCents !== undefined &&
				changes.currentBalanceCents !== existing.currentBalanceCents) ||
			(changes.netContributionsCents !== undefined &&
				changes.netContributionsCents !== existing.netContributionsCents));
	const now = new Date().toISOString();
	const payload: AccountPayload = {
		recordType: 'account',
		nickname: changes.nickname ?? existing.nickname,
		institution: changes.institution === undefined ? existing.institution : changes.institution,
		institutionLogoBase64: existingPayload.institutionLogoBase64,
		accountType,
		ownerType: changes.ownerType ?? existing.ownerType,
		status: changes.status ?? existing.status,
		hidden: changes.hidden ?? existing.hidden,
		last4: changes.last4 === undefined ? existing.last4 : changes.last4,
		currency: changes.currency ?? existing.currency,
		currentBalanceCents,
		apyBasisPoints:
			changes.apyBasisPoints === undefined ? existing.apyBasisPoints : changes.apyBasisPoints,
		costBasisCents:
			changes.costBasisCents === undefined ? existing.costBasisCents : changes.costBasisCents,
		netContributionsCents: accountType === 'brokerage' ? netContributionsCents : null,
		balanceHistory: shouldRecordBalance
			? appendBalanceHistoryPoint(
					accountBalanceHistory(existingPayload, row),
					accountType,
					currentBalanceCents,
					netContributionsCents,
					now
				)
			: accountType === 'brokerage'
				? accountBalanceHistory(existingPayload, row)
				: [],
		holdings: existing.holdings,
		transactionHistory: existingPayload.transactionHistory,
		openedDate: changes.openedDate === undefined ? existing.openedDate : changes.openedDate,
		notes: changes.notes === undefined ? existing.notes : changes.notes
	};
	await updateRecord(id, payload, now);
	return getFinancialAccount(id);
}

export async function deleteFinancialAccount(id: string): Promise<void> {
	const existing = await getFinancialAccount(id);
	if (existing.source === 'connected') {
		throw new AppError(
			'CONNECTED_ACCOUNT_READ_ONLY',
			'Disconnect the institution to remove a synced account.',
			409
		);
	}
	await deleteRecord(id);
}

function connectedAccountPayload(
	snapshot: ConnectedFinancialAccountSnapshot,
	syncedAt: string,
	existing?: { payload: AccountPayload; row: PrivateRecordRow }
): AccountPayload {
	const existingPayload = existing?.payload;
	const history = existingPayload ? accountBalanceHistory(existingPayload, existing.row) : [];
	const netContributionsCents = existingPayload?.netContributionsCents ?? null;
	return {
		...tenantPayloadFields(),
		recordType: 'account',
		nickname: existingPayload?.nickname ?? snapshot.nickname,
		institution: snapshot.institution,
		institutionLogoBase64:
			snapshot.institutionLogoBase64 ?? existingPayload?.institutionLogoBase64 ?? null,
		accountType: snapshot.accountType,
		ownerType: existingPayload?.ownerType ?? 'personal',
		status: existingPayload?.status ?? 'active',
		hidden: existingPayload?.hidden ?? false,
		last4: snapshot.last4,
		currency: snapshot.currency,
		currentBalanceCents: snapshot.currentBalanceCents,
		apyBasisPoints: existingPayload?.apyBasisPoints ?? null,
		costBasisCents: snapshot.costBasisCents ?? existingPayload?.costBasisCents ?? null,
		netContributionsCents,
		balanceHistory: appendBalanceHistoryPoint(
			history,
			snapshot.accountType,
			snapshot.currentBalanceCents,
			netContributionsCents,
			syncedAt
		),
		holdings: snapshot.holdings ?? existingPayload?.holdings ?? [],
		transactionHistory: snapshot.transactionHistory ?? existingPayload?.transactionHistory,
		openedDate: existingPayload?.openedDate ?? null,
		notes: existingPayload?.notes ?? null
	};
}

function accountRows(rows: PrivateRecordRow[]): Array<{
	row: ConnectedAccountRow;
	payload: AccountPayload;
}> {
	return rows.flatMap((row) => {
		if (row.source === 'manual' || !row.plaid_item_id || !row.external_account_ref) {
			return [];
		}
		const payload = decodeRecord(row);
		return payload?.recordType === 'account' ? [{ row: row as ConnectedAccountRow, payload }] : [];
	});
}

async function replaceCloudConnectedAccounts(
	provider: FinancialDataProvider,
	connectionId: string,
	snapshots: ConnectedFinancialAccountSnapshot[],
	syncedAt: string
): Promise<void> {
	const storedSource = storedSourceForProvider(provider);
	const tenantRef = tenantReference();
	const existing = accountRows(
		await cloudQuery<PrivateRecordRow>(
			`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
			        last_synced_at, created_at, updated_at
			 FROM public.carddue_cards
			 WHERE tenant_ref = $1 AND plaid_item_id = $2 AND source = $3`,
			[tenantRef, connectionId, storedSource]
		)
	);
	const existingByReference = new Map(
		existing.map(({ row, payload }) => [row.external_account_ref, { row, payload }])
	);
	const seenIds = new Set<string>();
	const statements: CloudStatement[] = [];

	for (const snapshot of snapshots) {
		const reference = providerAccountReference(provider, snapshot.accountId, 'account');
		const current = existingByReference.get(reference);
		const id =
			current?.row.id ?? providerRecordId(provider, snapshot.accountId, connectionId, 'account');
		seenIds.add(id);
		const encrypted = encryptJson(
			connectedAccountPayload(
				snapshot,
				syncedAt,
				current
					? {
							payload: current.payload,
							row: current.row
						}
					: undefined
			),
			`card:${id}`
		);
		statements.push({
			text: `INSERT INTO public.carddue_cards
			       (id, source, plaid_item_id, external_account_ref, payload_enc,
			        last_synced_at, created_at, updated_at, tenant_ref)
			       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)
			       ON CONFLICT (plaid_item_id, external_account_ref) DO UPDATE SET
			       payload_enc = EXCLUDED.payload_enc,
			       last_synced_at = EXCLUDED.last_synced_at,
			       tenant_ref = EXCLUDED.tenant_ref,
			       updated_at = EXCLUDED.updated_at`,
			params: [id, storedSource, connectionId, reference, encrypted, syncedAt, tenantRef]
		});
	}

	for (const { row } of existing) {
		if (!seenIds.has(row.id)) {
			statements.push({
				text: `DELETE FROM public.carddue_cards
				       WHERE tenant_ref = $1 AND id = $2 AND source = $3`,
				params: [tenantRef, row.id, storedSource]
			});
		}
	}
	if (statements.length > 0) await cloudTransaction(statements);
}

function replaceLocalConnectedAccounts(
	provider: FinancialDataProvider,
	connectionId: string,
	snapshots: ConnectedFinancialAccountSnapshot[],
	syncedAt: string
): void {
	const storedSource = storedSourceForProvider(provider);
	const database = getDatabase();
	const transaction = database.transaction(() => {
		const existing = accountRows(
			database
				.prepare(
					`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
					        last_synced_at, created_at, updated_at
					 FROM cards WHERE plaid_item_id = ? AND source = ?`
				)
				.all(connectionId, storedSource) as PrivateRecordRow[]
		);
		const existingByReference = new Map(
			existing.map(({ row, payload }) => [row.external_account_ref, { row, payload }])
		);
		const seenIds = new Set<string>();

		for (const snapshot of snapshots) {
			const reference = providerAccountReference(provider, snapshot.accountId, 'account');
			const current = existingByReference.get(reference);
			const id = current?.row.id ?? randomUUID();
			seenIds.add(id);
			const encrypted = encryptJson(
				connectedAccountPayload(
					snapshot,
					syncedAt,
					current
						? {
								payload: current.payload,
								row: current.row
							}
						: undefined
				),
				`card:${id}`
			);
			if (current) {
				database
					.prepare(
						`UPDATE cards SET payload_enc = ?, last_synced_at = ?, updated_at = ?
						 WHERE id = ? AND source = ?`
					)
					.run(encrypted, syncedAt, syncedAt, id, storedSource);
			} else {
				database
					.prepare(
						`INSERT INTO cards
						 (id, source, plaid_item_id, external_account_ref, payload_enc,
						  last_synced_at, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.run(id, storedSource, connectionId, reference, encrypted, syncedAt, syncedAt, syncedAt);
			}
		}

		for (const { row } of existing) {
			if (!seenIds.has(row.id)) {
				database.prepare(`DELETE FROM cards WHERE id = ? AND source = ?`).run(row.id, storedSource);
			}
		}
	});
	transaction();
}

export async function replaceConnectedFinancialAccounts(
	provider: FinancialDataProvider,
	connectionId: string,
	snapshots: ConnectedFinancialAccountSnapshot[],
	syncedAt: string
): Promise<void> {
	if (getRuntimeMode() === 'cloud') {
		await replaceCloudConnectedAccounts(provider, connectionId, snapshots, syncedAt);
	} else {
		replaceLocalConnectedAccounts(provider, connectionId, snapshots, syncedAt);
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
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
		throw new AppError('INVALID_REQUEST', 'The request is invalid.', 400);
	}
	const row = await getRow(accountId);
	const payload = row ? decodeRecord(row) : null;
	if (!row || payload?.recordType !== 'account') {
		throw new AppError('ACCOUNT_NOT_FOUND', 'Account not found.', 404);
	}
	if (row.source === 'manual') {
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
			id: providerTransactionId(
				providerForStoredSource(row.source)!,
				transaction.transactionId,
				accountId
			),
			name: transaction.name,
			merchantName: transaction.merchantName,
			amountCents: transaction.amountCents,
			currency: transaction.currency,
			date: transaction.date,
			authorizedDate: transaction.authorizedDate,
			pending: transaction.pending,
			categoryPrimary: transaction.categoryPrimary,
			categoryDetailed: transaction.categoryDetailed,
			...(transaction.investmentDetails ? { investmentDetails: transaction.investmentDetails } : {})
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
