import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManualCard } from './cards';
import { closeDatabaseForTests, getDatabase } from './database';
import { decryptSecret, encryptSecret, resetCryptoStateForTests } from './crypto';
import { ensurePrivateDataDirectory, getDataPaths } from './paths';
import { createManualCardSchema } from './schemas';

describe.sequential('private local persistence', () => {
	let temporaryDirectory: string;
	let previousDataDirectory: string | undefined;
	let previousMasterKeyPath: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		previousMasterKeyPath = process.env.CARDDUE_MASTER_KEY_PATH;
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'carddue-test-'));
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
		const card = await createManualCard(
			createManualCardSchema.parse({
				nickname: privateNickname,
				issuer: 'Private test issuer',
				last4: '1234',
				dueDate: '2027-02-28',
				statementBalanceCents: 12_345
			})
		);

		expect(card.nickname).toBe(privateNickname);
		getDatabase().pragma('wal_checkpoint(TRUNCATE)');
		const databaseBytes = readFileSync(join(temporaryDirectory, 'carddue.sqlite3'));
		expect(databaseBytes.includes(Buffer.from(privateNickname))).toBe(false);
		expect(databaseBytes.includes(Buffer.from('Private test issuer'))).toBe(false);
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

			expect(getDataPaths().dataDirectory).toBe(join(temporaryDirectory, 'explicit-data'));
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
