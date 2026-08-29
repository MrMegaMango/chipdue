import {
	AccountType,
	Configuration,
	CountryCode,
	PlaidApi,
	PlaidEnvironments,
	Products,
	type LinkTokenCreateRequest,
	type Transaction,
	type TransactionsUpdateStatus
} from 'plaid';
import { Buffer } from 'node:buffer';
import type { PlaidConnection } from '$lib/types';
import type { TransactionHistoryStatus } from '$lib/types';
import type { InvestmentHolding } from '$lib/types';
import {
	readPlaidTransactionState,
	replacePlaidCards,
	type PlaidCardSnapshot,
	type PlaidTransactionState,
	type StoredPlaidTransaction,
	type StoredTransactionHistory
} from './cards';
import { privateFingerprint } from './crypto';
import { getInstallId } from './database';
import { AppError } from './errors';
import {
	replacePlaidFinancialAccounts,
	type PlaidFinancialAccountSnapshot
} from './financial-records';
import {
	getPrivatePlaidItem,
	listPlaidConnections,
	markPlaidItemNeedsUpdate,
	markPlaidItemSynced,
	publicPlaidConnection,
	removeLocalPlaidItem,
	savePlaidItem
} from './plaid-store';

type PlaidEnvironmentName = 'sandbox' | 'production';
const TRANSACTION_HISTORY_DAYS = 730;
const MAX_TRANSACTION_SYNC_PAGES = 100;
const MAX_TRANSACTION_SYNC_RESTARTS = 3;
const MAX_STORED_TRANSACTIONS_PER_CARD = 10_000;
const MAX_INSTITUTION_LOGO_BYTES = 256_000;
const MAX_STORED_HOLDINGS_PER_ACCOUNT = 1_000;
let cachedClient: { signature: string; client: PlaidApi } | undefined;

function plaidConfiguration(): {
	clientId: string;
	secret: string;
	environment: PlaidEnvironmentName;
} {
	const clientId = process.env.PLAID_CLIENT_ID?.trim();
	const secret = process.env.PLAID_SECRET?.trim();
	const environmentValue = process.env.PLAID_ENV?.trim().toLowerCase() || 'sandbox';
	if (!clientId || !secret) {
		throw new AppError('PLAID_NOT_CONFIGURED', 'Plaid credentials are not configured.', 503);
	}
	if (!['sandbox', 'production'].includes(environmentValue)) {
		throw new AppError('PLAID_NOT_CONFIGURED', 'The Plaid environment is invalid.', 503);
	}
	return { clientId, secret, environment: environmentValue as PlaidEnvironmentName };
}

export function isPlaidConfigured(): boolean {
	try {
		plaidConfiguration();
		return true;
	} catch {
		return false;
	}
}

function getPlaidClient(): PlaidApi {
	const config = plaidConfiguration();
	const signature = `${config.environment}:${config.clientId}:${config.secret}`;
	if (cachedClient?.signature === signature) return cachedClient.client;

	const configuration = new Configuration({
		basePath: PlaidEnvironments[config.environment],
		baseOptions: {
			headers: {
				'PLAID-CLIENT-ID': config.clientId,
				'PLAID-SECRET': config.secret
			}
		}
	});
	const client = new PlaidApi(configuration);
	cachedClient = { signature, client };
	return client;
}

function plaidErrorCode(error: unknown): string | null {
	const data = (error as { response?: { data?: unknown } })?.response?.data;
	if (!data || typeof data !== 'object') return null;
	const code = (data as { error_code?: unknown }).error_code;
	return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
}

function optionalLinkProductUnavailable(error: unknown): boolean {
	return new Set(['INVALID_PRODUCT', 'PRODUCT_NOT_ENABLED', 'PRODUCTS_NOT_SUPPORTED']).has(
		plaidErrorCode(error) ?? ''
	);
}

async function sanitizedPlaidError(error: unknown, itemId?: string): Promise<AppError> {
	const code = plaidErrorCode(error);
	if (code === 'ITEM_LOGIN_REQUIRED' && itemId) {
		await markPlaidItemNeedsUpdate(itemId);
		return new AppError('PLAID_LOGIN_REQUIRED', 'This connection needs to be updated.', 409);
	}
	if (code === 'PRODUCT_NOT_READY') {
		return new AppError(
			'PLAID_DATA_NOT_READY',
			'Card details are still being prepared. Try again soon.',
			409
		);
	}
	return new AppError('PLAID_UNAVAILABLE', 'Plaid could not complete the request.', 502);
}

