import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
	EMERGENCY_TRANSACTION_LIMIT,
	type EmergencyActivity,
	type EmergencySnapshot
} from '$lib/emergency';
import { cardsFromRows, cardTransactionsFromRow } from './cards';
import {
	bonusesFromRows,
	financialAccountsFromRows,
	financialAccountTransactionsFromRow
} from './financial-records';
import { AppError } from './errors';
import {
	emergencyStorageConfigured,
	readEmergencyObject,
	writeEmergencyObject
} from './emergency-store';
import type { PrivateRecordRow } from './record-rows';
import { currentTenantId, isTenantId, tenantReference } from './tenant';

const MAX_SNAPSHOT_BYTES = 3_000_000;
const MAX_PUBLISH_ATTEMPTS = 3;
const nullableText = z.string().nullable();
const nullableAmount = z.number().finite().nullable();
const historyStatus = z.enum(['unknown', 'preparing', 'current', 'historical_complete']);
const recordView = z.object({
	id: z.string().min(1),
	currency: z.string(),
	createdAt: z.string(),
	updatedAt: z.string()
});
const accountView = recordView.extend({
	source: z.enum(['manual', 'connected']),
	nickname: z.string(),
	currentBalanceCents: nullableAmount,
	lastSyncedAt: nullableText,
	transactionHistoryEnabled: z.boolean(),
	transactionHistoryStatus: historyStatus.nullable()
});
const transactionView = z
	.object({
		id: z.string().min(1),
		name: z.string(),
		merchantName: nullableText,
		amountCents: z.number().finite(),
		currency: z.string(),
		date: z.string(),
		authorizedDate: nullableText,
		pending: z.boolean(),
		categoryPrimary: nullableText,
		categoryDetailed: nullableText
	})
	.passthrough();

// These are authenticated, server-generated public views. Validate their version,
// container shape and values used by the fallback, while existing row converters
// remain the source of truth for the complete financial record schemas.
const snapshotShape = z
	.object({
		version: z.literal(1),
		capturedAt: z.iso.datetime(),
		transactionLimit: z.literal(EMERGENCY_TRANSACTION_LIMIT),
		cards: z.array(
			accountView
				.extend({
					issuerLogoUrl: z.null(),
					statementBalanceCents: nullableAmount,
					minimumPaymentCents: nullableAmount,
					dueDate: nullableText,
					rewardCategories: z.array(z.object({ id: z.string(), name: z.string() }).passthrough())
				})
				.passthrough()
		),
		accounts: z.array(
			accountView
				.extend({
					institutionLogoUrl: z.null(),
					accountType: z.enum(['checking', 'savings', 'brokerage', 'cash_management', 'other']),
					status: z.enum(['planned', 'active', 'closed']),
					hidden: z.boolean(),
					balanceHistory: z.array(
						z.object({ recordedAt: z.string(), balanceCents: z.number().finite() }).passthrough()
					),
					holdings: z.array(
						z
							.object({
								name: z.string(),
								quantity: z.number().finite(),
								valueCents: nullableAmount
							})
							.passthrough()
					)
				})
				.passthrough()
		),
		bonuses: z.array(
			recordView
				.extend({
					name: z.string(),
					rewardCents: nullableAmount,
					spendTargetCents: nullableAmount,
					status: z.enum([
						'planned',
						'active',
						'qualified',
						'pending',
						'paid',
						'closed',
						'abandoned'
					]),
					requirements: z.array(
						z.object({ id: z.string(), label: z.string(), completed: z.boolean() }).passthrough()
					)
				})
				.passthrough()
		),
		activity: z.array(
			z.object({
				id: z.string().min(1),
				kind: z.enum(['card', 'account']),
				name: z.string(),
				lastSyncedAt: nullableText,
				status: historyStatus,
				transactions: z.array(transactionView).max(EMERGENCY_TRANSACTION_LIMIT)
			})
		)
	})
	.strict();

interface StoredSnapshot {
	tenantId: string;
	snapshot: EmergencySnapshot;
	contentHash: string;
}

function invalidSnapshot(): AppError {
	return new AppError(
		'EMERGENCY_SNAPSHOT_INVALID',
		'The saved financial snapshot could not be read.',
		503
	);
}

function contentHash(snapshot: EmergencySnapshot): string {
	return createHash('sha256')
		.update(JSON.stringify({ ...snapshot, capturedAt: undefined }))
		.digest('hex');
}

