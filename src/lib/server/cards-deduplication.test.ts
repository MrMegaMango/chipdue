import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCards, replaceConnectedCards, type ConnectedCardSnapshot } from './cards';
import { resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests } from './database';
import { savePlaidItem } from './plaid-store';

function cardSnapshot(accountId: string, currentBalanceCents: number): ConnectedCardSnapshot {
	return {
		accountId,
		nickname: 'Synthetic credit card',
		issuer: 'Synthetic Bank',
		last4: '1234',
		currency: 'USD',
		statementBalanceCents: 19_977,
		minimumPaymentCents: 4_000,
		currentBalanceCents,
		dueDate: '2026-09-01',
		statementDate: '2026-08-01',
		isOverdue: false,
		autopayEnabled: false
	};
}

describe.sequential('Plaid card identity', () => {
	let temporaryDirectory: string;
	let previousDataDirectory: string | undefined;
	let previousMasterKeyPath: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		previousMasterKeyPath = process.env.CARDDUE_MASTER_KEY_PATH;
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-card-deduplication-'));
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

	it('shows an account once when it is present in two Plaid connections', async () => {
		const firstItem = await savePlaidItem(
			'provider-item-one',
			'access-token-one',
			'Synthetic Bank'
		);
		const secondItem = await savePlaidItem(
			'provider-item-two',
			'access-token-two',
			'Synthetic Bank'
		);

		await replaceConnectedCards(
			'plaid',
			firstItem,
			[cardSnapshot('shared-provider-account', 41_700)],
			'2026-08-27T12:00:00.000Z'
		);
		await replaceConnectedCards(
			'plaid',
			secondItem,
			[cardSnapshot('shared-provider-account', 41_795)],
			'2026-08-28T12:00:00.000Z'
		);

		expect(await listCards()).toMatchObject([
			{ nickname: 'Synthetic credit card', currentBalanceCents: 41_795 }
		]);
	});

	it('recognizes a relinked account when the provider changes its account ID', async () => {
		const firstItem = await savePlaidItem(
			'provider-item-before-relink',
			'access-token-before-relink',
			'Synthetic Bank'
		);
		const secondItem = await savePlaidItem(
			'provider-item-after-relink',
			'access-token-after-relink',
			'Synthetic Bank'
		);

		await replaceConnectedCards(
			'plaid',
			firstItem,
			[cardSnapshot('provider-account-before-relink', 41_700)],
			'2026-08-27T12:00:00.000Z'
		);
		await replaceConnectedCards(
			'plaid',
			secondItem,
			[cardSnapshot('provider-account-after-relink', 41_795)],
			'2026-08-28T12:00:00.000Z'
		);

		expect(await listCards()).toMatchObject([
			{ nickname: 'Synthetic credit card', currentBalanceCents: 41_795 }
		]);
	});

	it('keeps separate accounts even when their visible card details match', async () => {
		const plaidItem = await savePlaidItem(
			'provider-item-distinct',
			'access-token-distinct',
			'Synthetic Bank'
		);

		await replaceConnectedCards(
			'plaid',
			plaidItem,
			[cardSnapshot('provider-account-one', 41_795), cardSnapshot('provider-account-two', 41_795)],
			'2026-08-28T12:00:00.000Z'
		);

		expect(await listCards()).toHaveLength(2);
	});

	it('keeps lookalike cards from different issuers separate', async () => {
		const firstItem = await savePlaidItem(
			'provider-item-first-bank',
			'access-token-first-bank',
			'First Synthetic Bank'
		);
		const secondItem = await savePlaidItem(
			'provider-item-second-bank',
			'access-token-second-bank',
			'Second Synthetic Bank'
		);
		const secondCard = cardSnapshot('provider-account-second-bank', 41_795);
		secondCard.issuer = 'Second Synthetic Bank';

		await replaceConnectedCards(
			'plaid',
			firstItem,
			[cardSnapshot('provider-account-first-bank', 41_795)],
			'2026-08-28T12:00:00.000Z'
		);
		await replaceConnectedCards('plaid', secondItem, [secondCard], '2026-08-28T12:00:00.000Z');

		expect(await listCards()).toHaveLength(2);
	});
});
