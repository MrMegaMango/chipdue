import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const plaidMocks = vi.hoisted(() => ({
	linkTokenCreate: vi.fn(),
	accountsGet: vi.fn(),
	liabilitiesGet: vi.fn(),
	investmentsHoldingsGet: vi.fn(),
	transactionsSync: vi.fn(),
	itemGet: vi.fn(),
	institutionsGet: vi.fn(),
	institutionsGetById: vi.fn()
}));

vi.mock('plaid', async (importOriginal) => {
	const actual = await importOriginal<typeof import('plaid')>();
	return {
		...actual,
		PlaidApi: class {
			accountsGet(request: unknown) {
				return plaidMocks.accountsGet(request);
			}

			linkTokenCreate(request: unknown) {
				return plaidMocks.linkTokenCreate(request);
			}

			liabilitiesGet(request: unknown) {
				return plaidMocks.liabilitiesGet(request);
			}

			investmentsHoldingsGet(request: unknown) {
				return plaidMocks.investmentsHoldingsGet(request);
			}

			transactionsSync(request: unknown) {
				return plaidMocks.transactionsSync(request);
			}

			itemGet(request: unknown) {
				return plaidMocks.itemGet(request);
			}

			institutionsGet(request: unknown) {
				return plaidMocks.institutionsGet(request);
			}

			institutionsGetById(request: unknown) {
				return plaidMocks.institutionsGetById(request);
			}
		}
	};
});

import {
	applyAutomaticCardRewardProfile,
	listCards,
	listCardTransactions,
	updateCardRewards
} from './cards';
import { resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests, getDatabase } from './database';
import {
	configurePersonalPlaid,
	createPlaidLinkToken,
	createPlaidTransactionsUpdateToken,
	createPlaidUpdateToken,
	resetPlaidClientForTests,
	syncPlaidItem
} from './plaid';
import { savePlaidItem } from './plaid-store';
import { updateCardRewardsSchema } from './schemas';
import {
	listFinancialAccounts,
	listFinancialAccountTransactions,
	updateFinancialAccount
} from './financial-records';

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

function mixedAccountsResponse(checkingBalance = 1_250, brokerageBalance = 8_400) {
	return {
		data: {
			accounts: [
				...liabilityResponse().data.accounts,
				{
					account_id: 'account-checking',
					name: 'Business checking',
					mask: '1212',
					type: 'depository',
					subtype: 'checking',
					balances: {
						current: checkingBalance,
						available: checkingBalance - 50,
						iso_currency_code: 'USD',
						unofficial_currency_code: null
					}
				},
				{
					account_id: 'account-savings',
					name: 'Rainy day savings',
					mask: '3434',
					type: 'depository',
					subtype: 'savings',
					balances: {
						current: 5_000,
						available: 5_000,
						iso_currency_code: 'USD',
						unofficial_currency_code: null
					}
				},
				{
					account_id: 'account-brokerage',
					name: 'Taxable brokerage',
					mask: '5656',
					type: 'investment',
					subtype: 'brokerage',
					balances: {
						current: brokerageBalance,
						available: 420,
						iso_currency_code: 'USD',
						unofficial_currency_code: null
					}
				}
			]
		}
	};
}

