import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests } from './database';
import {
	consolidateConnectedFinancialAccountsBeforeDisconnect,
	listFinancialAccounts,
	listFinancialAccountTransactions,
	replaceConnectedFinancialAccounts,
	type ConnectedFinancialAccountSnapshot
} from './financial-records';
import { savePlaidItem } from './plaid-store';

function brokerageSnapshot(
	accountId: string,
	currentBalanceCents: number,
	transactionId?: string
): ConnectedFinancialAccountSnapshot {
	return {
		accountId,
		nickname: 'Self-Directed',
		institution: 'Chase',
		institutionLogoBase64: null,
		accountType: 'brokerage',
		last4: '3352',
		currency: 'USD',
		currentBalanceCents,
		costBasisCents: 37_500_000,
		holdings: [],
		transactionHistory: transactionId
			? {
					enabled: true,
					cursor: null,
					status: 'historical_complete',
					transactions: [
						{
							transactionId,
							name: `Transaction ${transactionId}`,
							merchantName: null,
							amountCents: 10_000,
							currency: 'USD',
							date: '2026-08-28',
							authorizedDate: null,
							pending: false,
							categoryPrimary: null,
							categoryDetailed: null
						}
					]
				}
			: undefined
	};
}

describe.sequential('connected brokerage deduplication', () => {
	let temporaryDirectory: string;
	let previousDataDirectory: string | undefined;
	let previousMasterKeyPath: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		previousMasterKeyPath = process.env.CARDDUE_MASTER_KEY_PATH;
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-account-deduplication-'));
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

	it('shows a brokerage once when it is present in two Plaid connections', async () => {
		const firstItem = await savePlaidItem('provider-item-one', 'token-one', 'Chase');
		const secondItem = await savePlaidItem('provider-item-two', 'token-two', 'Chase');

		await replaceConnectedFinancialAccounts(
			'plaid',
			firstItem,
			[brokerageSnapshot('shared-provider-account', 52_100_000)],
			'2026-08-27T12:00:00.000Z'
		);
		await replaceConnectedFinancialAccounts(
			'plaid',
			firstItem,
			[brokerageSnapshot('shared-provider-account', 52_300_000)],
			'2026-08-28T12:00:00.000Z'
		);
		await replaceConnectedFinancialAccounts(
			'plaid',
			secondItem,
			[brokerageSnapshot('shared-provider-account', 52_150_000)],
			'2026-08-29T12:00:00.000Z'
		);

		expect(await listFinancialAccounts()).toMatchObject([
			{ nickname: 'Self-Directed', last4: '3352', currentBalanceCents: 52_300_000 }
		]);
	});

	it('recognizes a relinked brokerage when Plaid changes its account ID', async () => {
		const firstItem = await savePlaidItem('provider-item-before', 'token-before', 'Chase');
		const secondItem = await savePlaidItem('provider-item-after', 'token-after', 'Chase');

		await replaceConnectedFinancialAccounts(
			'plaid',
			firstItem,
			[brokerageSnapshot('provider-account-before', 52_100_000)],
			'2026-08-27T12:00:00.000Z'
		);
		await replaceConnectedFinancialAccounts(
			'plaid',
			secondItem,
			[brokerageSnapshot('provider-account-after', 52_300_000)],
			'2026-08-28T12:00:00.000Z'
		);

		expect(await listFinancialAccounts()).toMatchObject([
			{ nickname: 'Self-Directed', last4: '3352', currentBalanceCents: 52_300_000 }
		]);
	});

	it('keeps lookalike brokerages from the same connection separate', async () => {
		const item = await savePlaidItem('provider-item-distinct', 'token-distinct', 'Chase');

		await replaceConnectedFinancialAccounts(
			'plaid',
			item,
			[
				brokerageSnapshot('provider-account-one', 52_100_000),
				brokerageSnapshot('provider-account-two', 52_300_000)
			],
			'2026-08-28T12:00:00.000Z'
		);

		expect(await listFinancialAccounts()).toHaveLength(2);
	});

	it('merges unique observed balances and transactions before a duplicate disconnects', async () => {
		const canonicalItem = await savePlaidItem(
			'provider-item-canonical',
			'canonical-token',
			'Chase'
		);
		const duplicateItem = await savePlaidItem(
			'provider-item-duplicate',
			'duplicate-token',
			'Chase'
		);

		await replaceConnectedFinancialAccounts(
			'plaid',
			canonicalItem,
			[brokerageSnapshot('canonical-account', 52_100_000, 'canonical-transaction')],
			'2026-08-27T12:00:00.000Z'
		);
		await replaceConnectedFinancialAccounts(
			'plaid',
			canonicalItem,
			[brokerageSnapshot('canonical-account', 51_760_404, 'canonical-transaction')],
			'2026-09-01T19:39:45.000Z'
		);
		await replaceConnectedFinancialAccounts(
			'plaid',
			duplicateItem,
			[brokerageSnapshot('duplicate-account', 52_133_437, 'duplicate-transaction')],
			'2026-09-01T16:27:55.000Z'
		);

		await expect(
			consolidateConnectedFinancialAccountsBeforeDisconnect('plaid', duplicateItem)
		).resolves.toEqual({
			mergedAccountCount: 1,
			addedObservedPointCount: 1,
			addedTransactionCount: 1
		});

		const [account] = await listFinancialAccounts();
		expect(account).toMatchObject({
			currentBalanceCents: 51_760_404,
			connectionId: canonicalItem
		});
		expect(account.balanceHistory.filter((point) => point.source === 'observed')).toHaveLength(3);
		expect((await listFinancialAccountTransactions(account.id)).transactions).toHaveLength(2);
	});

	it('does not merge ambiguous lookalike accounts from the same connection', async () => {
		const canonicalItem = await savePlaidItem('provider-item-many', 'canonical-token', 'Chase');
		const duplicateItem = await savePlaidItem('provider-item-one', 'duplicate-token', 'Chase');

		await replaceConnectedFinancialAccounts(
			'plaid',
			canonicalItem,
			[
				brokerageSnapshot('canonical-account-one', 52_100_000),
				brokerageSnapshot('canonical-account-two', 52_200_000)
			],
			'2026-08-28T12:00:00.000Z'
		);
		await replaceConnectedFinancialAccounts(
			'plaid',
			duplicateItem,
			[brokerageSnapshot('duplicate-account', 52_300_000)],
			'2026-08-29T12:00:00.000Z'
		);

		await expect(
			consolidateConnectedFinancialAccountsBeforeDisconnect('plaid', duplicateItem)
		).resolves.toEqual({
			mergedAccountCount: 0,
			addedObservedPointCount: 0,
			addedTransactionCount: 0
		});
	});
});
