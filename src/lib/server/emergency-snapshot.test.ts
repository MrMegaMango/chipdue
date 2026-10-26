import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptJson } from './crypto';
import { AppError } from './errors';
import { publishEmergencySnapshot, readEmergencySnapshot } from './emergency-snapshot';
import type { PrivateRecordRow } from './record-rows';
import { runAsTenant, tenantPayloadFields, tenantReference } from './tenant';

const store = vi.hoisted(() => ({
	configured: true,
	revision: 0,
	objects: new Map<string, { value: unknown; etag: string }>(),
	read: vi.fn(),
	write: vi.fn()
}));

vi.mock('./emergency-store', () => ({
	emergencyStorageConfigured: () => store.configured,
	readEmergencyObject: store.read,
	writeEmergencyObject: store.write
}));

const FIRST_TENANT = '10000000-0000-4000-8000-000000000001';
const SECOND_TENANT = '20000000-0000-4000-8000-000000000002';
const CARD_ID = '30000000-0000-4000-8000-000000000003';
const ACCOUNT_ID = '40000000-0000-4000-8000-000000000004';
const BONUS_ID = '50000000-0000-4000-8000-000000000005';
const NOW = Date.parse('2026-10-25T18:00:00.000Z');
const SYNCED_AT = '2026-10-25T17:00:00.000Z';

function row(
	id: string,
	payload: Record<string, unknown>,
	source: PrivateRecordRow['source'] = 'manual',
	tenantId = FIRST_TENANT
): PrivateRecordRow {
	return runAsTenant(tenantId, () => ({
		id,
		source,
		plaid_item_id: source === 'manual' ? null : '60000000-0000-4000-8000-000000000006',
		external_account_ref: source === 'manual' ? null : Buffer.alloc(32, 7).toString('base64url'),
		payload_enc: encryptJson({ ...payload, ...tenantPayloadFields() }, `card:${id}`),
		last_synced_at: source === 'manual' ? null : SYNCED_AT,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: SYNCED_AT
	}));
}

function cardPayload(changes: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		nickname: 'Everyday card',
		issuer: 'Synthetic Bank',
		issuerLogoBase64: 'c3ludGhldGlj',
		last4: '1234',
		currency: 'USD',
		statementBalanceCents: 25000,
		minimumPaymentCents: 2500,
		currentBalanceCents: 28000,
		dueDate: '2026-11-01',
		statementDate: '2026-10-05',
		isOverdue: false,
		autopayEnabled: true,
		...changes
	};
}

function accountPayload(changes: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		recordType: 'account',
		nickname: 'Checking',
		institution: 'Synthetic Bank',
		institutionLogoBase64: 'c3ludGhldGlj',
		accountType: 'checking',
		ownerType: 'personal',
		status: 'active',
		last4: '5678',
		currency: 'USD',
		currentBalanceCents: 150000,
		costBasisCents: null,
		openedDate: '2026-01-01',
		notes: null,
		...changes
	};
}

function bonusPayload(): Record<string, unknown> {
	return {
		recordType: 'bonus',
		accountId: ACCOUNT_ID,
		name: 'Checking bonus',
		institution: 'Synthetic Bank',
		rewardCents: 30000,
		currency: 'USD',
		status: 'active',
		openedDate: '2026-10-01',
		requirementDeadline: '2026-12-01',
		expectedPayoutDate: null,
		paidDate: null,
		safeToCloseDate: null,
		requirements: [
			{ id: '70000000-0000-4000-8000-000000000007', label: 'Direct deposit', completed: false }
		],
		notes: null
	};
}

function transactionHistory(count = 140): Record<string, unknown> {
	return {
		enabled: true,
		cursor: 'synthetic-private-provider-cursor',
		status: 'current',
		transactions: Array.from({ length: count }, (_, index) => ({
			transactionId: `private-provider-transaction-${index}`,
			name: `Purchase ${index}`,
			merchantName: null,
			amountCents: 100 + index,
			currency: 'USD',
			date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
			authorizedDate: null,
			pending: false,
			categoryPrimary: null,
			categoryDetailed: null
		}))
	};
}

function publish(
	rows: PrivateRecordRow[],
	capturedAt = NOW,
	tenantId = FIRST_TENANT
): Promise<void> {
	return runAsTenant(tenantId, () => publishEmergencySnapshot(rows, capturedAt));
}

