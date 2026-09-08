import { z } from 'zod';
import { cloudQuery } from './cloud-database';
import { decryptJson, encryptJson, secretsEqual } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';
import { currentTenantId, isTenantId, tenantReference } from './tenant';

const METADATA_KEY_PREFIX = 'method_credit_score_v1:';

const stateSchema = z.discriminatedUnion('state', [
	z.object({
		version: z.literal(1),
		tenantRef: z.string().min(40).max(50),
		state: z.literal('disconnected')
	}),
	z.object({
		version: z.literal(1),
		tenantRef: z.string().min(40).max(50),
		state: z.literal('onboarding'),
		entityId: z.string().regex(/^ent_[A-Za-z0-9]+$/),
		sessionId: z.string().regex(/^osess_[A-Za-z0-9]+$/),
		startedAt: z.string().datetime()
	}),
	z.object({
		version: z.literal(1),
		tenantRef: z.string().min(40).max(50),
		state: z.literal('connected'),
		entityId: z.string().regex(/^ent_[A-Za-z0-9]+$/),
		subscriptionId: z.string().regex(/^sub_[A-Za-z0-9]+$/),
		pendingRequestId: z
			.string()
			.regex(/^crs_[A-Za-z0-9]+$/)
			.nullable(),
		connectedAt: z.string().datetime(),
		lastSyncedAt: z.string().datetime().nullable(),
		lastError: z.string().max(300).nullable()
	})
]);

export type MethodCreditScoreState = z.infer<typeof stateSchema>;
type WithoutStoredFields<State> = State extends unknown
	? Omit<State, 'version' | 'tenantRef'>
	: never;
type MethodCreditScoreStateInput = WithoutStoredFields<MethodCreditScoreState>;

function metadataKey(tenantId: string): string {
	return `${METADATA_KEY_PREFIX}${tenantId}`;
}

function encryptionContext(tenantId: string): string {
	return `method-credit-score:${tenantId}`;
}

async function readMetadata(key: string): Promise<string | null> {
	const row =
		getRuntimeMode() === 'cloud'
			? (
					await cloudQuery<{ value: string }>(
						`SELECT value FROM public.carddue_metadata WHERE key = $1`,
						[key]
					)
				)[0]
			: (getDatabase().prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
					{ value: string } | undefined);
	return row?.value ?? null;
}

async function writeMetadata(key: string, value: string): Promise<void> {
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`INSERT INTO public.carddue_metadata AS current_value (key, value)
			 VALUES ($1, $2)
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			[key, value]
		);
		return;
	}
	getDatabase()
		.prepare(
			`INSERT INTO metadata (key, value) VALUES (?, ?)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value`
		)
		.run(key, value);
}

export async function getMethodCreditScoreState(
	tenantId = currentTenantId()
): Promise<MethodCreditScoreState> {
	const stored = await readMetadata(metadataKey(tenantId));
	if (!stored) return { version: 1, tenantRef: tenantReference(tenantId), state: 'disconnected' };
	const result = stateSchema.safeParse(decryptJson<unknown>(stored, encryptionContext(tenantId)));
	if (!result.success || !secretsEqual(result.data.tenantRef, tenantReference(tenantId))) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return result.data;
}

export async function saveMethodCreditScoreState(
	state: MethodCreditScoreStateInput,
	tenantId = currentTenantId()
): Promise<void> {
	const stored = stateSchema.parse({
		version: 1,
		tenantRef: tenantReference(tenantId),
		...state
	});
	await writeMetadata(metadataKey(tenantId), encryptJson(stored, encryptionContext(tenantId)));
}

export async function listMethodCreditScoreTenantIds(): Promise<string[]> {
	if (getRuntimeMode() !== 'cloud') return [currentTenantId()];
	const rows = await cloudQuery<{ key: string }>(
		`SELECT key FROM public.carddue_metadata WHERE key LIKE $1`,
		[`${METADATA_KEY_PREFIX}%`]
	);
	return rows
		.map((row) => row.key.slice(METADATA_KEY_PREFIX.length))
		.filter((tenantId) => isTenantId(tenantId));
}
