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
	apyBasisPoints?: number | null;
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
	apySource: z.enum(['provider', 'manual']).nullable().optional().default(null),
	apyUpdatedAt: nullableTextSchema.optional().default(null),
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
	cardId: z.string().uuid().nullable().optional().default(null),
	offerTemplateId: z.string().max(100).nullable().optional().default(null),
	offerDateOverrideConfirmed: z.boolean().optional().default(false),
	name: z.string(),
	institution: nullableTextSchema,
	rewardCents: nullableCentsSchema,
	spendTargetCents: nullableCentsSchema.optional().default(null),
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

function accountApySource(payload: AccountPayload): AccountPayload['apySource'] {
	if (payload.apyBasisPoints === null) return null;
	return payload.apySource ?? 'manual';
}

function accountApyUpdatedAt(payload: AccountPayload, row: PrivateRecordRow): string | null {
	if (payload.apyBasisPoints === null) return null;
	return (
		payload.apyUpdatedAt ??
		(accountApySource(payload) === 'provider' ? row.last_synced_at : row.updated_at)
	);
}

function appendBalanceHistoryPoint(
	history: AccountBalanceHistoryPoint[],
	balanceCents: number | null,
	netContributionsCents: number | null,
	recordedAt: string
): AccountBalanceHistoryPoint[] {
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
	const netContributionsCents = accountNetContributions(payload);
	if (payload.balanceHistory.length > 0) {
		return payload.balanceHistory.map((point, index) => ({
			...point,
			source: point.source ?? 'observed',
			netContributionsCents:
				payload.accountType !== 'brokerage'
					? null
					: point.netContributionsCents === undefined
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
		apySource: accountApySource(payload),
		apyUpdatedAt: accountApyUpdatedAt(payload, row),
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

type FinancialAccountCandidate = {
	row: PrivateRecordRow;
	payload: AccountPayload;
	account: FinancialAccount;
};

function observedHistoryCount(candidate: FinancialAccountCandidate): number {
	return candidate.account.balanceHistory.filter((point) => point.source === 'observed').length;
}

function preferCanonicalAccount(
	left: FinancialAccountCandidate,
	right: FinancialAccountCandidate
): FinancialAccountCandidate {
	const observedComparison = observedHistoryCount(left) - observedHistoryCount(right);
	if (observedComparison !== 0) return observedComparison > 0 ? left : right;

	const historyComparison =
		left.account.balanceHistory.length - right.account.balanceHistory.length;
	if (historyComparison !== 0) return historyComparison > 0 ? left : right;

	const syncComparison = (left.account.lastSyncedAt ?? '').localeCompare(
		right.account.lastSyncedAt ?? ''
	);
	if (syncComparison !== 0) return syncComparison > 0 ? left : right;

	const updateComparison = left.account.updatedAt.localeCompare(right.account.updatedAt);
	if (updateComparison !== 0) return updateComparison > 0 ? left : right;

	return left.account.id.localeCompare(right.account.id) > 0 ? left : right;
}

function connectedBrokerageDisplayIdentity(account: FinancialAccount): string | null {
	const institution = account.institution?.trim().toLocaleLowerCase();
	const nickname = account.nickname.trim().toLocaleLowerCase();
	if (account.accountType !== 'brokerage' || !institution || !nickname || !account.last4) {
		return null;
	}
	return [institution, nickname, account.last4.toLocaleLowerCase(), account.currency].join(
		'\u0000'
	);
}

function financialAccountCandidates(rows: PrivateRecordRow[]): FinancialAccountCandidate[] {
	return rows.flatMap((row) => {
		const payload = decodeRecord(row);
		return payload?.recordType === 'account'
			? [{ row, payload, account: rowToAccount(row, payload) }]
			: [];
	});
}

function uniqueFinancialAccounts(rows: PrivateRecordRow[]): FinancialAccount[] {
	const accounts: FinancialAccount[] = [];
	const connectedBrokeragesByProviderReference = new Map<string, FinancialAccountCandidate>();

	for (const candidate of financialAccountCandidates(rows)) {
		const { row, account } = candidate;
		if (
			account.accountType !== 'brokerage' ||
			row.source === 'manual' ||
			!row.external_account_ref
		) {
			accounts.push(account);
			continue;
		}

		const current = connectedBrokeragesByProviderReference.get(row.external_account_ref);
		connectedBrokeragesByProviderReference.set(
			row.external_account_ref,
			current ? preferCanonicalAccount(current, candidate) : candidate
		);
	}

	const unmatchedBrokerages: FinancialAccount[] = [];
	const brokeragesByDisplayIdentity = new Map<string, Map<string, FinancialAccountCandidate[]>>();
	for (const candidate of connectedBrokeragesByProviderReference.values()) {
		const displayIdentity = connectedBrokerageDisplayIdentity(candidate.account);
		const connectionId = candidate.row.plaid_item_id;
		if (!displayIdentity || !connectionId) {
			unmatchedBrokerages.push(candidate.account);
			continue;
		}

		const byConnection = brokeragesByDisplayIdentity.get(displayIdentity) ?? new Map();
		const connectionBrokerages = byConnection.get(connectionId) ?? [];
		connectionBrokerages.push(candidate);
		byConnection.set(connectionId, connectionBrokerages);
		brokeragesByDisplayIdentity.set(displayIdentity, byConnection);
	}

	for (const byConnection of brokeragesByDisplayIdentity.values()) {
		let preferredConnection: FinancialAccountCandidate[] | undefined;
		let preferredAccount: FinancialAccountCandidate | undefined;
		for (const connectionBrokerages of byConnection.values()) {
			const bestAccount = connectionBrokerages.reduce(preferCanonicalAccount);
			if (
				!preferredConnection ||
				connectionBrokerages.length > preferredConnection.length ||
				(connectionBrokerages.length === preferredConnection.length &&
					(!preferredAccount ||
						preferCanonicalAccount(preferredAccount, bestAccount) === bestAccount))
			) {
				preferredConnection = connectionBrokerages;
				preferredAccount = bestAccount;
			}
		}
		accounts.push(...(preferredConnection ?? []).map(({ account }) => account));
	}

	return [...accounts, ...unmatchedBrokerages];
}

function rowToBonus(row: PrivateRecordRow, payload: BonusPayload): AccountBonus {
	return {
		id: row.id,
		accountId: payload.accountId,
		cardId: payload.cardId,
		offerTemplateId: payload.offerTemplateId,
		offerDateOverrideConfirmed: payload.offerDateOverrideConfirmed,
		name: payload.name,
		institution: payload.institution,
		rewardCents: payload.rewardCents,
		spendTargetCents: payload.spendTargetCents,
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
	return uniqueFinancialAccounts(await listRows()).sort((left, right) =>
		left.nickname.localeCompare(right.nickname)
	);
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
			apySource: input.apyBasisPoints === null ? null : 'manual',
			apyUpdatedAt: input.apyBasisPoints === null ? null : now,
			balanceHistory: appendBalanceHistoryPoint(
				[],
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
		currentBalanceCents !== null &&
		(existing.accountType !== accountType ||
			(changes.currentBalanceCents !== undefined &&
				changes.currentBalanceCents !== existing.currentBalanceCents) ||
			(accountType === 'brokerage' &&
				changes.netContributionsCents !== undefined &&
				changes.netContributionsCents !== existing.netContributionsCents));
	const now = new Date().toISOString();
	const apyBasisPoints =
		changes.apyBasisPoints === undefined ? existing.apyBasisPoints : changes.apyBasisPoints;
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
		apyBasisPoints,
		apySource:
			changes.apyBasisPoints === undefined
				? accountApySource(existingPayload)
				: apyBasisPoints === null
					? null
					: 'manual',
		apyUpdatedAt:
			changes.apyBasisPoints === undefined
				? accountApyUpdatedAt(existingPayload, row)
				: apyBasisPoints === null
					? null
					: now,
		costBasisCents:
			changes.costBasisCents === undefined ? existing.costBasisCents : changes.costBasisCents,
		netContributionsCents: accountType === 'brokerage' ? netContributionsCents : null,
		balanceHistory: shouldRecordBalance
			? appendBalanceHistoryPoint(
					accountBalanceHistory(existingPayload, row),
					currentBalanceCents,
					accountType === 'brokerage' ? netContributionsCents : null,
					now
				)
			: accountBalanceHistory(existingPayload, row),
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
	const providerApyBasisPoints = snapshot.apyBasisPoints ?? null;
	const manualApyBasisPoints =
		existingPayload && accountApySource(existingPayload) === 'manual'
			? existingPayload.apyBasisPoints
			: null;
	const apyBasisPoints = providerApyBasisPoints ?? manualApyBasisPoints;
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
		apyBasisPoints,
		apySource:
			providerApyBasisPoints !== null ? 'provider' : apyBasisPoints !== null ? 'manual' : null,
		apyUpdatedAt:
			providerApyBasisPoints !== null
				? syncedAt
				: existingPayload && manualApyBasisPoints !== null
					? accountApyUpdatedAt(existingPayload, existing.row)
					: null,
		costBasisCents: snapshot.costBasisCents ?? existingPayload?.costBasisCents ?? null,
		netContributionsCents,
		balanceHistory: appendBalanceHistoryPoint(
			history,
			snapshot.currentBalanceCents,
			snapshot.accountType === 'brokerage' ? netContributionsCents : null,
			syncedAt
		),
		holdings: snapshot.holdings ?? existingPayload?.holdings ?? [],
		transactionHistory: snapshot.transactionHistory ?? existingPayload?.transactionHistory,
		openedDate: existingPayload?.openedDate ?? null,
		notes: existingPayload?.notes ?? null
	};
}

function mergeObservedBalanceHistory(
	target: FinancialAccountCandidate,
	source: FinancialAccountCandidate
): AccountBalanceHistoryPoint[] {
	const mergedByRecordedAt = new Map(
		target.account.balanceHistory.map((point) => [point.recordedAt, point])
	);
	for (const point of source.account.balanceHistory) {
		if (point.source === 'observed' && !mergedByRecordedAt.has(point.recordedAt)) {
			mergedByRecordedAt.set(point.recordedAt, point);
		}
	}
	return [...mergedByRecordedAt.values()]
		.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
		.slice(-MAX_BALANCE_HISTORY_POINTS);
}

const TRANSACTION_STATUS_RANK: Record<TransactionHistoryStatus, number> = {
	unknown: 0,
	preparing: 1,
	current: 2,
	historical_complete: 3
};

function mergeTransactionHistory(
	targetAccountReference: string | null,
	target: StoredTransactionHistory | undefined,
	source: StoredTransactionHistory | undefined
): StoredTransactionHistory | undefined {
	if (!source) return target;
	if (!target) {
		return {
			...source,
			accountReference: targetAccountReference ?? source.accountReference
		};
	}
	const transactions = new Map(
		source.transactions.map((transaction) => [transaction.transactionId, transaction])
	);
	for (const transaction of target.transactions)
		transactions.set(transaction.transactionId, transaction);
	return {
		...target,
		accountReference: target.accountReference ?? targetAccountReference ?? source.accountReference,
		status:
			TRANSACTION_STATUS_RANK[source.status] > TRANSACTION_STATUS_RANK[target.status]
				? source.status
				: target.status,
		transactions: [...transactions.values()]
			.sort((left, right) => {
				const dateComparison = right.date.localeCompare(left.date);
				return dateComparison !== 0
					? dateComparison
					: left.transactionId.localeCompare(right.transactionId);
			})
			.slice(0, 10_000)
	};
}

function matchingConsolidationTarget(
	source: FinancialAccountCandidate,
	allSources: FinancialAccountCandidate[],
	remaining: FinancialAccountCandidate[]
): FinancialAccountCandidate | null {
	const exactReferenceMatches = remaining.filter(
		(candidate) => candidate.row.external_account_ref === source.row.external_account_ref
	);
	if (exactReferenceMatches.length > 0) return exactReferenceMatches.reduce(preferCanonicalAccount);

	const identity = connectedBrokerageDisplayIdentity(source.account);
	if (!identity) return null;
	const sourceIdentityMatches = allSources.filter(
		(candidate) => connectedBrokerageDisplayIdentity(candidate.account) === identity
	);
	if (sourceIdentityMatches.length !== 1) return null;
	const identityMatches = remaining.filter(
		(candidate) => connectedBrokerageDisplayIdentity(candidate.account) === identity
	);
	const matchesPerConnection = new Map<string, number>();
	for (const candidate of identityMatches) {
		const connectionId = candidate.row.plaid_item_id;
		if (!connectionId) continue;
		matchesPerConnection.set(connectionId, (matchesPerConnection.get(connectionId) ?? 0) + 1);
	}
	if (
		identityMatches.length === 0 ||
		[...matchesPerConnection.values()].some((count) => count !== 1)
	) {
		return null;
	}
	return identityMatches.reduce(preferCanonicalAccount);
}

export async function consolidateConnectedFinancialAccountsBeforeDisconnect(
	provider: FinancialDataProvider,
	sourceConnectionId: string
): Promise<{
	mergedAccountCount: number;
	addedObservedPointCount: number;
	addedTransactionCount: number;
}> {
	const storedSource = storedSourceForProvider(provider);
	const candidates = financialAccountCandidates(await listRows()).filter(
		(candidate) => candidate.row.source === storedSource && candidate.row.plaid_item_id
	);
	const sources = candidates.filter(
		(candidate) => candidate.row.plaid_item_id === sourceConnectionId
	);
	const remaining = candidates.filter(
		(candidate) => candidate.row.plaid_item_id !== sourceConnectionId
	);
	let mergedAccountCount = 0;
	let addedObservedPointCount = 0;
	let addedTransactionCount = 0;

	for (const source of sources) {
		const target = matchingConsolidationTarget(source, sources, remaining);
		if (!target) continue;
		const balanceHistory = mergeObservedBalanceHistory(target, source);
		const transactionHistory = mergeTransactionHistory(
			target.row.external_account_ref,
			target.payload.transactionHistory,
			source.payload.transactionHistory
		);
		const targetObservedCount = target.account.balanceHistory.filter(
			(point) => point.source === 'observed'
		).length;
		const mergedObservedCount = balanceHistory.filter(
			(point) => point.source === 'observed'
		).length;
		const targetTransactionCount = target.payload.transactionHistory?.transactions.length ?? 0;
		const mergedTransactionCount = transactionHistory?.transactions.length ?? 0;
		const transactionStatusChanged =
			transactionHistory?.status !== target.payload.transactionHistory?.status;
		if (
			balanceHistory.length === target.account.balanceHistory.length &&
			mergedTransactionCount === targetTransactionCount &&
			!transactionStatusChanged
		) {
			continue;
		}

		const now = new Date().toISOString();
		const payload = { ...target.payload, balanceHistory, transactionHistory };
		await updateRecord(target.row.id, payload, now);
		target.payload = payload;
		target.account = rowToAccount({ ...target.row, updated_at: now }, payload);
		mergedAccountCount += 1;
		addedObservedPointCount += Math.max(0, mergedObservedCount - targetObservedCount);
		addedTransactionCount += Math.max(0, mergedTransactionCount - targetTransactionCount);
	}

	return { mergedAccountCount, addedObservedPointCount, addedTransactionCount };
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
		cardId: changes.cardId === undefined ? existing.cardId : changes.cardId,
		offerTemplateId:
			changes.offerTemplateId === undefined ? existing.offerTemplateId : changes.offerTemplateId,
		offerDateOverrideConfirmed:
			changes.offerDateOverrideConfirmed === undefined
				? existing.offerDateOverrideConfirmed
				: changes.offerDateOverrideConfirmed,
		name: changes.name ?? existing.name,
		institution: changes.institution === undefined ? existing.institution : changes.institution,
		rewardCents: changes.rewardCents === undefined ? existing.rewardCents : changes.rewardCents,
		spendTargetCents:
			changes.spendTargetCents === undefined ? existing.spendTargetCents : changes.spendTargetCents,
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