function validateStoredSnapshot(value: unknown, tenantId: string): StoredSnapshot {
	if (!value || typeof value !== 'object') throw invalidSnapshot();
	const stored = value as Partial<StoredSnapshot>;
	if (
		stored.tenantId !== tenantId ||
		typeof stored.contentHash !== 'string' ||
		!/^[a-f0-9]{64}$/.test(stored.contentHash) ||
		Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SNAPSHOT_BYTES ||
		!snapshotShape.safeParse(stored.snapshot).success
	)
		throw invalidSnapshot();
	const snapshot = stored.snapshot as EmergencySnapshot;
	if (contentHash(snapshot) !== stored.contentHash) throw invalidSnapshot();
	const cards = new Set(snapshot.cards.map((card) => card.id));
	const accounts = new Set(snapshot.accounts.map((account) => account.id));
	if (
		snapshot.activity.some((entry) => !(entry.kind === 'card' ? cards : accounts).has(entry.id))
	) {
		throw invalidSnapshot();
	}
	return { tenantId, snapshot, contentHash: stored.contentHash };
}

function activityFromRows(
	rows: PrivateRecordRow[],
	cards: EmergencySnapshot['cards'],
	accounts: EmergencySnapshot['accounts']
): EmergencyActivity[] {
	const rowsById = new Map(rows.map((row) => [row.id, row]));
	const activity: EmergencyActivity[] = [];
	for (const [kind, records] of [
		['card', cards],
		['account', accounts]
	] as const) {
		for (const record of records) {
			const row = rowsById.get(record.id);
			if (!row) throw invalidSnapshot();
			try {
				const history =
					kind === 'card'
						? cardTransactionsFromRow(row, EMERGENCY_TRANSACTION_LIMIT)
						: financialAccountTransactionsFromRow(row, EMERGENCY_TRANSACTION_LIMIT);
				activity.push({
					id: record.id,
					kind,
					name: record.nickname,
					lastSyncedAt: history.lastSyncedAt,
					status: history.status,
					transactions: history.transactions
				});
			} catch (error) {
				if (
					error instanceof AppError &&
					['TRANSACTION_HISTORY_UNAVAILABLE', 'TRANSACTION_HISTORY_NOT_ENABLED'].includes(
						error.code
					)
				)
					continue;
				throw error;
			}
		}
	}
	return activity;
}

export async function publishEmergencySnapshot(
	rows: PrivateRecordRow[],
	capturedAt: number
): Promise<void> {
	if (!emergencyStorageConfigured()) return;
	const tenantId = currentTenantId();
	if (!Number.isFinite(capturedAt) || !Number.isFinite(new Date(capturedAt).getTime()))
		throw invalidSnapshot();
	const cards = cardsFromRows(rows).map((card) => ({ ...card, issuerLogoUrl: null }));
	const accounts = financialAccountsFromRows(rows).map((account) => ({
		...account,
		institutionLogoUrl: null
	}));
	const snapshot: EmergencySnapshot = {
		version: 1,
		capturedAt: new Date(capturedAt).toISOString(),
		cards,
		accounts,
		bonuses: bonusesFromRows(rows),
		activity: activityFromRows(rows, cards, accounts),
		transactionLimit: EMERGENCY_TRANSACTION_LIMIT
	};
	const value: StoredSnapshot = { tenantId, snapshot, contentHash: contentHash(snapshot) };
	if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_SNAPSHOT_BYTES) {
		throw new AppError(
			'EMERGENCY_SNAPSHOT_TOO_LARGE',
			'The financial snapshot is too large to back up.',
			503
		);
	}
	validateStoredSnapshot(value, tenantId);
	const key = `snapshots/${tenantReference(tenantId)}`;
	for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
		const current = await readEmergencyObject<unknown>(key);
		if (current) {
			const previous = validateStoredSnapshot(current.value, tenantId);
			if (
				capturedAt <= Date.parse(previous.snapshot.capturedAt) ||
				previous.contentHash === value.contentHash
			)
				return;
		}
		try {
			await writeEmergencyObject(key, value, current?.etag);
			return;
		} catch (error) {
			if (
				!(error instanceof AppError) ||
				error.code !== 'EMERGENCY_CONFLICT' ||
				attempt === MAX_PUBLISH_ATTEMPTS - 1
			)
				throw error;
		}
	}
}

export async function readEmergencySnapshot(tenantId: string): Promise<EmergencySnapshot | null> {
	if (!isTenantId(tenantId))
		throw new AppError('AUTH_REQUIRED', 'Authentication is required.', 401);
	if (!emergencyStorageConfigured()) return null;
	const stored = await readEmergencyObject<unknown>(`snapshots/${tenantReference(tenantId)}`);
	return stored ? validateStoredSnapshot(stored.value, tenantId).snapshot : null;
}
