import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listCards } from './cards';
import { closeDatabaseForTests, getDatabase } from './database';
import {
	createBonus,
	createFinancialAccount,
	deleteBonus,
	getBonus,
	listBonuses,
	listFinancialAccounts,
	replaceConnectedFinancialAccounts,
	replaceEstimatedFinancialAccountHistory,
	updateBonus,
	updateFinancialAccount
} from './financial-records';
import { decryptJson, encryptJson, resetCryptoStateForTests } from './crypto';
import { savePlaidItem } from './plaid-store';
import { createBonusSchema, createFinancialAccountSchema } from './schemas';

describe.sequential('encrypted financial records', () => {
	let temporaryDirectory: string;
	let previousDataDirectory: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-financial-records-'));
		process.env.CARDDUE_DATA_DIR = temporaryDirectory;
		closeDatabaseForTests();
		resetCryptoStateForTests();
	});

	afterEach(() => {
		vi.useRealTimers();
		closeDatabaseForTests();
		resetCryptoStateForTests();
		if (previousDataDirectory === undefined) delete process.env.CARDDUE_DATA_DIR;
		else process.env.CARDDUE_DATA_DIR = previousDataDirectory;
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('keeps accounts and bonuses separate from legacy credit-card records', async () => {
		const account = await createFinancialAccount(
			createFinancialAccountSchema.parse({
				nickname: 'Operating account',
				institution: 'Example Bank',
				accountType: 'checking',
				ownerType: 'business',
				apyBasisPoints: 425,
				currentBalanceCents: 125_000
			})
		);
		const bonus = await createBonus(
			createBonusSchema.parse({
				accountId: account.id,
				name: 'Business checking bonus',
				rewardCents: 40_000,
				requirements: [{ label: 'Complete five qualifying deposits' }]
			})
		);

		expect(await listCards()).toEqual([]);
		expect(await listFinancialAccounts()).toMatchObject([
			{
				nickname: 'Operating account',
				ownerType: 'business',
				apyBasisPoints: 425,
				apySource: 'manual',
				apyUpdatedAt: expect.any(String),
				hidden: false
			}
		]);
		expect(await listBonuses()).toMatchObject([
			{ name: 'Business checking bonus', accountId: account.id }
		]);
		expect(bonus.requirements[0]).toMatchObject({
			label: 'Complete five qualifying deposits',
			completed: false
		});
		expect(bonus.offerDateOverrideConfirmed).toBe(false);
		expect(bonus.cardId).toBeNull();
		expect(bonus.spendTargetCents).toBeNull();
		expect(bonus.requirements[0].id).toMatch(/^[0-9a-f-]{36}$/);

		const durableRows = getDatabase().prepare('SELECT payload_enc FROM cards').all();
		const durableText = JSON.stringify(durableRows);
		expect(durableText).not.toContain('Operating account');
		expect(durableText).not.toContain('Business checking bonus');
		expect(durableText).not.toContain('Example Bank');
	});

	it('updates progress and removes only the requested record type', async () => {
		const account = await createFinancialAccount(
			createFinancialAccountSchema.parse({ nickname: 'Brokerage', accountType: 'brokerage' })
		);
		const bonus = await createBonus(
			createBonusSchema.parse({
				name: 'Transfer offer',
				status: 'active',
				requirements: [{ label: 'Transfer assets' }]
			})
		);
		await updateFinancialAccount(account.id, { currentBalanceCents: 250_000, hidden: true });
		await updateBonus(bonus.id, {
			status: 'qualified',
			requirements: [{ ...bonus.requirements[0], completed: true }]
		});

		expect((await listFinancialAccounts())[0]).toMatchObject({
			currentBalanceCents: 250_000,
			hidden: true
		});
		expect((await listBonuses())[0]).toMatchObject({
			status: 'qualified',
			requirements: [{ completed: true }]
		});

		await deleteBonus(bonus.id);
		expect(await listBonuses()).toEqual([]);
		expect(await listFinancialAccounts()).toHaveLength(1);
	});

	it('stores the fee-free downgrade deadline separately and preserves it on unrelated updates', async () => {
		const dates = {
			safeToCloseDate: '2028-02-29',
			feeFreeDowngradeDate: '2028-03-15'
		};
		const bonus = await createBonus(
			createBonusSchema.parse({ name: 'Card upgrade bonus', ...dates })
		);
		expect(bonus).toMatchObject(dates);
		const row = getDatabase()
			.prepare('SELECT payload_enc FROM cards WHERE id = ?')
			.get(bonus.id) as { payload_enc: string };
		expect(row.payload_enc).not.toContain(dates.feeFreeDowngradeDate);
		expect(decryptJson<Record<string, unknown>>(row.payload_enc, `card:${bonus.id}`)).toMatchObject(
			dates
		);

		closeDatabaseForTests();
		resetCryptoStateForTests();
		expect(await getBonus(bonus.id)).toMatchObject(dates);
		expect((await listBonuses())[0]).toMatchObject(dates);
		expect(await updateBonus(bonus.id, { status: 'paid', notes: 'Bonus received' })).toMatchObject(
			dates
		);
		expect(await updateBonus(bonus.id, { feeFreeDowngradeDate: '2028-03-14' })).toMatchObject({
			safeToCloseDate: dates.safeToCloseDate,
			feeFreeDowngradeDate: '2028-03-14'
		});
		expect(await updateBonus(bonus.id, { feeFreeDowngradeDate: null })).toMatchObject({
			safeToCloseDate: dates.safeToCloseDate,
			feeFreeDowngradeDate: null
		});
		expect((await getBonus(bonus.id)).feeFreeDowngradeDate).toBeNull();
	});

	it('does not infer a fee-free downgrade deadline from the hold date in older encrypted bonuses', async () => {
		const bonus = await createBonus(
			createBonusSchema.parse({ name: 'Legacy card bonus', safeToCloseDate: '2028-02-29' })
		);
		const database = getDatabase();
		const row = database.prepare('SELECT payload_enc FROM cards WHERE id = ?').get(bonus.id) as {
			payload_enc: string;
		};
		const legacyPayload = decryptJson<Record<string, unknown>>(row.payload_enc, `card:${bonus.id}`);
		delete legacyPayload.feeFreeDowngradeDate;
		database
			.prepare('UPDATE cards SET payload_enc = ? WHERE id = ?')
			.run(encryptJson(legacyPayload, `card:${bonus.id}`), bonus.id);

		expect(await getBonus(bonus.id)).toMatchObject({
			safeToCloseDate: '2028-02-29',
			feeFreeDowngradeDate: null
		});
		expect((await listBonuses())[0].feeFreeDowngradeDate).toBeNull();
		expect((await updateBonus(bonus.id, { status: 'paid' })).feeFreeDowngradeDate).toBeNull();
		expect(
			(await updateBonus(bonus.id, { feeFreeDowngradeDate: '2028-03-15' })).feeFreeDowngradeDate
		).toBe('2028-03-15');
	});

	it('clears the fee deadline when the linked card changes unless a new date is supplied', async () => {
		const firstCardId = '10000000-0000-4000-8000-000000000001';
		const secondCardId = '10000000-0000-4000-8000-000000000002';
		const bonus = await createBonus(
			createBonusSchema.parse({
				name: 'Card bonus',
				cardId: firstCardId,
				safeToCloseDate: '2028-02-29',
				feeFreeDowngradeDate: '2028-03-15'
			})
		);
		expect((await updateBonus(bonus.id, { cardId: firstCardId })).feeFreeDowngradeDate).toBe(
			'2028-03-15'
		);
		expect(await updateBonus(bonus.id, { cardId: secondCardId })).toMatchObject({
			cardId: secondCardId,
			safeToCloseDate: '2028-02-29',
			feeFreeDowngradeDate: null
		});
		expect((await getBonus(bonus.id)).feeFreeDowngradeDate).toBeNull();
		expect(
			await updateBonus(bonus.id, {
				cardId: firstCardId,
				feeFreeDowngradeDate: '2028-03-14'
			})
		).toMatchObject({ cardId: firstCardId, feeFreeDowngradeDate: '2028-03-14' });
		expect(await updateBonus(bonus.id, { cardId: null })).toMatchObject({
			cardId: null,
			feeFreeDowngradeDate: null
		});
	});

	it('round-trips repeat bonus terms inside encrypted storage', async () => {
		const churn = {
			mode: 'rules',
			conditions: [
				{ anchor: 'paidDate', months: 24, days: 1 },
				{ anchor: 'closedDate', months: 0, days: 30 }
			],
			requiresClosed: true,
			openedDate: '2020-01-10',
			closedDate: '2026-08-15',
			manualEligibleDate: null,
			presetId: 'example-bank-repeat',
			sourceUrl: 'https://bank.example/repeat-offer',
			notes: 'Private repeat offer details'
		};
		const bonus = await createBonus(
			createBonusSchema.parse({
				name: 'Returning customer offer',
				status: 'paid',
				paidDate: '2026-07-10',
				churn
			})
		);
		expect(bonus.churn).toEqual(churn);

		const row = getDatabase()
			.prepare('SELECT payload_enc FROM cards WHERE id = ?')
			.get(bonus.id) as { payload_enc: string };
		expect(row.payload_enc).not.toContain('Private repeat offer details');
		expect(row.payload_enc).not.toContain('repeat-offer');
		expect(decryptJson<Record<string, unknown>>(row.payload_enc, `card:${bonus.id}`).churn).toEqual(
			churn
		);

		closeDatabaseForTests();
		resetCryptoStateForTests();
		expect((await getBonus(bonus.id)).churn).toEqual(churn);
		expect((await listBonuses())[0].churn).toEqual(churn);
	});

	it('preserves repeat tracking on unrelated updates and explicitly clears it', async () => {
		const bonus = await createBonus(
			createBonusSchema.parse({
				name: 'Repeat offer',
				openedDate: '2026-01-10',
				paidDate: '2026-03-10',
				safeToCloseDate: '2026-07-10',
				churn: {
					mode: 'rules',
					conditions: [{ anchor: 'paidDate', months: 24, days: 0 }],
					requiresClosed: true
				}
			})
		);
		const updated = await updateBonus(bonus.id, { notes: 'Payout received' });
		expect(updated.churn).toEqual(bonus.churn);
		expect(updated.churn?.closedDate).toBeNull();

		const cleared = await updateBonus(bonus.id, { churn: null });
		expect(cleared).toMatchObject({ ...updated, churn: null, updatedAt: expect.any(String) });
		expect((await getBonus(bonus.id)).churn).toBeNull();
	});

	it('normalizes older bonus payloads without repeat tracking and can update them', async () => {
		const bonus = await createBonus(createBonusSchema.parse({ name: 'Legacy bonus' }));
		const database = getDatabase();
		const row = database.prepare('SELECT payload_enc FROM cards WHERE id = ?').get(bonus.id) as {
			payload_enc: string;
		};
		const legacyPayload = decryptJson<Record<string, unknown>>(row.payload_enc, `card:${bonus.id}`);
		delete legacyPayload.churn;
		database
			.prepare('UPDATE cards SET payload_enc = ? WHERE id = ?')
			.run(encryptJson(legacyPayload, `card:${bonus.id}`), bonus.id);

		expect((await getBonus(bonus.id)).churn).toBeNull();
		expect((await listBonuses())[0].churn).toBeNull();
		expect((await updateBonus(bonus.id, { status: 'paid' })).churn).toBeNull();
		const configured = await updateBonus(bonus.id, {
			churn: createBonusSchema.parse({ name: 'Unused', churn: { mode: 'manual' } }).churn
		});
		expect(configured.churn).toMatchObject({ mode: 'manual', manualEligibleDate: null });
	});

	it('does not infer bonus dates or closure from linked accounts when tracking is added', async () => {
		const account = await createFinancialAccount(
			createFinancialAccountSchema.parse({
				nickname: 'Closed checking',
				accountType: 'checking',
				status: 'closed',
				openedDate: '2020-01-10'
			})
		);
		const bonus = await createBonus(
			createBonusSchema.parse({
				name: 'Paid offer without dates',
				accountId: account.id,
				status: 'paid'
			})
		);
		const updated = await updateBonus(bonus.id, {
			churn: createBonusSchema.parse({
				name: 'Unused',
				churn: {
					mode: 'rules',
					conditions: [{ anchor: 'closedDate', months: 12, days: 0 }],
					requiresClosed: true
				}
			}).churn
		});
		expect(updated).toMatchObject({
			...bonus,
			openedDate: null,
			paidDate: null,
			safeToCloseDate: null,
			status: 'paid',
			churn: { closedDate: null, requiresClosed: true },
			updatedAt: expect.any(String)
		});
		expect((await listFinancialAccounts())[0]).toMatchObject({ status: 'closed' });
	});

	it('records brokerage values when a manual balance changes', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
		const account = await createFinancialAccount(
			createFinancialAccountSchema.parse({
				nickname: 'Manual brokerage',
				accountType: 'brokerage',
				currentBalanceCents: 100_000,
				netContributionsCents: 80_000
			})
		);

		vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
		await updateFinancialAccount(account.id, { currentBalanceCents: 112_500 });
		vi.setSystemTime(new Date('2026-08-06T12:00:00.000Z'));
		await updateFinancialAccount(account.id, { netContributionsCents: 90_000 });
		const [updated] = await listFinancialAccounts();

		expect(updated.netContributionsCents).toBe(90_000);
		expect(updated.balanceHistory).toEqual([
			{
				recordedAt: '2026-08-01T12:00:00.000Z',
				balanceCents: 100_000,
				netContributionsCents: 80_000,
				source: 'observed'
			},
			{
				recordedAt: '2026-08-05T12:00:00.000Z',
				balanceCents: 112_500,
				netContributionsCents: 80_000,
				source: 'observed'
			},
			{
				recordedAt: '2026-08-06T12:00:00.000Z',
				balanceCents: 112_500,
				netContributionsCents: 90_000,
				source: 'observed'
			}
		]);
	});

	it('records non-brokerage balances for net worth history', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
		const account = await createFinancialAccount(
			createFinancialAccountSchema.parse({
				nickname: 'Everyday checking',
				accountType: 'checking',
				currentBalanceCents: 100_000
			})
		);

		vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
		await updateFinancialAccount(account.id, { currentBalanceCents: 112_500 });
		const [updated] = await listFinancialAccounts();

		expect(updated.balanceHistory).toEqual([
			{
				recordedAt: '2026-08-01T12:00:00.000Z',
				balanceCents: 100_000,
				netContributionsCents: null,
				source: 'observed'
			},
			{
				recordedAt: '2026-08-05T12:00:00.000Z',
				balanceCents: 112_500,
				netContributionsCents: null,
				source: 'observed'
			}
		]);
	});

	it('replaces estimated points while preserving observed snapshots', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-05T12:00:00.000Z'));
		const account = await createFinancialAccount(
			createFinancialAccountSchema.parse({
				nickname: 'Estimated brokerage',
				accountType: 'brokerage',
				currentBalanceCents: 120_000
			})
		);
		await replaceEstimatedFinancialAccountHistory(account.id, [
			{
				recordedAt: '2026-08-01T20:00:00.000Z',
				balanceCents: 100_000,
				netContributionsCents: null,
				source: 'estimated'
			},
			{
				recordedAt: '2026-08-02T20:00:00.000Z',
				balanceCents: 110_000,
				netContributionsCents: null,
				source: 'estimated'
			}
		]);
		const refreshed = await replaceEstimatedFinancialAccountHistory(
			account.id,
			[
				{
					recordedAt: '2026-08-03T20:00:00.000Z',
					balanceCents: 115_000,
					netContributionsCents: 100_000,
					source: 'estimated'
				}
			],
			{ latestObservedNetContributionsCents: 105_000 }
		);

		expect(refreshed.balanceHistory).toMatchObject([
			{
				recordedAt: '2026-08-03T20:00:00.000Z',
				netContributionsCents: 100_000,
				source: 'estimated'
			},
			{
				recordedAt: '2026-08-05T12:00:00.000Z',
				netContributionsCents: 105_000,
				source: 'observed'
			}
		]);
	});

	it('extends connected brokerage history on every successful balance sync', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-01T09:00:00.000Z'));
		const connectionId = await savePlaidItem(
			'provider-history-item',
			'provider-history-token',
			'Synthetic Brokerage'
		);
		const snapshot = {
			accountId: 'provider-history-account',
			nickname: 'Synced brokerage',
			institution: 'Synthetic Brokerage',
			institutionLogoBase64: null,
			accountType: 'brokerage' as const,
			last4: '1234',
			currency: 'USD',
			currentBalanceCents: 250_000,
			costBasisCents: 200_000,
			holdings: []
		};
		await replaceConnectedFinancialAccounts(
			'plaid',
			connectionId,
			[snapshot],
			'2026-08-01T12:00:00.000Z'
		);
		await replaceConnectedFinancialAccounts(
			'plaid',
			connectionId,
			[{ ...snapshot, currentBalanceCents: 275_000 }],
			'2026-08-02T12:00:00.000Z'
		);

		let [account] = await listFinancialAccounts();
		expect(account.netContributionsCents).toBeNull();
		expect(account.balanceHistory).toEqual([
			{
				recordedAt: '2026-08-01T12:00:00.000Z',
				balanceCents: 250_000,
				netContributionsCents: null,
				source: 'observed'
			},
			{
				recordedAt: '2026-08-02T12:00:00.000Z',
				balanceCents: 275_000,
				netContributionsCents: null,
				source: 'observed'
			}
		]);

		vi.setSystemTime(new Date('2026-08-03T12:00:00.000Z'));
		await updateFinancialAccount(account.id, {
			netContributionsCents: 200_000,
			apyBasisPoints: 425
		});
		await replaceConnectedFinancialAccounts(
			'plaid',
			connectionId,
			[{ ...snapshot, currentBalanceCents: 280_000 }],
			'2026-08-04T12:00:00.000Z'
		);
		[account] = await listFinancialAccounts();
		expect(account).toMatchObject({
			apyBasisPoints: 425,
			apySource: 'manual',
			apyUpdatedAt: '2026-08-03T12:00:00.000Z'
		});
		expect(account.netContributionsCents).toBe(200_000);
		expect(account.balanceHistory.slice(-2)).toEqual([
			{
				recordedAt: '2026-08-03T12:00:00.000Z',
				balanceCents: 275_000,
				netContributionsCents: 200_000,
				source: 'observed'
			},
			{
				recordedAt: '2026-08-04T12:00:00.000Z',
				balanceCents: 280_000,
				netContributionsCents: 200_000,
				source: 'observed'
			}
		]);

		await replaceConnectedFinancialAccounts(
			'plaid',
			connectionId,
			[{ ...snapshot, currentBalanceCents: 280_000, apyBasisPoints: 510 }],
			'2026-08-05T12:00:00.000Z'
		);
		[account] = await listFinancialAccounts();
		expect(account).toMatchObject({
			apyBasisPoints: 510,
			apySource: 'provider',
			apyUpdatedAt: '2026-08-05T12:00:00.000Z'
		});

		await replaceConnectedFinancialAccounts(
			'plaid',
			connectionId,
			[{ ...snapshot, currentBalanceCents: 280_000, apyBasisPoints: null }],
			'2026-08-06T12:00:00.000Z'
		);
		[account] = await listFinancialAccounts();
		expect(account).toMatchObject({
			apyBasisPoints: null,
			apySource: null,
			apyUpdatedAt: null
		});
	});
});
