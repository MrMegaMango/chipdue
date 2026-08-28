import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const plaidMocks = vi.hoisted(() => ({
	linkTokenCreate: vi.fn(),
	liabilitiesGet: vi.fn(),
	transactionsSync: vi.fn()
}));

vi.mock('plaid', async (importOriginal) => {
	const actual = await importOriginal<typeof import('plaid')>();
	return {
		...actual,
		PlaidApi: class {
			linkTokenCreate(request: unknown) {
				return plaidMocks.linkTokenCreate(request);
			}

			liabilitiesGet(request: unknown) {
				return plaidMocks.liabilitiesGet(request);
			}

			transactionsSync(request: unknown) {
				return plaidMocks.transactionsSync(request);
			}
		}
	};
});

import { listCards, listCardTransactions } from './cards';
import { resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests } from './database';
import {
	createPlaidLinkToken,
	createPlaidTransactionsUpdateToken,
	resetPlaidClientForTests,
	syncPlaidItem
} from './plaid';
import { savePlaidItem } from './plaid-store';

function liabilityResponse() {
	return {
		data: {
			accounts: [
				{
					account_id: 'account-alpha',
					name: 'Synthetic credit card',
					mask: '3333',
					type: 'credit',
					balances: {
						current: 410,
						iso_currency_code: 'USD',
						unofficial_currency_code: null
					}
				}
			],
			liabilities: {
				credit: [
					{
						account_id: 'account-alpha',
						last_statement_balance: 300,
						minimum_payment_amount: 20,
						next_payment_due_date: '2020-05-28',
						last_statement_issue_date: '2020-04-28',
						is_overdue: false
					}
				]
			}
		}
	};
}

function transaction(
	id: string,
	amount: number,
	name: string,
	date: string
): Record<string, unknown> {
	return {
		transaction_id: id,
		account_id: 'account-alpha',
		amount,
		name,
		merchant_name: name,
		iso_currency_code: 'USD',
		unofficial_currency_code: null,
		date,
		authorized_date: date,
		pending: false,
		personal_finance_category: {
			primary: 'FOOD_AND_DRINK',
			detailed: 'FOOD_AND_DRINK_RESTAURANT'
		}
	};
}

