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
const DAY_MS = 24 * 60 * 60 * 1000;
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

	it('saves the first public financial copy immediately with only the latest 100 transactions per account', async () => {
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

	it('waits 24 hours between captures, including edits and removals, then saves the latest data', async () => {
		await publish([
			row(CARD_ID, cardPayload()),
			row(ACCOUNT_ID, accountPayload()),
			row(BONUS_ID, bonusPayload())
		]);
		const firstSnapshot = await readEmergencySnapshot(FIRST_TENANT);
		const changed = [row(CARD_ID, cardPayload({ currentBalanceCents: 29000 }))];
		await publish(changed, NOW + 1000);
		await publish(changed, NOW + DAY_MS - 1);
		expect(store.write).toHaveBeenCalledTimes(1);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toEqual(firstSnapshot);

		await publish([row(CARD_ID, cardPayload({ currentBalanceCents: 31000 }))], NOW + DAY_MS);
		expect(store.write).toHaveBeenCalledTimes(2);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toMatchObject({
			capturedAt: new Date(NOW + DAY_MS).toISOString(),
			cards: [{ id: CARD_ID, currentBalanceCents: 31000 }],
			accounts: [],
			bonuses: []
		});
		await publish([row(CARD_ID, cardPayload({ currentBalanceCents: 33000 }))], NOW + DAY_MS + 1);
		expect(store.write).toHaveBeenCalledTimes(2);
	});

	it('does not consume the interval when an eligible upload fails', async () => {
		await publish([row(CARD_ID, cardPayload())]);
		store.write.mockRejectedValueOnce(new Error('Synthetic storage failure'));
		await expect(
			publish([row(CARD_ID, cardPayload({ currentBalanceCents: 29000 }))], NOW + DAY_MS)
		).rejects.toThrow('Synthetic storage failure');
		expect((await readEmergencySnapshot(FIRST_TENANT))?.capturedAt).toBe(
			new Date(NOW).toISOString()
		);
		await publish([row(CARD_ID, cardPayload({ currentBalanceCents: 31000 }))], NOW + DAY_MS + 1);
		expect(store.write).toHaveBeenCalledTimes(3);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toMatchObject({
			capturedAt: new Date(NOW + DAY_MS + 1).toISOString(),
			cards: [{ currentBalanceCents: 31000 }]
		});
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
		await publish([original], NOW + DAY_MS);
		expect(store.write).toHaveBeenCalledTimes(1);
		expect((await readEmergencySnapshot(FIRST_TENANT))?.capturedAt).toBe(
			new Date(NOW).toISOString()
		);
		await publish(
			[{ ...original, last_synced_at: new Date(NOW + 2000).toISOString() }],
			NOW + DAY_MS + 3000
		);
		expect(store.write).toHaveBeenCalledTimes(2);
		expect((await readEmergencySnapshot(FIRST_TENANT))?.cards[0].lastSyncedAt).toBe(
			new Date(NOW + 2000).toISOString()
		);
	});

	it('ignores tied display-order changes while retaining financial edits, sync times, and removals', async () => {
		const secondCardId = '84d723ca-119b-4e1b-8a13-e69bd445908b';
		const secondAccountId = 'bc19068d-4c97-4d7e-b8ae-620ed70a9b3e';
		const secondBonusId = 'f5325e54-4396-4e1f-bb21-21ec338b393e';
		const history = transactionHistory(1);
		const original = [
			{
				...row(secondCardId, cardPayload({ last4: '4321', transactionHistory: history }), 'plaid'),
				external_account_ref: Buffer.alloc(32, 8).toString('base64url')
			},
			row(CARD_ID, cardPayload({ transactionHistory: history }), 'plaid'),
			row(secondAccountId, accountPayload({ transactionHistory: history }), 'plaid'),
			row(ACCOUNT_ID, accountPayload({ transactionHistory: history }), 'plaid'),
			row(secondBonusId, { ...bonusPayload(), name: 'Another bonus' }),
			row(BONUS_ID, bonusPayload())
		];
		await publish(original);
		const firstSnapshot = await readEmergencySnapshot(FIRST_TENANT);
		expect(firstSnapshot?.cards.map(({ id }) => id)).toEqual([secondCardId, CARD_ID]);
		expect(firstSnapshot?.accounts.map(({ id }) => id)).toEqual([secondAccountId, ACCOUNT_ID]);
		expect(firstSnapshot?.bonuses.map(({ id }) => id)).toEqual([secondBonusId, BONUS_ID]);
		expect(firstSnapshot?.activity.map(({ id }) => id)).toEqual([
			secondCardId,
			CARD_ID,
			secondAccountId,
			ACCOUNT_ID
		]);

		const reordered = original.toReversed();
		await publish(reordered, NOW + DAY_MS);
		expect(store.write).toHaveBeenCalledTimes(1);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toEqual(firstSnapshot);

		const changed = reordered.map((record) =>
			record.id === CARD_ID
				? row(
						CARD_ID,
						cardPayload({ currentBalanceCents: 29000, transactionHistory: history }),
						'plaid'
					)
				: record
		);
		await publish(changed, NOW + DAY_MS + 2000);
		expect(store.write).toHaveBeenCalledTimes(2);
		const changedSnapshot = await readEmergencySnapshot(FIRST_TENANT);
		expect(changedSnapshot?.cards.map(({ id }) => id)).toEqual([CARD_ID, secondCardId]);
		expect(changedSnapshot?.cards[0].currentBalanceCents).toBe(29000);

		const syncedAt = new Date(NOW + 2 * DAY_MS + 3000).toISOString();
		const synced = changed.map((record) =>
			record.id === CARD_ID ? { ...record, last_synced_at: syncedAt } : record
		);
		await publish(synced, NOW + 2 * DAY_MS + 4000);
		expect(store.write).toHaveBeenCalledTimes(3);
		const syncedSnapshot = await readEmergencySnapshot(FIRST_TENANT);
		expect(syncedSnapshot?.cards[0].lastSyncedAt).toBe(syncedAt);
		expect(syncedSnapshot?.activity.find(({ id }) => id === CARD_ID)?.lastSyncedAt).toBe(syncedAt);

		await publish(
			synced.filter(({ id }) => id !== secondAccountId),
			NOW + 3 * DAY_MS + 5000
		);
		expect(store.write).toHaveBeenCalledTimes(4);
		const finalSnapshot = await readEmergencySnapshot(FIRST_TENANT);
		expect(finalSnapshot?.accounts.map(({ id }) => id)).toEqual([ACCOUNT_ID]);
		expect(finalSnapshot?.activity.some(({ id }) => id === secondAccountId)).toBe(false);
	});

	it('skips bookkeeping-only changes while saving changed investment history and removals', async () => {
		const history = [
			{
				recordedAt: '2026-10-23T20:00:00.000Z',
				balanceCents: 145000,
				netContributionsCents: 140000,
				source: 'estimated'
			}
		];
		const original = [
			row(CARD_ID, cardPayload()),
			row(
				ACCOUNT_ID,
				accountPayload({
					accountType: 'brokerage',
					balanceHistory: history,
					estimatedHistoryUpdatedAt: SYNCED_AT
				}),
				'plaid'
			),
			row(BONUS_ID, bonusPayload())
		];
		await publish(original);
		const firstSnapshot = await readEmergencySnapshot(FIRST_TENANT);
		const updatedAt = new Date(NOW + 1000).toISOString();
		const rebuiltAccount = row(
			ACCOUNT_ID,
			accountPayload({
				accountType: 'brokerage',
				balanceHistory: history,
				estimatedHistoryUpdatedAt: updatedAt
			}),
			'plaid'
		);
		const unchanged = [original[0], rebuiltAccount, original[2]].map((record) => ({
			...record,
			updated_at: updatedAt
		}));
		await publish(unchanged, NOW + DAY_MS);
		expect(store.write).toHaveBeenCalledTimes(1);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toEqual(firstSnapshot);

		const changedHistory = [{ ...history[0], balanceCents: 146000 }];
		const changed = row(
			ACCOUNT_ID,
			accountPayload({
				accountType: 'brokerage',
				balanceHistory: changedHistory,
				estimatedHistoryUpdatedAt: updatedAt
			}),
			'plaid'
		);
		await publish([unchanged[0], changed, unchanged[2]], NOW + DAY_MS + 3000);
		expect(store.write).toHaveBeenCalledTimes(2);
		expect((await readEmergencySnapshot(FIRST_TENANT))?.accounts[0].balanceHistory).toEqual(
			changedHistory
		);

		await publish([unchanged[0], unchanged[2]], NOW + 2 * DAY_MS + 4000);
		expect(store.write).toHaveBeenCalledTimes(3);
		expect((await readEmergencySnapshot(FIRST_TENANT))?.accounts).toEqual([]);
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
			await publish(
				[row(CARD_ID, cardPayload({ currentBalanceCents: 30000 }))],
				NOW + DAY_MS + 3000
			);
			throw new AppError('EMERGENCY_CONFLICT', 'The emergency record changed.', 409);
		});
		await publish([row(CARD_ID, cardPayload({ currentBalanceCents: 20000 }))], NOW + DAY_MS + 2000);
		await publish([row(CARD_ID, cardPayload({ currentBalanceCents: 10000 }))], NOW + DAY_MS + 3000);
		expect(store.write).toHaveBeenCalledTimes(3);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toMatchObject({
			capturedAt: new Date(NOW + DAY_MS + 3000).toISOString(),
			cards: [{ currentBalanceCents: 30000 }]
		});
	});

	it('rechecks the persisted interval when a different instance wins a CAS race', async () => {
		await publish([row(CARD_ID, cardPayload())]);
		vi.resetModules();
		const otherInstance = await import('./emergency-snapshot');
		const otherTenant = await import('./tenant');
		const winner = [row(CARD_ID, cardPayload({ currentBalanceCents: 30000 }))];
		store.write.mockImplementationOnce(async () => {
			await otherTenant.runAsTenant(FIRST_TENANT, () =>
				otherInstance.publishEmergencySnapshot(winner, NOW + DAY_MS)
			);
			throw new AppError('EMERGENCY_CONFLICT', 'The emergency record changed.', 409);
		});
		// This capture is newer than the winner, but still inside its 24-hour window.
		await publish([row(CARD_ID, cardPayload({ currentBalanceCents: 20000 }))], NOW + DAY_MS + 1000);
		expect(store.write).toHaveBeenCalledTimes(3);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toMatchObject({
			capturedAt: new Date(NOW + DAY_MS).toISOString(),
			cards: [{ currentBalanceCents: 30000 }]
		});
	});

	it('bounds repeated conflicts and leaves the previous snapshot intact', async () => {
		await publish([row(CARD_ID, cardPayload())]);
		store.write.mockRejectedValue(
			new AppError('EMERGENCY_CONFLICT', 'The emergency record changed.', 409)
		);
		await expect(
			publish([row(CARD_ID, cardPayload({ currentBalanceCents: 1 }))], NOW + DAY_MS)
		).rejects.toMatchObject({ code: 'EMERGENCY_CONFLICT' });
		expect(store.write).toHaveBeenCalledTimes(4);
		expect((await readEmergencySnapshot(FIRST_TENANT))?.cards[0].currentBalanceCents).toBe(28000);
	});

	it('does not resurrect a deleted record when an older capture finishes late', async () => {
		await publish([row(CARD_ID, cardPayload())]);
		store.write.mockImplementationOnce(async () => {
			await publish([], NOW + DAY_MS + 3000);
			throw new AppError('EMERGENCY_CONFLICT', 'The emergency record changed.', 409);
		});
		await publish([row(CARD_ID, cardPayload({ currentBalanceCents: 20000 }))], NOW + DAY_MS + 2000);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toMatchObject({
			capturedAt: new Date(NOW + DAY_MS + 3000).toISOString(),
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

	it('still checks bookkeeping timestamps in stored snapshot integrity', async () => {
		const original = row(CARD_ID, cardPayload());
		await publish([original]);
		const key = `snapshots/${tenantReference(FIRST_TENANT)}`;
		const altered = structuredClone(store.objects.get(key)!) as {
			value: { snapshot: { cards: Array<{ updatedAt: string }> } };
			etag: string;
		};
		altered.value.snapshot.cards[0].updatedAt = new Date(NOW + 1000).toISOString();
		store.objects.set(key, altered);
		await expect(readEmergencySnapshot(FIRST_TENANT)).rejects.toMatchObject({
			code: 'EMERGENCY_SNAPSHOT_INVALID'
		});
		await expect(publish([original], NOW + 2000)).rejects.toMatchObject({
			code: 'EMERGENCY_SNAPSHOT_INVALID'
		});
		expect(store.write).toHaveBeenCalledTimes(1);
	});

	it('does not use storage when the independent backup is not configured', async () => {
		store.configured = false;
		await publish([]);
		expect(await readEmergencySnapshot(FIRST_TENANT)).toBeNull();
		expect(store.read).not.toHaveBeenCalled();
		expect(store.write).not.toHaveBeenCalled();
	});
});
