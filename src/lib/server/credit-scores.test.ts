import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCards } from './cards';
import { closeDatabaseForTests, getDatabase } from './database';
import { listBonuses, listFinancialAccounts } from './financial-records';
import { resetCryptoStateForTests } from './crypto';
import { createCreditScoreSchema, updateCreditScoreSchema } from './credit-score-schemas';
import {
	createCreditScore,
	deleteCreditScore,
	listCreditScores,
	upsertConnectedCreditScore,
	updateCreditScore
} from './credit-scores';

describe.sequential('encrypted credit score records', () => {
	let temporaryDirectory: string;
	let previousDataDirectory: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-credit-scores-'));
		process.env.CARDDUE_DATA_DIR = temporaryDirectory;
		closeDatabaseForTests();
		resetCryptoStateForTests();
	});

	afterEach(() => {
		closeDatabaseForTests();
		resetCryptoStateForTests();
		if (previousDataDirectory === undefined) delete process.env.CARDDUE_DATA_DIR;
		else process.env.CARDDUE_DATA_DIR = previousDataDirectory;
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('validates whole-number readings on the 300–850 scale', () => {
		expect(
			createCreditScoreSchema.safeParse({
				score: 748,
				bureau: 'experian',
				model: 'FICO Score 8',
				source: 'Issuer account',
				recordedDate: '2026-09-06'
			}).success
		).toBe(true);
		expect(
			createCreditScoreSchema.safeParse({
				score: 851,
				bureau: 'experian',
				recordedDate: '2026-09-06'
			}).success
		).toBe(false);
		expect(updateCreditScoreSchema.safeParse({ score: 790 }).success).toBe(true);
		expect(updateCreditScoreSchema.safeParse({}).success).toBe(false);
	});

	it('encrypts, sorts, updates, and deletes score readings without leaking into other records', async () => {
		const older = await createCreditScore(
			createCreditScoreSchema.parse({
				score: 731,
				bureau: 'experian',
				model: 'FICO Score 8',
				source: 'Issuer account',
				recordedDate: '2026-08-01'
			})
		);
		const newer = await createCreditScore(
			createCreditScoreSchema.parse({
				score: 746,
				bureau: 'experian',
				model: 'FICO Score 8',
				source: 'Issuer account',
				recordedDate: '2026-09-01'
			})
		);

		expect(await listCards()).toEqual([]);
		expect(await listFinancialAccounts()).toEqual([]);
		expect(await listBonuses()).toEqual([]);
		expect((await listCreditScores()).map((entry) => entry.id)).toEqual([newer.id, older.id]);
		expect(await updateCreditScore(newer.id, { score: 749 })).toMatchObject({
			score: 749,
			bureau: 'experian',
			recordedDate: '2026-09-01'
		});

		const durableText = JSON.stringify(
			getDatabase().prepare('SELECT payload_enc FROM cards').all()
		);
		expect(durableText).not.toContain('FICO Score 8');
		expect(durableText).not.toContain('Issuer account');

		await deleteCreditScore(older.id);
		expect(await listCreditScores()).toHaveLength(1);
	});

	it('upserts automatic readings by provider id and keeps them read-only', async () => {
		const first = await upsertConnectedCreditScore({
			externalId: 'crs_example123:equifax:vantage_4',
			score: 742,
			bureau: 'equifax',
			model: 'VantageScore 4.0',
			source: 'Method',
			recordedDate: '2026-09-07',
			factors: [{ code: '00034', description: 'Revolving balances are too high' }]
		});
		const updated = await upsertConnectedCreditScore({
			externalId: 'crs_example123:equifax:vantage_4',
			score: 746,
			bureau: 'equifax',
			model: 'VantageScore 4.0',
			source: 'Method',
			recordedDate: '2026-09-07',
			factors: [{ code: '00012', description: 'Oldest account is too recent' }]
		});

		expect(first.created).toBe(true);
		expect(updated.created).toBe(false);
		expect(updated.entry).toMatchObject({
			id: first.entry.id,
			score: 746,
			origin: 'automatic',
			factors: [{ code: '00012', description: 'Oldest account is too recent' }]
		});
		expect(await listCreditScores()).toHaveLength(1);
		await expect(updateCreditScore(first.entry.id, { score: 750 })).rejects.toMatchObject({
			code: 'CREDIT_SCORE_READ_ONLY'
		});
		await expect(deleteCreditScore(first.entry.id)).rejects.toMatchObject({
			code: 'CREDIT_SCORE_READ_ONLY'
		});

		const durableText = JSON.stringify(
			getDatabase().prepare('SELECT payload_enc FROM cards').all()
		);
		expect(durableText).not.toContain('crs_example123');
		expect(durableText).not.toContain('Oldest account is too recent');
	});
});