async function baseLinkTokenRequest(): Promise<Omit<LinkTokenCreateRequest, 'products'>> {
	const redirectUri = process.env.PLAID_REDIRECT_URI?.trim();
	return {
		client_name: 'ChipDue',
		country_codes: [CountryCode.Us],
		language: 'en',
		user: { client_user_id: await getInstallId() },
		...(redirectUri ? { redirect_uri: redirectUri } : {})
	};
}

export async function createPlaidLinkToken(): Promise<{ linkToken: string; expiration: string }> {
	const request = {
		...(await baseLinkTokenRequest()),
		products: [Products.Transactions],
		transactions: { days_requested: TRANSACTION_HISTORY_DAYS }
	};
	try {
		const response = await getPlaidClient().linkTokenCreate({
			...request,
			additional_consented_products: [Products.Liabilities, Products.Investments]
		});
		return { linkToken: response.data.link_token, expiration: response.data.expiration };
	} catch (error) {
		if (error instanceof AppError) throw error;
		if (!optionalLinkProductUnavailable(error)) throw await sanitizedPlaidError(error);
	}

	try {
		const response = await getPlaidClient().linkTokenCreate({
			...request,
			additional_consented_products: [Products.Liabilities]
		});
		return { linkToken: response.data.link_token, expiration: response.data.expiration };
	} catch (error) {
		if (error instanceof AppError) throw error;
		if (!optionalLinkProductUnavailable(error)) throw await sanitizedPlaidError(error);
	}

	try {
		const response = await getPlaidClient().linkTokenCreate(request);
		return { linkToken: response.data.link_token, expiration: response.data.expiration };
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw await sanitizedPlaidError(error);
	}
}

export async function createPlaidTransactionsUpdateToken(
	localItemId: string
): Promise<{ linkToken: string; expiration: string }> {
	const item = await getPrivatePlaidItem(localItemId);
	try {
		const response = await getPlaidClient().linkTokenCreate({
			...(await baseLinkTokenRequest()),
			access_token: item.accessToken,
			additional_consented_products: [Products.Transactions]
		});
		return { linkToken: response.data.link_token, expiration: response.data.expiration };
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw await sanitizedPlaidError(error, localItemId);
	}
}

export async function createPlaidUpdateToken(
	localItemId: string
): Promise<{ linkToken: string; expiration: string }> {
	const item = await getPrivatePlaidItem(localItemId);
	const request = {
		...(await baseLinkTokenRequest()),
		access_token: item.accessToken,
		update: { account_selection_enabled: true }
	};
	try {
		const response = await getPlaidClient().linkTokenCreate({
			...request,
			additional_consented_products: [Products.Transactions, Products.Investments]
		});
		return { linkToken: response.data.link_token, expiration: response.data.expiration };
	} catch (error) {
		if (error instanceof AppError) throw error;
		if (!optionalLinkProductUnavailable(error)) {
			throw await sanitizedPlaidError(error, localItemId);
		}
	}

	try {
		const response = await getPlaidClient().linkTokenCreate({
			...request,
			additional_consented_products: [Products.Transactions]
		});
		return { linkToken: response.data.link_token, expiration: response.data.expiration };
	} catch (error) {
		if (error instanceof AppError) throw error;
		if (!optionalLinkProductUnavailable(error)) {
			throw await sanitizedPlaidError(error, localItemId);
		}
	}

	try {
		const response = await getPlaidClient().linkTokenCreate(request);
		return { linkToken: response.data.link_token, expiration: response.data.expiration };
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw await sanitizedPlaidError(error, localItemId);
	}
}