describe.sequential('independent financial snapshots', () => {
	beforeEach(() => {
		vi.stubEnv('CARDDUE_MODE', 'cloud');
		vi.stubEnv('CARDDUE_AUTH_MODE', 'google');
		vi.stubEnv(
			'DATABASE_URL',
			[
				'postgresql://carddue_runtime:synthetic-password',
				'ep-chipdue-test.us-west-2.aws.neon.tech/carddue?sslmode=require'
			].join('@')
		);
		vi.stubEnv('CARDDUE_MASTER_KEY', Buffer.alloc(32, 29).toString('base64url'));
		vi.stubEnv('CARDDUE_OWNER_PASSWORD_HASH', undefined);
		vi.stubEnv('CARDDUE_ALLOWED_HOSTS', 'cards.example.test');
		vi.stubEnv('CARDDUE_GOOGLE_CLIENT_ID', 'synthetic-chipdue.apps.googleusercontent.com');
		vi.stubEnv('CARDDUE_GOOGLE_CLIENT_SECRET', 'synthetic-google-client-secret');
		vi.stubEnv('CARDDUE_GOOGLE_BOOTSTRAP_HASH', undefined);
		vi.stubEnv('CARDDUE_SESSION_TTL_HOURS', '1');
		store.configured = true;
		store.revision = 0;
		store.objects.clear();
		store.read.mockReset().mockImplementation(async (key: string) => {
			const current = store.objects.get(key);
			return current ? structuredClone(current) : null;
		});
		store.write
			.mockReset()
			.mockImplementation(async (key: string, value: unknown, etag?: string) => {
				const current = store.objects.get(key);
				if (etag === undefined ? current !== undefined : current?.etag !== etag) {
					throw new AppError('EMERGENCY_CONFLICT', 'The emergency record changed.', 409);
				}
				const nextEtag = `snapshot-${++store.revision}`;
				store.objects.set(key, { value: structuredClone(value), etag: nextEtag });
				return nextEtag;
			});
	});

	afterEach(() => vi.unstubAllEnvs());

	it('backs up public financial views and only the latest 100 transactions per card or account', async () => {
		const history = transactionHistory();
		await publish([
			row(
				CARD_ID,
				cardPayload({
					transactionHistory: history,
					accessToken: 'synthetic-provider-secret',
					sessionToken: 'synthetic-session-secret'
				}),
				'plaid'
			),
			row(ACCOUNT_ID, accountPayload({ transactionHistory: history }), 'plaid'),
			row(BONUS_ID, bonusPayload())
		]);
		const snapshot = await readEmergencySnapshot(FIRST_TENANT);
		expect(snapshot).toMatchObject({
			version: 1,
			capturedAt: new Date(NOW).toISOString(),
			transactionLimit: 100,
			cards: [{ id: CARD_ID, currentBalanceCents: 28000, issuerLogoUrl: null }],
			accounts: [{ id: ACCOUNT_ID, currentBalanceCents: 150000, institutionLogoUrl: null }],
			bonuses: [{ id: BONUS_ID, rewardCents: 30000 }]
		});
		expect(snapshot?.activity).toHaveLength(2);
		for (const entry of snapshot!.activity) {
			expect(entry.transactions).toHaveLength(100);
			expect(entry.transactions[0].name).toBe('Purchase 139');
			expect(entry.transactions[99].name).toBe('Purchase 40');
		}
		const serialized = JSON.stringify([...store.objects.values()]);
		for (const secret of [
			'synthetic-provider-secret',
			'synthetic-session-secret',
			'synthetic-private-provider-cursor',
			'private-provider-transaction-',
			'payload_enc',
			'issuerLogoBase64',
			'institutionLogoBase64'
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it('keeps tenants separate and rejects a snapshot substituted under another tenant key', async () => {
		const rows = [
			row(CARD_ID, cardPayload()),
			row(ACCOUNT_ID, accountPayload(), 'manual', SECOND_TENANT)
		];
		await Promise.all([publish(rows), publish(rows, NOW, SECOND_TENANT)]);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toMatchObject({
			cards: [{ id: CARD_ID }],
			accounts: []
		});
		expect(await readEmergencySnapshot(SECOND_TENANT)).toMatchObject({
			cards: [],
			accounts: [{ id: ACCOUNT_ID }]
		});
		store.objects.set(
			`snapshots/${tenantReference(SECOND_TENANT)}`,
			store.objects.get(`snapshots/${tenantReference(FIRST_TENANT)}`)!
		);
		await expect(readEmergencySnapshot(SECOND_TENANT)).rejects.toMatchObject({
			code: 'EMERGENCY_SNAPSHOT_INVALID'
		});
	});

	it('does not write unchanged reads, but preserves a newer successful sync timestamp', async () => {
		const original = row(CARD_ID, cardPayload(), 'plaid');
		await publish([original]);
		await publish([original], NOW + 1000);
		expect(store.write).toHaveBeenCalledTimes(1);
		expect((await readEmergencySnapshot(FIRST_TENANT))?.capturedAt).toBe(
			new Date(NOW).toISOString()
		);
		await publish(
			[{ ...original, last_synced_at: new Date(NOW + 2000).toISOString() }],
			NOW + 3000
		);
		expect(store.write).toHaveBeenCalledTimes(2);
		expect((await readEmergencySnapshot(FIRST_TENANT))?.cards[0].lastSyncedAt).toBe(
			new Date(NOW + 2000).toISOString()
		);
	});

	it('preserves the last complete snapshot if any encrypted row cannot be decoded', async () => {
		const original = row(CARD_ID, cardPayload());
		await publish([original]);
		await expect(
			publish(
				[
					row(CARD_ID, cardPayload({ currentBalanceCents: 1 })),
					{ ...row(ACCOUNT_ID, accountPayload()), payload_enc: 'invalid-encrypted-row' }
				],
				NOW + 1000
			)
		).rejects.toMatchObject({ code: 'ENCRYPTED_DATA_UNREADABLE' });
		expect(store.write).toHaveBeenCalledTimes(1);
		expect((await readEmergencySnapshot(FIRST_TENANT))?.cards[0].currentBalanceCents).toBe(28000);
	});

	it('omits expected unavailable history while retaining all financial records', async () => {
		await publish([row(CARD_ID, cardPayload()), row(ACCOUNT_ID, accountPayload(), 'plaid')]);
		const snapshot = await readEmergencySnapshot(FIRST_TENANT);
		expect(snapshot?.cards).toHaveLength(1);
		expect(snapshot?.accounts).toHaveLength(1);
		expect(snapshot?.activity).toEqual([]);
	});

	it('never replaces a newer capture, including after a concurrent CAS conflict', async () => {
		await publish([row(CARD_ID, cardPayload())]);
		store.write.mockImplementationOnce(async () => {
			await publish([row(CARD_ID, cardPayload({ currentBalanceCents: 30000 }))], NOW + 3000);
			throw new AppError('EMERGENCY_CONFLICT', 'The emergency record changed.', 409);
		});
		await publish([row(CARD_ID, cardPayload({ currentBalanceCents: 20000 }))], NOW + 2000);
		await publish([row(CARD_ID, cardPayload({ currentBalanceCents: 10000 }))], NOW + 3000);
		expect(store.write).toHaveBeenCalledTimes(3);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toMatchObject({
			capturedAt: new Date(NOW + 3000).toISOString(),
			cards: [{ currentBalanceCents: 30000 }]
		});
	});

	it('bounds repeated conflicts and leaves the previous snapshot intact', async () => {
		await publish([row(CARD_ID, cardPayload())]);
		store.write.mockRejectedValue(
			new AppError('EMERGENCY_CONFLICT', 'The emergency record changed.', 409)
		);
		await expect(
			publish([row(CARD_ID, cardPayload({ currentBalanceCents: 1 }))], NOW + 1000)
		).rejects.toMatchObject({ code: 'EMERGENCY_CONFLICT' });
		expect(store.write).toHaveBeenCalledTimes(4);
		expect((await readEmergencySnapshot(FIRST_TENANT))?.cards[0].currentBalanceCents).toBe(28000);
	});

	it('does not resurrect a deleted record when an older capture finishes late', async () => {
		await publish([row(CARD_ID, cardPayload())]);
		store.write.mockImplementationOnce(async () => {
			await publish([], NOW + 3000);
			throw new AppError('EMERGENCY_CONFLICT', 'The emergency record changed.', 409);
		});
		await publish([row(CARD_ID, cardPayload({ currentBalanceCents: 20000 }))], NOW + 2000);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toMatchObject({
			capturedAt: new Date(NOW + 3000).toISOString(),
			cards: [],
			accounts: [],
			bonuses: [],
			activity: []
		});
	});

	it('rejects an oversized snapshot without replacing the existing backup', async () => {
		await publish([row(CARD_ID, cardPayload())]);
		await expect(
			publish([row(ACCOUNT_ID, accountPayload({ notes: 'x'.repeat(3_000_000) }))], NOW + 1000)
		).rejects.toMatchObject({
			code: 'EMERGENCY_SNAPSHOT_TOO_LARGE',
			message: 'The financial snapshot is too large to back up.'
		});
		expect(store.write).toHaveBeenCalledTimes(1);
		expect((await readEmergencySnapshot(FIRST_TENANT))?.cards[0].id).toBe(CARD_ID);
	});

	it('rejects malformed or altered stored public views', async () => {
		await publish([row(CARD_ID, cardPayload())]);
		const stored = store.objects.get(`snapshots/${tenantReference(FIRST_TENANT)}`)!;
		const altered = structuredClone(stored) as {
			value: { snapshot: { cards: Array<{ currentBalanceCents: unknown }> } };
			etag: string;
		};
		altered.value.snapshot.cards[0].currentBalanceCents = 'unexpected';
		store.objects.set(`snapshots/${tenantReference(FIRST_TENANT)}`, altered);
		await expect(readEmergencySnapshot(FIRST_TENANT)).rejects.toMatchObject({
			code: 'EMERGENCY_SNAPSHOT_INVALID'
		});
		altered.value.snapshot.cards[0].currentBalanceCents = 1;
		await expect(readEmergencySnapshot(FIRST_TENANT)).rejects.toMatchObject({
			code: 'EMERGENCY_SNAPSHOT_INVALID'
		});
	});

	it('does not use storage when the independent backup is not configured', async () => {
		store.configured = false;
		await publish([]);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toBeNull();
		expect(store.read).not.toHaveBeenCalled();
		expect(store.write).not.toHaveBeenCalled();
	});
});
