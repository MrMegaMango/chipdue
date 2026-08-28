import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createManualCard,
	listCards,
	listCardTransactions,
	replacePlaidCards,
	updateCardRewards
} from './cards';
import { closeDatabaseForTests, getDatabase } from './database';
import { decryptSecret, encryptSecret, resetCryptoStateForTests } from './crypto';
import { ensurePrivateDataDirectory, getDataPaths } from './paths';
import { savePlaidItem } from './plaid-store';
import { createManualCardSchema, updateCardRewardsSchema } from './schemas';

describe.sequential('private local persistence', () => {
	let temporaryDirectory: string;
	let previousDataDirectory: string | undefined;
	let previousMasterKeyPath: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		previousMasterKeyPath = process.env.CARDDUE_MASTER_KEY_PATH;
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-test-'));
		process.env.CARDDUE_DATA_DIR = temporaryDirectory;
		delete process.env.CARDDUE_MASTER_KEY_PATH;
		closeDatabaseForTests();
		resetCryptoStateForTests();
	});

	afterEach(() => {
		closeDatabaseForTests();
		resetCryptoStateForTests();
		if (previousDataDirectory === undefined) delete process.env.CARDDUE_DATA_DIR;
		else process.env.CARDDUE_DATA_DIR = previousDataDirectory;
		if (previousMasterKeyPath === undefined) delete process.env.CARDDUE_MASTER_KEY_PATH;
		else process.env.CARDDUE_MASTER_KEY_PATH = previousMasterKeyPath;
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('authenticates ciphertext with its intended purpose', () => {
		const encrypted = encryptSecret('access-sandbox-secret', 'plaid-access-token:test');
		expect(encrypted).not.toContain('access-sandbox-secret');
		expect(decryptSecret(encrypted, 'plaid-access-token:test')).toBe('access-sandbox-secret');
		expect(() => decryptSecret(encrypted, 'plaid-access-token:other')).toThrow();
	});

	it('never writes plaintext card details to SQLite', async () => {
		const privateNickname = 'Private test card 7f061bd7';
		const privateRewardProgram = 'Private reward program 2d1441a4';
		const privateRewardCategory = 'Private reward category a9d12520';
		const card = await createManualCard(
			createManualCardSchema.parse({
				nickname: privateNickname,
				issuer: 'Private test issuer',
				last4: '1234',
				dueDate: '2027-02-28',
				statementBalanceCents: 12_345
			})
		);
		const updatedCard = await updateCardRewards(
			card.id,
			updateCardRewardsSchema.parse({
				rewardProgramName: privateRewardProgram,
				rewardValueCents: 8_765,
				rewardCategories: [{ name: privateRewardCategory, rate: '4x' }]
			})
		);

		expect(card.nickname).toBe(privateNickname);
		expect(updatedCard).toMatchObject({
			rewardProgramName: privateRewardProgram,
			rewardValueCents: 8_765
		});
		expect(updatedCard.rewardCategories[0]).toMatchObject({
			name: privateRewardCategory,
			rate: '4x'
		});
		getDatabase().pragma('wal_checkpoint(TRUNCATE)');
		const databaseBytes = readFileSync(join(temporaryDirectory, 'carddue.sqlite3'));
		for (const privateValue of [
			privateNickname,
			'Private test issuer',
			privateRewardProgram,
			privateRewardCategory
		]) {
			expect(databaseBytes.includes(Buffer.from(privateValue))).toBe(false);
		}
	});

	it('encrypts transaction history, cursors, and provider identifiers at rest', async () => {
		const merchant = 'Private merchant alpha';
		const providerTransactionId = 'provider-transaction-alpha';
		const cursor = 'private-cursor-alpha';
		const plaidItemId = await savePlaidItem(
			'provider-item-alpha',
			'private-access-token-alpha',
			'Synthetic Bank'
		);
		await replacePlaidCards(
			plaidItemId,
			[
				{
					accountId: 'provider-account-alpha',
					nickname: 'Synthetic card',
					issuer: 'Synthetic Bank',
					last4: '3333',
					currency: 'USD',
					statementBalanceCents: 12_345,
					minimumPaymentCents: 2_000,
					currentBalanceCents: 14_500,
					dueDate: '2026-09-28',
					statementDate: '2026-08-28',
					isOverdue: false,
					autopayEnabled: false,
					transactionHistory: {
						enabled: true,
						cursor,
						status: 'HISTORICAL_UPDATE_COMPLETE',
						transactions: [
							{
								transactionId: providerTransactionId,
								name: merchant,
								merchantName: merchant,
								amountCents: 4_321,
								currency: 'USD',
								date: '2026-08-20',
								authorizedDate: '2026-08-19',
								pending: false,
								categoryPrimary: 'FOOD_AND_DRINK',
								categoryDetailed: 'FOOD_AND_DRINK_RESTAURANT'
							}
						]
					}
				}
			],
			'2026-08-27T12:00:00.000Z'
		);

		const [card] = await listCards();
		expect(card.transactionHistoryEnabled).toBe(true);
		const history = await listCardTransactions(card.id);
		expect(history.transactions[0]).toMatchObject({
			name: merchant,
			merchantName: merchant,
			amountCents: 4_321
		});
		expect(history.transactions[0].id).not.toBe(providerTransactionId);

		getDatabase().pragma('wal_checkpoint(TRUNCATE)');
		const databaseBytes = readFileSync(join(temporaryDirectory, 'carddue.sqlite3'));
		for (const privateValue of [merchant, providerTransactionId, cursor]) {
			expect(databaseBytes.includes(Buffer.from(privateValue))).toBe(false);
		}
	});

	it('refuses a data directory inside the Git checkout', () => {
		process.env.CARDDUE_DATA_DIR = join(process.cwd(), 'private-data-must-not-be-created');
		expect(() => getDataPaths()).toThrow(/outside a Git checkout/);
	});

	it('refuses a data directory inside any other Git checkout', () => {
		const otherCheckout = join(temporaryDirectory, 'other-checkout');
		mkdirSync(join(otherCheckout, '.git'), { recursive: true });
		process.env.CARDDUE_DATA_DIR = join(otherCheckout, 'private-data-must-not-be-created');
		expect(() => getDataPaths()).toThrow(/outside a Git checkout/);
	});

	it('accepts an explicit safe data directory without home environment variables', () => {
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		try {
			delete process.env.HOME;
			delete process.env.USERPROFILE;
			process.env.CARDDUE_DATA_DIR = join(temporaryDirectory, 'explicit-data');

			expect(getDataPaths().dataDirectory).toBe(
				join(realpathSync.native(temporaryDirectory), 'explicit-data')
			);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	});

	it('resolves symlinked parents before checking the checkout boundary', () => {
		if (process.platform === 'win32') return;
		const checkoutLink = join(temporaryDirectory, 'checkout-link');
		symlinkSync(process.cwd(), checkoutLink, 'dir');
		process.env.CARDDUE_DATA_DIR = join(checkoutLink, 'private-data-must-not-be-created');
		expect(() => getDataPaths()).toThrow(/outside a Git checkout/);
	});

	it('rejects linked data, key, and SQLite files', () => {
		if (process.platform === 'win32') return;

		const linkedDirectoryTarget = join(temporaryDirectory, 'linked-directory-target');
		mkdirSync(linkedDirectoryTarget, { mode: 0o700 });
		const linkedDirectory = join(temporaryDirectory, 'linked-directory');
		symlinkSync(linkedDirectoryTarget, linkedDirectory, 'dir');
		process.env.CARDDUE_DATA_DIR = linkedDirectory;
		expect(() => getDataPaths()).toThrow(/symbolic links/);

		const realDataDirectory = join(temporaryDirectory, 'real-data');
		mkdirSync(realDataDirectory, { mode: 0o700 });
		process.env.CARDDUE_DATA_DIR = realDataDirectory;
		const linkedFileTarget = join(temporaryDirectory, 'linked-file-target');
		writeFileSync(linkedFileTarget, 'not a secret');

		const linkedKey = join(temporaryDirectory, 'linked-key');
		symlinkSync(linkedFileTarget, linkedKey, 'file');
		process.env.CARDDUE_MASTER_KEY_PATH = linkedKey;
		expect(() => getDataPaths()).toThrow(/symbolic links/);

		delete process.env.CARDDUE_MASTER_KEY_PATH;
		symlinkSync(linkedFileTarget, join(realDataDirectory, 'carddue.sqlite3'), 'file');
		expect(() => getDataPaths()).toThrow(/regular, non-linked files/);
	});

	it('rejects an insecure existing custom directory without changing its mode', () => {
		if (process.platform === 'win32') return;
		const insecureDirectory = join(temporaryDirectory, 'insecure-custom-directory');
		mkdirSync(insecureDirectory, { mode: 0o755 });
		chmodSync(insecureDirectory, 0o755);
		process.env.CARDDUE_DATA_DIR = insecureDirectory;
		const modeBefore = statSync(insecureDirectory).mode & 0o777;

		expect(() => ensurePrivateDataDirectory()).toThrow(/accessible only to its owner/);
		expect(statSync(insecureDirectory).mode & 0o777).toBe(modeBefore);
	});
});