export async function exchangePlaidPublicToken(
	publicToken: string,
	institutionName: string | null
): Promise<{ connection: PlaidConnection; synced: boolean }> {
	let itemId: string;
	let accessToken: string;
	try {
		const response = await getPlaidClient().itemPublicTokenExchange({ public_token: publicToken });
		itemId = response.data.item_id;
		accessToken = response.data.access_token;
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw await sanitizedPlaidError(error);
	}

	const localItemId = await savePlaidItem(itemId, accessToken, institutionName);
	return { connection: await publicPlaidConnection(localItemId), synced: false };
}

function amountToCents(value: number | null): number | null {
	if (value === null || !Number.isFinite(value)) return null;
	const cents = Math.round(value * 100);
	return Number.isSafeInteger(cents) && Math.abs(cents) <= 100_000_000_000 ? cents : null;
}

function priceToMicros(value: number): number | null {
	if (!Number.isFinite(value)) return null;
	const micros = Math.round(value * 1_000_000);
	return Number.isSafeInteger(micros) && Math.abs(micros) <= 100_000_000_000_000 ? micros : null;
}

function safeQuantity(value: number): number | null {
	return Number.isFinite(value) && Math.abs(value) <= 1_000_000_000_000 ? value : null;
}

function safeCurrency(value: string | null): string {
	return value && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : 'USD';
}

function safeLast4(value: string | null): string | null {
	return value && /^[A-Za-z0-9]{4}$/.test(value) ? value : null;
}

function safeDate(value: string | null): string | null {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const [year, month, day] = value.split('-').map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return parsed.getUTCFullYear() === year &&
		parsed.getUTCMonth() === month - 1 &&
		parsed.getUTCDate() === day
		? value
		: null;
}

function safeText(value: string | null | undefined, maximum: number): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	return normalized ? normalized.slice(0, maximum) : null;
}

function safeInstitutionLogo(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	if (!normalized || normalized.length > 350_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
		return null;
	}
	const bytes = Buffer.from(normalized, 'base64');
	if (bytes.length < 8 || bytes.length > MAX_INSTITUTION_LOGO_BYTES) return null;
	const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (!pngSignature.every((byte, index) => bytes[index] === byte)) return null;
	return bytes.toString('base64');
}

async function institutionBrand(
	accessToken: string,
	fallbackName: string | null
): Promise<{ name: string | null; logoBase64: string | null }> {
	let name = fallbackName;
	try {
		const itemResponse = await getPlaidClient().itemGet({ access_token: accessToken });
		name = safeText(itemResponse.data.item.institution_name, 80) ?? name;
		const institutionId = safeText(itemResponse.data.item.institution_id, 128);
		if (!institutionId) return { name, logoBase64: null };

		const institutionResponse = await getPlaidClient().institutionsGetById({
			institution_id: institutionId,
			country_codes: [CountryCode.Us],
			options: { include_optional_metadata: true }
		});
		return {
			name: safeText(institutionResponse.data.institution.name, 80) ?? name,
			logoBase64: safeInstitutionLogo(institutionResponse.data.institution.logo)
		};
	} catch {
		// Branding is presentational and must never prevent balances or activity from syncing.
		return { name, logoBase64: null };
	}
}

function transactionSnapshot(transaction: Transaction): StoredPlaidTransaction | null {
	const transactionId = safeText(transaction.transaction_id, 256);
	const date = safeDate(transaction.date);
	const amountCents = amountToCents(transaction.amount);
	if (!transactionId || !date || amountCents === null) return null;
	return {
		transactionId,
		name: safeText(transaction.name, 160) ?? 'Transaction',
		merchantName: safeText(transaction.merchant_name, 120),
		amountCents,
		currency: safeCurrency(transaction.iso_currency_code ?? transaction.unofficial_currency_code),
		date,
		authorizedDate: safeDate(transaction.authorized_date),
		pending: transaction.pending === true,
		categoryPrimary: safeText(transaction.personal_finance_category?.primary, 80),
		categoryDetailed: safeText(transaction.personal_finance_category?.detailed, 120)
	};
}

function normalizeTransactionStatus(value: TransactionsUpdateStatus): TransactionHistoryStatus {
	return value;
}