describe.sequential('Plaid transaction history', () => {
	let temporaryDirectory: string;
	let previousDataDirectory: string | undefined;
	let previousClientId: string | undefined;
	let previousSecret: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		previousClientId = process.env.PLAID_CLIENT_ID;
		previousSecret = process.env.PLAID_SECRET;
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-plaid-test-'));
		process.env.CARDDUE_DATA_DIR = temporaryDirectory;
		process.env['PLAID_CLIENT_ID'] = 'example-client-value';
		process.env['PLAID_SECRET'] = 'example-secret-value';
		closeDatabaseForTests();
		resetCryptoStateForTests();
		resetPlaidClientForTests();
		vi.clearAllMocks();
	});

	afterEach(() => {
		closeDatabaseForTests();
		resetCryptoStateForTests();
		resetPlaidClientForTests();
		if (previousDataDirectory === undefined) delete process.env.CARDDUE_DATA_DIR;
		else process.env.CARDDUE_DATA_DIR = previousDataDirectory;
		if (previousClientId === undefined) delete process.env.PLAID_CLIENT_ID;
		else process.env['PLAID_CLIENT_ID'] = previousClientId;
		if (previousSecret === undefined) delete process.env.PLAID_SECRET;
		else process.env['PLAID_SECRET'] = previousSecret;
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('requests Transactions for new Items and explicit consent for existing Items', async () => {
		plaidMocks.linkTokenCreate.mockResolvedValue({
			data: { link_token: 'test-link-value', expiration: '2026-08-28T00:00:00.000Z' }
		});

		await createPlaidLinkToken();
		expect(plaidMocks.linkTokenCreate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				products: ['liabilities', 'transactions'],
				transactions: { days_requested: 730 }
			})
		);

		const itemId = await savePlaidItem(
			'provider-item-alpha',
			'test-access-value',
			'Synthetic Bank'
		);
		await createPlaidTransactionsUpdateToken(itemId);
		expect(plaidMocks.linkTokenCreate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				access_token: 'test-access-value',
				additional_consented_products: ['transactions']
			})
		);
	});

	it('paginates, persists, modifies, and removes encrypted card transactions', async () => {
		const itemId = await savePlaidItem(
			'provider-item-alpha',
			'test-access-value',
			'Synthetic Bank'
		);
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());
		plaidMocks.transactionsSync
			.mockResolvedValueOnce({
				data: {
					added: [transaction('transaction-alpha', 12.34, 'Merchant alpha', '2020-04-20')],
					modified: [],
					removed: [],
					next_cursor: 'cursor-alpha',
					has_more: true,
					transactions_update_status: 'INITIAL_UPDATE_COMPLETE'
				}
			})
			.mockResolvedValueOnce({
				data: {
					added: [transaction('transaction-beta', -50, 'Payment beta', '2020-04-18')],
					modified: [],
					removed: [],
					next_cursor: 'cursor-beta',
					has_more: false,
					transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE'
				}
			});

		const firstSync = await syncPlaidItem(itemId, { enableTransactions: true });
		expect(firstSync.transactionCount).toBe(2);
		expect(plaidMocks.transactionsSync.mock.calls[0][0]).toMatchObject({
			access_token: 'test-access-value',
			options: { days_requested: 730 }
		});
		expect(plaidMocks.transactionsSync.mock.calls[1][0]).toMatchObject({
			cursor: 'cursor-alpha'
		});

		const [card] = await listCards();
		expect(card.transactionHistoryEnabled).toBe(true);
		let history = await listCardTransactions(card.id);
		expect(history.transactions.map(({ name }) => name)).toEqual([
			'Merchant alpha',
			'Payment beta'
		]);

		plaidMocks.transactionsSync.mockResolvedValueOnce({
			data: {
				added: [],
				modified: [transaction('transaction-alpha', 21.5, 'Merchant alpha', '2020-04-20')],
				removed: [{ transaction_id: 'transaction-beta' }],
				next_cursor: 'cursor-gamma',
				has_more: false,
				transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE'
			}
		});

		await syncPlaidItem(itemId);
		expect(plaidMocks.transactionsSync).toHaveBeenLastCalledWith(
			expect.objectContaining({ cursor: 'cursor-beta' })
		);
		history = await listCardTransactions(card.id);
		expect(history.transactions).toHaveLength(1);
		expect(history.transactions[0]).toMatchObject({
			name: 'Merchant alpha',
			amountCents: 2_150
		});
	});

	it('keeps the cards available while Plaid prepares the first transaction sync', async () => {
		const itemId = await savePlaidItem(
			'provider-item-alpha',
			'test-access-value',
			'Synthetic Bank'
		);
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());
		plaidMocks.transactionsSync.mockRejectedValue({
			response: { data: { error_code: 'PRODUCT_NOT_READY' } }
		});

		const result = await syncPlaidItem(itemId, { enableTransactions: true });
		expect(result).toMatchObject({ count: 1, transactionCount: 0 });
		const [card] = await listCards();
		expect(card).toMatchObject({
			transactionHistoryEnabled: true,
			transactionHistoryStatus: 'NOT_READY'
		});
		expect((await listCardTransactions(card.id)).transactions).toEqual([]);
	});

	it('restarts pagination from the original cursor when Plaid data changes mid-sync', async () => {
		const itemId = await savePlaidItem(
			'provider-item-alpha',
			'example-access-value',
			'Synthetic Bank'
		);
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());
		plaidMocks.transactionsSync
			.mockResolvedValueOnce({
				data: {
					added: [transaction('transaction-stale', 10, 'Stale result', '2020-04-20')],
					modified: [],
					removed: [],
					next_cursor: 'cursor-stale',
					has_more: true,
					transactions_update_status: 'INITIAL_UPDATE_COMPLETE'
				}
			})
			.mockRejectedValueOnce({
				response: {
					data: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' }
				}
			})
			.mockResolvedValueOnce({
				data: {
					added: [transaction('transaction-fresh', 20, 'Fresh result', '2020-04-21')],
					modified: [],
					removed: [],
					next_cursor: 'cursor-fresh',
					has_more: false,
					transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE'
				}
			});

		await syncPlaidItem(itemId, { enableTransactions: true });
		expect(plaidMocks.transactionsSync.mock.calls[0][0]).not.toHaveProperty('cursor');
		expect(plaidMocks.transactionsSync.mock.calls[2][0]).not.toHaveProperty('cursor');
		const [card] = await listCards();
		expect((await listCardTransactions(card.id)).transactions.map(({ name }) => name)).toEqual([
			'Fresh result'
		]);
	});
});
