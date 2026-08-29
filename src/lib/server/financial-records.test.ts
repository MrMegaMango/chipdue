import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCards } from './cards';
import { closeDatabaseForTests, getDatabase } from './database';
import {
	createBonus,
	createFinancialAccount,
	deleteBonus,
	listBonuses,
	listFinancialAccounts,
	updateBonus,
	updateFinancialAccount
} from './financial-records';
import { resetCryptoStateForTests } from './crypto';
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
			{ nickname: 'Operating account', ownerType: 'business', hidden: false }
		]);
		expect(await listBonuses()).toMatchObject([
			{ name: 'Business checking bonus', accountId: account.id }
		]);
		expect(bonus.requirements[0]).toMatchObject({
			label: 'Complete five qualifying deposits',
			completed: false
		});
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
});