async function fetchTransactionUpdates(
	accessToken: string,
	cursor: string | null
): Promise<{
	added: Transaction[];
	modified: Transaction[];
	removed: string[];
	cursor: string | null;
	status: TransactionHistoryStatus;
}> {
	for (let restart = 0; restart < MAX_TRANSACTION_SYNC_RESTARTS; restart += 1) {
		let pageCursor = cursor;
		const added: Transaction[] = [];
		const modified: Transaction[] = [];
		const removed: string[] = [];
		let status: TransactionHistoryStatus;
		try {
			for (let page = 0; page < MAX_TRANSACTION_SYNC_PAGES; page += 1) {
				const response = await getPlaidClient().transactionsSync({
					access_token: accessToken,
					...(pageCursor ? { cursor: pageCursor } : {}),
					count: 500,
					...(!cursor && page === 0
						? { options: { days_requested: TRANSACTION_HISTORY_DAYS } }
						: {})
				});
				added.push(...response.data.added);
				modified.push(...response.data.modified);
				removed.push(...response.data.removed.map((entry) => entry.transaction_id));
				pageCursor = response.data.next_cursor || null;
				status = normalizeTransactionStatus(response.data.transactions_update_status);
				if (!response.data.has_more) {
					return { added, modified, removed, cursor: pageCursor, status };
				}
			}
			throw new AppError(
				'PLAID_UNAVAILABLE',
				'Plaid returned too many transaction pages for one sync.',
				502
			);
		} catch (error) {
			if (plaidErrorCode(error) !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') throw error;
		}
	}
	throw new AppError('PLAID_UNAVAILABLE', 'Plaid could not stabilize transaction history.', 502);
}

function applyTransactionUpdates(
	state: PlaidTransactionState,
	updates: Awaited<ReturnType<typeof fetchTransactionUpdates>>
): PlaidTransactionState {
	const byAccountReference = new Map(
		[...state.byAccountReference].map(([reference, transactions]) => [
			reference,
			new Map(transactions.map((transaction) => [transaction.transactionId, transaction]))
		])
	);

	for (const transaction of [...updates.added, ...updates.modified]) {
		const snapshot = transactionSnapshot(transaction);
		const accountId = safeText(transaction.account_id, 256);
		if (!snapshot || !accountId) continue;
		for (const transactions of byAccountReference.values()) {
			transactions.delete(snapshot.transactionId);
		}
		const reference = privateFingerprint(accountId, 'plaid-account');
		let transactions = byAccountReference.get(reference);
		if (!transactions) {
			transactions = new Map();
			byAccountReference.set(reference, transactions);
		}
		transactions.set(snapshot.transactionId, snapshot);
	}
	for (const transactionId of updates.removed) {
		for (const transactions of byAccountReference.values()) transactions.delete(transactionId);
	}

	return {
		enabled: true,
		cursor: updates.cursor,
		status: updates.status,
		byAccountReference: new Map(
			[...byAccountReference].map(([reference, transactions]) => [
				reference,
				[...transactions.values()]
					.sort((left, right) => right.date.localeCompare(left.date))
					.slice(0, MAX_STORED_TRANSACTIONS_PER_CARD)
			])
		)
	};
}

function syncedFinancialAccountType(
	type: AccountType,
	subtype: string | null
): PlaidFinancialAccountSnapshot['accountType'] | null {
	if (type === AccountType.Investment) return 'brokerage';
	if (type !== AccountType.Depository) return null;
	if (subtype === 'checking') return 'checking';
	if (subtype === 'savings' || subtype === 'money market') return 'savings';
	if (subtype === 'cash management') return 'cash_management';
	return 'other';
}

function optionalProductCanBeSkipped(error: unknown): boolean {
	return new Set([
		'ADDITIONAL_CONSENT_REQUIRED',
		'NO_INVESTMENT_ACCOUNTS',
		'NO_LIABILITY_ACCOUNTS',
		'PRODUCT_NOT_ENABLED',
		'PRODUCT_NOT_READY',
		'PRODUCTS_NOT_SUPPORTED'
	]).has(plaidErrorCode(error) ?? '');
}

export async function syncPlaidItem(
	localItemId: string,
	options: { enableTransactions?: boolean } = {}
): Promise<{ syncedAt: string; count: number; accountCount: number; transactionCount: number }> {
	const item = await getPrivatePlaidItem(localItemId);
	try {
		const client = getPlaidClient();
		const [accountsResponse, brand] = await Promise.all([
			client.accountsGet({ access_token: item.accessToken }),
			institutionBrand(item.accessToken, item.institutionName)
		]);
		const plaidAccounts = accountsResponse.data.accounts;

		let liabilities = new Map<
			string,
			NonNullable<
				Awaited<ReturnType<PlaidApi['liabilitiesGet']>>['data']['liabilities']['credit']
			>[number]
		>();
		if (plaidAccounts.some((account) => account.type === AccountType.Credit)) {
			try {
				const response = await client.liabilitiesGet({ access_token: item.accessToken });
				liabilities = new Map(
					(response.data.liabilities.credit ?? [])
						.filter((liability) => liability.account_id)
						.map((liability) => [liability.account_id as string, liability])
				);
			} catch (error) {
				if (!optionalProductCanBeSkipped(error)) throw error;
			}
		}

		const investmentCostBasis = new Map<string, number>();
		const investmentHoldings = new Map<string, InvestmentHolding[]>();
		let investmentHoldingsAvailable = false;
		if (plaidAccounts.some((account) => account.type === AccountType.Investment)) {
			try {
				const response = await client.investmentsHoldingsGet({
					access_token: item.accessToken
				});
				investmentHoldingsAvailable = true;
				const securities = new Map(
					(response.data.securities ?? []).map((security) => [security.security_id, security])
				);
				const totals = new Map<string, { cents: number; complete: boolean; count: number }>();
				for (const holding of response.data.holdings) {
					const accountId = safeText(holding.account_id, 256);
					if (!accountId) continue;
					const total = totals.get(accountId) ?? { cents: 0, complete: true, count: 0 };
					const costBasis = amountToCents(holding.cost_basis);
					total.count += 1;
					if (costBasis === null) total.complete = false;
					else total.cents += costBasis;
					totals.set(accountId, total);

					const quantity = safeQuantity(holding.quantity);
					const priceMicros = priceToMicros(holding.institution_price);
					if (quantity === null || priceMicros === null) continue;
					const security = securities.get(holding.security_id);
					const tickerSymbol = safeText(security?.ticker_symbol, 32);
					const priceDate = safeDate(holding.institution_price_as_of ?? null);
					const priceDateTime = safeText(holding.institution_price_datetime, 40);
					const position: InvestmentHolding = {
						name: safeText(security?.name, 160) ?? tickerSymbol ?? 'Unlabeled holding',
						tickerSymbol,
						securityType: safeText(security?.type, 32),
						quantity,
						priceMicros,
						valueCents: amountToCents(holding.institution_value),
						costBasisCents: costBasis,
						currency: safeCurrency(holding.iso_currency_code ?? holding.unofficial_currency_code),
						priceAsOf: priceDate ?? safeDate(priceDateTime?.slice(0, 10) ?? null)
					};
					const positions = investmentHoldings.get(accountId) ?? [];
					if (positions.length < MAX_STORED_HOLDINGS_PER_ACCOUNT) positions.push(position);
					investmentHoldings.set(accountId, positions);
				}
				for (const [accountId, total] of totals) {
					if (total.complete && total.count > 0 && Number.isSafeInteger(total.cents)) {
						investmentCostBasis.set(accountId, total.cents);
					}
				}
			} catch (error) {
				if (!optionalProductCanBeSkipped(error)) throw error;
			}
		}

		let transactionState = await readPlaidTransactionState(localItemId);
		if (options.enableTransactions || transactionState.enabled) {
			try {
				transactionState = applyTransactionUpdates(
					transactionState,
					await fetchTransactionUpdates(item.accessToken, transactionState.cursor)
				);
			} catch (error) {
				if (plaidErrorCode(error) !== 'PRODUCT_NOT_READY') throw error;
				transactionState = {
					...transactionState,
					enabled: true,
					status: 'NOT_READY'
				};
			}
		}
		const snapshots: PlaidCardSnapshot[] = [];
		const accountSnapshots: PlaidFinancialAccountSnapshot[] = [];

		for (const account of plaidAccounts) {
			const liability = liabilities.get(account.account_id);
			const transactionReference = privateFingerprint(account.account_id, 'plaid-account');
			const transactionHistory: StoredTransactionHistory | undefined = transactionState.enabled
				? {
						enabled: true,
						accountReference: transactionReference,
						cursor: transactionState.cursor,
						status: transactionState.status,
						transactions: transactionState.byAccountReference.get(transactionReference) ?? []
					}
				: undefined;
			if (account.type === AccountType.Credit) {
				snapshots.push({
					accountId: account.account_id,
					nickname: account.name.trim().slice(0, 80) || 'Credit card',
					issuer: brand.name,
					issuerLogoBase64: brand.logoBase64,
					last4: safeLast4(account.mask),
					currency: safeCurrency(
						account.balances.iso_currency_code ?? account.balances.unofficial_currency_code
					),
					statementBalanceCents: amountToCents(liability?.last_statement_balance ?? null),
					minimumPaymentCents: amountToCents(liability?.minimum_payment_amount ?? null),
					currentBalanceCents: amountToCents(account.balances.current),
					dueDate: safeDate(liability?.next_payment_due_date ?? null),
					statementDate: safeDate(liability?.last_statement_issue_date ?? null),
					isOverdue: liability?.is_overdue ?? null,
					autopayEnabled: false,
					...(transactionHistory ? { transactionHistory } : {})
				});
				continue;
			}

			const accountType = syncedFinancialAccountType(account.type, account.subtype);
			if (!accountType) continue;
			accountSnapshots.push({
				accountId: account.account_id,
				nickname: account.name.trim().slice(0, 80) || 'Financial account',
				institution: brand.name,
				accountType,
				last4: safeLast4(account.mask),
				currency: safeCurrency(
					account.balances.iso_currency_code ?? account.balances.unofficial_currency_code
				),
				currentBalanceCents: amountToCents(account.balances.current),
				costBasisCents:
					accountType === 'brokerage'
						? (investmentCostBasis.get(account.account_id) ?? null)
						: null,
				holdings:
					accountType === 'brokerage' && investmentHoldingsAvailable
						? (investmentHoldings.get(account.account_id) ?? []).sort(
								(left, right) => (right.valueCents ?? 0) - (left.valueCents ?? 0)
							)
						: null,
				...(transactionHistory ? { transactionHistory } : {})
			});
		}

		const syncedAt = new Date().toISOString();
		await replacePlaidFinancialAccounts(localItemId, accountSnapshots, syncedAt);
		await replacePlaidCards(localItemId, snapshots, syncedAt);
		await markPlaidItemSynced(localItemId, syncedAt);
		return {
			syncedAt,
			count: snapshots.length,
			accountCount: accountSnapshots.length,
			transactionCount: [...transactionState.byAccountReference.values()].reduce(
				(total, transactions) => total + transactions.length,
				0
			)
		};
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw await sanitizedPlaidError(error, localItemId);
	}
}

export async function syncAllPlaidItems(): Promise<{
	syncedItems: number;
	cardCount: number;
	accountCount: number;
	transactionCount: number;
	lastSyncedAt: string | null;
}> {
	const connections = await listPlaidConnections();
	const results = await Promise.all(connections.map((connection) => syncPlaidItem(connection.id)));
	return {
		syncedItems: results.length,
		cardCount: results.reduce((total, result) => total + result.count, 0),
		accountCount: results.reduce((total, result) => total + result.accountCount, 0),
		transactionCount: results.reduce((total, result) => total + result.transactionCount, 0),
		lastSyncedAt:
			results
				.map((result) => result.syncedAt)
				.sort()
				.at(-1) ?? null
	};
}

export async function disconnectPlaidItem(localItemId: string): Promise<void> {
	const item = await getPrivatePlaidItem(localItemId);
	try {
		await getPlaidClient().itemRemove({ access_token: item.accessToken });
	} catch (error) {
		if (error instanceof AppError) throw error;
		const code = plaidErrorCode(error);
		if (code !== 'INVALID_ACCESS_TOKEN' && code !== 'ITEM_NOT_FOUND') {
			throw await sanitizedPlaidError(error, localItemId);
		}
	}
	await removeLocalPlaidItem(localItemId);
}

export function resetPlaidClientForTests(): void {
	cachedClient = undefined;
}
