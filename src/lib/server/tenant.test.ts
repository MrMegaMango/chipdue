import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManualCard, deleteManualCard, getCard, listCards } from './cards';
import { resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests, getDatabase } from './database';
import {
	createBonus,
	createFinancialAccount,
	listBonuses,
	listFinancialAccounts
} from './financial-records';
import { getPlaidConfiguration, savePersonalPlaidConfiguration } from './plaid-config';
import { getPrivatePlaidItem, listPlaidConnections, savePlaidItem } from './plaid-store';
import { createBonusSchema, createFinancialAccountSchema, createManualCardSchema } from './schemas';
import { runAsTenant } from './tenant';

const FIRST_TENANT = '10000000-0000-4000-8000-000000000001';
const SECOND_TENANT = '20000000-0000-4000-8000-000000000002';

describe.sequential('tenant isolation', () => {
	let temporaryDirectory: string;
	let previousDataDirectory: string | undefined;
	let previousClientId: string | undefined;
	let previousSecret: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		previousClientId = process.env.PLAID_CLIENT_ID;
		previousSecret = process.env.PLAID_SECRET;
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-tenant-isolation-'));
		process.env.CARDDUE_DATA_DIR = temporaryDirectory;
		delete process.env.PLAID_CLIENT_ID;
		delete process.env.PLAID_SECRET;
		closeDatabaseForTests();
		resetCryptoStateForTests();
	});

	afterEach(() => {
		closeDatabaseForTests();
		resetCryptoStateForTests();
		if (previousDataDirectory === undefined) delete process.env.CARDDUE_DATA_DIR;
		else process.env.CARDDUE_DATA_DIR = previousDataDirectory;
		if (previousClientId === undefined) delete process.env.PLAID_CLIENT_ID;
		else process.env['PLAID_CLIENT_ID'] = previousClientId;
		if (previousSecret === undefined) delete process.env.PLAID_SECRET;
		else process.env['PLAID_SECRET'] = previousSecret;
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('keeps cards, financial records, and Plaid Items inside their owning account', async () => {
		const first = await runAsTenant(FIRST_TENANT, async () => {
			const card = await createManualCard(
				createManualCardSchema.parse({ nickname: 'First tenant card', last4: '1001' })
			);
			const account = await createFinancialAccount(
				createFinancialAccountSchema.parse({
					nickname: 'First tenant checking',
					accountType: 'checking'
				})
			);
			await createBonus(
				createBonusSchema.parse({
					accountId: account.id,
					name: 'First tenant bonus',
					requirements: []
				})
			);
			const itemId = await savePlaidItem('first-provider-item', 'first-access-token', 'First Bank');
			return { cardId: card.id, itemId };
		});

		await runAsTenant(SECOND_TENANT, async () => {
			expect(await listCards()).toEqual([]);
			expect(await listFinancialAccounts()).toEqual([]);
			expect(await listBonuses()).toEqual([]);
			expect(await listPlaidConnections()).toEqual([]);
			await expect(getCard(first.cardId)).rejects.toMatchObject({ status: 404 });
			await expect(deleteManualCard(first.cardId)).rejects.toMatchObject({ status: 404 });
			await expect(getPrivatePlaidItem(first.itemId)).rejects.toMatchObject({ status: 404 });

			await createManualCard(
				createManualCardSchema.parse({ nickname: 'Second tenant card', last4: '2002' })
			);
		});

		await runAsTenant(FIRST_TENANT, async () => {
			expect(await listCards()).toMatchObject([{ nickname: 'First tenant card' }]);
			expect(await listFinancialAccounts()).toMatchObject([{ nickname: 'First tenant checking' }]);
			expect(await listBonuses()).toMatchObject([{ name: 'First tenant bonus' }]);
			expect(await listPlaidConnections()).toMatchObject([{ institutionName: 'First Bank' }]);
		});
	});

	it('encrypts each tenant Plaid configuration and never falls back to another tenant', async () => {
		await runAsTenant(FIRST_TENANT, () =>
			savePersonalPlaidConfiguration('first-client-id', 'first-production-secret')
		);

		await expect(runAsTenant(SECOND_TENANT, () => getPlaidConfiguration())).resolves.toBeNull();
		await expect(runAsTenant(FIRST_TENANT, () => getPlaidConfiguration())).resolves.toMatchObject({
			clientId: 'first-client-id',
			secret: 'first-production-secret',
			environment: 'production',
			source: 'personal'
		});

		const durableMetadata = JSON.stringify(getDatabase().prepare('SELECT * FROM metadata').all());
		expect(durableMetadata).not.toContain('first-client-id');
		expect(durableMetadata).not.toContain('first-production-secret');
	});
});