function transaction(
	id: string,
	amount: number,
	name: string,
	date: string,
	accountId = 'account-alpha'
): Record<string, unknown> {
	return {
		transaction_id: id,
		account_id: accountId,
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
		plaidMocks.accountsGet.mockResolvedValue({
			data: { accounts: liabilityResponse().data.accounts }
		});
		plaidMocks.investmentsHoldingsGet.mockResolvedValue({ data: { holdings: [] } });
		plaidMocks.itemGet.mockRejectedValue(new Error('Institution metadata unavailable'));
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

	it('verifies and encrypts a personal Production configuration', async () => {
		plaidMocks.institutionsGet.mockResolvedValue({ data: { institutions: [] } });
		const status = await configurePersonalPlaid('personal-client-id', 'personal-production-secret');

		expect(plaidMocks.institutionsGet).toHaveBeenCalledWith({
			count: 1,
			offset: 0,
			country_codes: ['US']
		});
		expect(status).toEqual({
			configured: true,
			source: 'personal',
			environment: 'production'
		});
		const durableMetadata = JSON.stringify(getDatabase().prepare('SELECT * FROM metadata').all());
		expect(durableMetadata).not.toContain('personal-client-id');
		expect(durableMetadata).not.toContain('personal-production-secret');
	});

	it('requests broad account consent for new and existing Items', async () => {
		plaidMocks.linkTokenCreate.mockResolvedValue({
			data: { link_token: 'test-link-value', expiration: '2026-08-28T00:00:00.000Z' }
		});

		await createPlaidLinkToken();
		expect(plaidMocks.linkTokenCreate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				products: ['transactions'],
				additional_consented_products: ['liabilities', 'investments'],
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

		await createPlaidUpdateToken(itemId);
		expect(plaidMocks.linkTokenCreate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				access_token: 'test-access-value',
				additional_consented_products: ['transactions', 'investments'],
				update: { account_selection_enabled: true }
			})
		);
	});

	it('keeps core account linking available when optional Plaid products are disabled', async () => {
		const unavailableProduct = {
			response: { data: { error_code: 'PRODUCT_NOT_ENABLED' } }
		};
		plaidMocks.linkTokenCreate.mockRejectedValueOnce(unavailableProduct).mockResolvedValueOnce({
			data: { link_token: 'fallback-link-value', expiration: '2026-08-28T00:00:00.000Z' }
		});

		await createPlaidLinkToken();
		expect(plaidMocks.linkTokenCreate).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				products: ['transactions'],
				additional_consented_products: ['liabilities']
			})
		);

		const itemId = await savePlaidItem(
			'provider-item-fallback',
			'test-access-value',
			'Synthetic Bank'
		);
		plaidMocks.linkTokenCreate.mockRejectedValueOnce(unavailableProduct).mockResolvedValueOnce({
			data: { link_token: 'fallback-update-value', expiration: '2026-08-28T00:00:00.000Z' }
		});

		await createPlaidUpdateToken(itemId);
		expect(plaidMocks.linkTokenCreate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				access_token: 'test-access-value',
				additional_consented_products: ['transactions'],
				update: { account_selection_enabled: true }
			})
		);
	});

	it('stores Plaid institution branding with synced cards', async () => {
		const logoBase64 =
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
		const itemId = await savePlaidItem(
			'provider-item-brand',
			'test-access-value',
			'Original institution name'
		);
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());
		plaidMocks.itemGet.mockResolvedValue({
			data: {
				item: {
					institution_id: 'ins_brand',
					institution_name: 'Institution from Item'
				}
			}
		});
		plaidMocks.institutionsGetById.mockResolvedValue({
			data: {
				institution: { name: 'Institution from Plaid', logo: logoBase64 }
			}
		});

		await syncPlaidItem(itemId);

		expect(plaidMocks.institutionsGetById).toHaveBeenCalledWith({
			institution_id: 'ins_brand',
			country_codes: ['US'],
			options: { include_optional_metadata: true }
		});
		const [card] = await listCards();
		expect(card.issuer).toBe('Institution from Plaid');
		expect(card.issuerLogoUrl).toBe(`data:image/png;base64,${logoBase64}`);
	});

	it('imports bank and brokerage accounts and refreshes balances automatically', async () => {
		const itemId = await savePlaidItem(
			'provider-item-accounts',
			'test-access-value',
			'Synthetic Bank'
		);
		plaidMocks.accountsGet.mockResolvedValueOnce(mixedAccountsResponse());
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());
		plaidMocks.investmentsHoldingsGet.mockResolvedValueOnce({
			data: {
				holdings: [
					{
						account_id: 'account-brokerage',
						security_id: 'security-equity',
						cost_basis: 6_800,
						institution_price: 180,
						institution_price_as_of: '2026-08-27',
						institution_value: 7_200,
						quantity: 40,
						iso_currency_code: 'USD',
						unofficial_currency_code: null
					},
					{
						account_id: 'account-brokerage',
						security_id: 'security-fund',
						cost_basis: 200,
						institution_price: 50,
						institution_value: 1_200,
						quantity: 24,
						iso_currency_code: 'USD',
						unofficial_currency_code: null
					}
				],
				securities: [
					{
						security_id: 'security-equity',
						name: 'Example Equity',
						ticker_symbol: 'EXMPL',
						type: 'equity'
					},
					{
						security_id: 'security-fund',
						name: 'Example Bond Fund',
						ticker_symbol: 'XBND',
						type: 'etf'
					}
				]
			}
		});

		const firstSync = await syncPlaidItem(itemId);
		expect(firstSync).toMatchObject({ count: 1, accountCount: 3 });
		const accounts = await listFinancialAccounts();
		expect(accounts).toHaveLength(3);
		expect(accounts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: 'connected',
					accountType: 'checking',
					currentBalanceCents: 125_000,
					connectionId: itemId,
					connectionProvider: 'plaid'
				}),
				expect.objectContaining({
					source: 'connected',
					accountType: 'brokerage',
					currentBalanceCents: 840_000,
					costBasisCents: 700_000,
					holdings: [
						expect.objectContaining({
							name: 'Example Equity',
							tickerSymbol: 'EXMPL',
							quantity: 40,
							priceMicros: 180_000_000,
							valueCents: 720_000,
							priceAsOf: '2026-08-27'
						}),
						expect.objectContaining({ tickerSymbol: 'XBND', priceMicros: 50_000_000 })
					]
				})
			])
		);
		const encryptedRows = JSON.stringify(
			getDatabase().prepare('SELECT payload_enc FROM cards').all()
		);
		expect(encryptedRows).not.toContain('Example Equity');
		expect(encryptedRows).not.toContain('EXMPL');

		const checking = accounts.find((account) => account.accountType === 'checking');
		expect(checking).toBeDefined();
		await updateFinancialAccount(checking!.id, {
			nickname: 'Operating cash',
			ownerType: 'business',
			hidden: true,
			openedDate: '2025-01-02',
			notes: 'Primary operating account'
		});
		await expect(
			updateFinancialAccount(checking!.id, { currentBalanceCents: 999_999 })
		).rejects.toMatchObject({ code: 'CONNECTED_ACCOUNT_READ_ONLY', status: 409 });

		plaidMocks.accountsGet.mockResolvedValueOnce(mixedAccountsResponse(1_575, 8_900));
		plaidMocks.investmentsHoldingsGet.mockResolvedValueOnce({
			data: {
				holdings: [
					{
						account_id: 'account-brokerage',
						security_id: 'security-equity',
						cost_basis: 7_250,
						institution_price: 181.25,
						institution_value: 7_250,
						quantity: 40,
						iso_currency_code: 'USD',
						unofficial_currency_code: null
					}
				],
				securities: [
					{
						security_id: 'security-equity',
						name: 'Example Equity',
						ticker_symbol: 'EXMPL',
						type: 'equity'
					}
				]
			}
		});
		await syncPlaidItem(itemId);
		const refreshed = await listFinancialAccounts();
		expect(refreshed.find((account) => account.id === checking!.id)).toMatchObject({
			nickname: 'Operating cash',
			ownerType: 'business',
			hidden: true,
			openedDate: '2025-01-02',
			notes: 'Primary operating account',
			currentBalanceCents: 157_500
		});
		expect(refreshed.find((account) => account.accountType === 'brokerage')).toMatchObject({
			currentBalanceCents: 890_000,
			costBasisCents: 725_000,
			holdings: [expect.objectContaining({ tickerSymbol: 'EXMPL', priceMicros: 181_250_000 })]
		});
		expect(await listCards()).toHaveLength(1);
	});

	it('keeps brokerage balances when Investments holdings are unavailable', async () => {
		const itemId = await savePlaidItem(
			'provider-item-brokerage-balance',
			'test-access-value',
			'Synthetic Brokerage'
		);
		plaidMocks.accountsGet.mockResolvedValueOnce(mixedAccountsResponse());
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());
		plaidMocks.investmentsHoldingsGet.mockRejectedValueOnce({
			response: { data: { error_code: 'PRODUCT_NOT_ENABLED' } }
		});

		await syncPlaidItem(itemId);
		expect(
			(await listFinancialAccounts()).find((account) => account.accountType === 'brokerage')
		).toMatchObject({ currentBalanceCents: 840_000, costBasisCents: null });
	});

	it('preserves the last successful holdings when Investments is temporarily unavailable', async () => {
		const itemId = await savePlaidItem(
			'provider-item-holdings-fallback',
			'test-access-value',
			'Synthetic Brokerage'
		);
		plaidMocks.accountsGet.mockResolvedValueOnce(mixedAccountsResponse());
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());
		plaidMocks.investmentsHoldingsGet.mockResolvedValueOnce({
			data: {
				holdings: [
					{
						account_id: 'account-brokerage',
						security_id: 'security-equity',
						cost_basis: 6_800,
						institution_price: 180,
						institution_value: 7_200,
						quantity: 40,
						iso_currency_code: 'USD',
						unofficial_currency_code: null
					}
				],
				securities: [
					{
						security_id: 'security-equity',
						name: 'Example Equity',
						ticker_symbol: 'EXMPL',
						type: 'equity'
					}
				]
			}
		});
		await syncPlaidItem(itemId);

		plaidMocks.accountsGet.mockResolvedValueOnce(mixedAccountsResponse(1_250, 8_500));
		plaidMocks.investmentsHoldingsGet.mockRejectedValueOnce({
			response: { data: { error_code: 'PRODUCT_NOT_READY' } }
		});
		await syncPlaidItem(itemId);

		const brokerage = (await listFinancialAccounts()).find(
			(account) => account.accountType === 'brokerage'
		);
		expect(brokerage).toMatchObject({
			currentBalanceCents: 850_000,
			costBasisCents: 680_000,
			holdings: [expect.objectContaining({ tickerSymbol: 'EXMPL', priceMicros: 180_000_000 })]
		});
	});

	it('automatically populates rewards from Plaid official card names', async () => {
		const itemId = await savePlaidItem(
			'provider-item-automatic-rewards',
			'test-access-value',
			'Chase'
		);
		plaidMocks.accountsGet.mockResolvedValue({
			data: {
				accounts: [
					{
						...liabilityResponse().data.accounts[0],
						name: 'CREDIT CARD',
						official_name: 'CHASE SAPPHIRE PREFERRED®'
					}
				]
			}
		});
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());

		await syncPlaidItem(itemId);

		const [card] = await listCards();
		expect(card).toMatchObject({
			nickname: 'CREDIT CARD',
			rewardProgramName: 'Chase Ultimate Rewards',
			rewardType: 'points',
			rewardBaseRate: 1,
			rewardSource: 'automatic',
			rewardProfileName: 'Chase Sapphire Preferred',
			rewardCalculation: 'static'
		});
		expect(card.rewardCategories).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'Chase Travel', multiplier: 5, matchCategory: null }),
				expect.objectContaining({ name: 'Dining', multiplier: 3, matchCategory: 'dining' }),
				expect.objectContaining({ name: 'Other travel', multiplier: 2, matchCategory: 'travel' })
			])
		);
	});

	it('keeps a selected product profile when Plaid continues returning a generic card name', async () => {
		const itemId = await savePlaidItem(
			'provider-item-selected-rewards',
			'test-access-value',
			'Chase'
		);
		plaidMocks.accountsGet.mockResolvedValue({
			data: {
				accounts: [
					{
						...liabilityResponse().data.accounts[0],
						name: 'CREDIT CARD',
						official_name: null
					}
				]
			}
		});
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());

		await syncPlaidItem(itemId);
		const [genericCard] = await listCards();
		expect(genericCard.rewardSource).toBeNull();

		await applyAutomaticCardRewardProfile(genericCard.id, 'chase-freedom-unlimited');
		await syncPlaidItem(itemId);

		const [refreshedCard] = await listCards();
		expect(refreshedCard).toMatchObject({
			id: genericCard.id,
			rewardProfileName: 'Chase Freedom Unlimited',
			rewardProgramName: 'Chase Ultimate Rewards',
			rewardBaseRate: 1.5,
			rewardSource: 'automatic'
		});
	});

	it('keeps user-entered rewards when a Plaid card refreshes', async () => {
		const itemId = await savePlaidItem('provider-item-rewards', 'test-access-value', 'Chase');
		plaidMocks.accountsGet.mockResolvedValue({
			data: {
				accounts: [
					{
						...liabilityResponse().data.accounts[0],
						official_name: 'Chase Freedom Unlimited'
					}
				]
			}
		});
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());
		await syncPlaidItem(itemId);

		const [card] = await listCards();
		await updateCardRewards(
			card.id,
			updateCardRewardsSchema.parse({
				rewardProgramName: 'Synthetic points',
				rewardValueCents: 9_876,
				rewardType: 'points',
				rewardBaseRate: 1,
				rewardCategories: [
					{ name: 'Dining', multiplier: 3, matchCategory: 'dining' },
					{ name: 'Groceries', multiplier: 5, matchCategory: 'groceries' }
				]
			})
		);

		await syncPlaidItem(itemId);
		const [refreshedCard] = await listCards();
		expect(refreshedCard).toMatchObject({
			id: card.id,
			rewardProgramName: 'Synthetic points',
			rewardValueCents: 9_876,
			rewardSource: 'manual'
		});
		expect(refreshedCard.rewardCategories).toMatchObject([
			{ name: 'Dining', multiplier: 3, matchCategory: 'dining' },
			{ name: 'Groceries', multiplier: 5, matchCategory: 'groceries' }
		]);
	});

	it('ranks Venmo reward categories automatically from statement-period activity', async () => {
		const itemId = await savePlaidItem(
			'provider-item-venmo-rewards',
			'test-access-value',
			'Synchrony Bank'
		);
		plaidMocks.accountsGet.mockResolvedValue({
			data: {
				accounts: [
					{
						...liabilityResponse().data.accounts[0],
						name: 'Venmo Credit Card'
					}
				]
			}
		});
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());
		plaidMocks.transactionsSync.mockResolvedValueOnce({
			data: {
				added: [
					transaction('venmo-dining', 80, 'Synthetic restaurant', '2026-08-20'),
					{
						...transaction('venmo-grocery', 40, 'Synthetic grocery', '2026-08-19'),
						personal_finance_category: {
							primary: 'FOOD_AND_DRINK',
							detailed: 'FOOD_AND_DRINK_GROCERIES'
						}
					},
					{
						...transaction('venmo-gas', 20, 'Synthetic gas', '2026-08-18'),
						personal_finance_category: {
							primary: 'TRANSPORTATION',
							detailed: 'TRANSPORTATION_GAS'
						}
					}
				],
				modified: [],
				removed: [],
				next_cursor: 'cursor-venmo-rewards',
				has_more: false,
				transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE'
			}
		});

		await syncPlaidItem(itemId, { enableTransactions: true });
		const [card] = await listCards();
		const history = await listCardTransactions(card.id);
		expect(card).toMatchObject({
			rewardSource: 'automatic',
			rewardProfileName: 'Venmo Credit Card',
			rewardCalculation: 'venmo_spend_ranked'
		});
		expect(history.transactions.map((entry) => entry.rewardEstimate)).toEqual([
			expect.objectContaining({
				rate: 3,
				amount: 240,
				categoryName: 'Dining & nightlife · top category'
			}),
			expect.objectContaining({ rate: 2, amount: 80, categoryName: 'Groceries · second category' }),
			expect.objectContaining({ rate: 1, amount: 20, categoryName: 'Gas · other category' })
		]);
	});

	it('estimates earned rewards for each eligible transaction', async () => {
		const itemId = await savePlaidItem(
			'provider-item-earned-rewards',
			'test-access-value',
			'Synthetic Bank'
		);
		plaidMocks.liabilitiesGet.mockResolvedValue(liabilityResponse());
		plaidMocks.transactionsSync.mockResolvedValueOnce({
			data: {
				added: [
					transaction('transaction-dining', 12.34, 'Synthetic restaurant', '2020-04-20'),
					transaction('transaction-payment', -50, 'Synthetic payment', '2020-04-19')
				],
				modified: [],
				removed: [],
				next_cursor: 'cursor-rewards',
				has_more: false,
				transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE'
			}
		});

		await syncPlaidItem(itemId, { enableTransactions: true });
		const [card] = await listCards();
		await updateCardRewards(
			card.id,
			updateCardRewardsSchema.parse({
				rewardType: 'points',
				rewardBaseRate: 1,
				rewardCategories: [{ name: 'Dining', multiplier: 3, matchCategory: 'dining' }]
			})
		);

		const history = await listCardTransactions(card.id);
		expect(history.transactions[0].rewardEstimate).toEqual({
			type: 'points',
			amount: 37,
			rate: 3,
			categoryName: 'Dining',
			currency: 'USD'
		});
		expect(history.transactions[1].rewardEstimate).toBeNull();
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
		expect((await listCardTransactions(card.id, 1)).transactions.map(({ name }) => name)).toEqual([
			'Merchant alpha'
		]);
		await expect(listCardTransactions(card.id, 0)).rejects.toMatchObject({
			code: 'INVALID_REQUEST',
			status: 400
		});

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

	it('persists and incrementally refreshes activity for a linked checking account', async () => {
		const itemId = await savePlaidItem(
			'provider-item-checking-history',
			'test-access-value',
			'Synthetic Bank'
		);
		plaidMocks.accountsGet.mockResolvedValue({
			data: {
				accounts: [
					{
						account_id: 'account-checking',
						name: 'Business checking',
						mask: '1212',
						type: 'depository',
						subtype: 'checking',
						balances: {
							current: 2_500,
							iso_currency_code: 'USD',
							unofficial_currency_code: null
						}
					}
				]
			}
		});
		plaidMocks.transactionsSync.mockResolvedValueOnce({
			data: {
				added: [
					transaction(
						'transaction-checking',
						12.34,
						'Synthetic purchase',
						'2026-08-28',
						'account-checking'
					)
				],
				modified: [],
				removed: [],
				next_cursor: 'cursor-checking-one',
				has_more: false,
				transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE'
			}
		});

		const firstSync = await syncPlaidItem(itemId, { enableTransactions: true });
		expect(firstSync).toMatchObject({ count: 0, accountCount: 1, transactionCount: 1 });
		const [checking] = await listFinancialAccounts();
		expect(checking).toMatchObject({
			transactionHistoryEnabled: true,
			transactionHistoryStatus: 'historical_complete'
		});
		expect((await listFinancialAccountTransactions(checking.id)).transactions).toMatchObject([
			{ name: 'Synthetic purchase', amountCents: 1_234 }
		]);
		await updateFinancialAccount(checking.id, {
			ownerType: 'business',
			openedDate: '2026-08-27'
		});

		plaidMocks.transactionsSync.mockResolvedValueOnce({
			data: {
				added: [],
				modified: [
					transaction(
						'transaction-checking',
						21.5,
						'Synthetic purchase',
						'2026-08-28',
						'account-checking'
					)
				],
				removed: [],
				next_cursor: 'cursor-checking-two',
				has_more: false,
				transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE'
			}
		});
		await syncPlaidItem(itemId);
		expect(plaidMocks.transactionsSync).toHaveBeenLastCalledWith(
			expect.objectContaining({ cursor: 'cursor-checking-one' })
		);
		const [refreshed] = await listFinancialAccounts();
		expect(refreshed).toMatchObject({ ownerType: 'business', openedDate: '2026-08-27' });
		expect((await listFinancialAccountTransactions(refreshed.id)).transactions[0]).toMatchObject({
			name: 'Synthetic purchase',
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
			transactionHistoryStatus: 'preparing'
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
