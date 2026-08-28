import {
	AccountType,
	Configuration,
	CountryCode,
	CreditAccountSubtype,
	PlaidApi,
	PlaidEnvironments,
	Products,
	type LinkTokenCreateRequest
} from 'plaid';
import type { PlaidConnection } from '$lib/types';
import { replacePlaidCards, type PlaidCardSnapshot } from './cards';
import { getInstallId } from './database';
import { AppError } from './errors';
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
	try {
		const response = await getPlaidClient().linkTokenCreate({
			...(await baseLinkTokenRequest()),
			products: [Products.Liabilities],
			account_filters: {
				credit: { account_subtypes: [CreditAccountSubtype.CreditCard] }
			}
		});
		return { linkToken: response.data.link_token, expiration: response.data.expiration };
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw await sanitizedPlaidError(error);
	}
}

export async function createPlaidUpdateToken(
	localItemId: string
): Promise<{ linkToken: string; expiration: string }> {
	const item = await getPrivatePlaidItem(localItemId);
	try {
		const response = await getPlaidClient().linkTokenCreate({
			...(await baseLinkTokenRequest()),
			access_token: item.accessToken
		});
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
	return Number.isSafeInteger(cents) ? cents : null;
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

export async function syncPlaidItem(
	localItemId: string
): Promise<{ syncedAt: string; count: number }> {
	const item = await getPrivatePlaidItem(localItemId);
	try {
		const response = await getPlaidClient().liabilitiesGet({ access_token: item.accessToken });
		const liabilities = new Map(
			(response.data.liabilities.credit ?? [])
				.filter((liability) => liability.account_id)
				.map((liability) => [liability.account_id as string, liability])
		);
		const snapshots: PlaidCardSnapshot[] = [];

		for (const account of response.data.accounts) {
			const liability = liabilities.get(account.account_id);
			if (!liability || account.type !== AccountType.Credit) continue;
			snapshots.push({
				accountId: account.account_id,
				nickname: account.name.trim().slice(0, 80) || 'Credit card',
				issuer: item.institutionName,
				last4: safeLast4(account.mask),
				currency: safeCurrency(
					account.balances.iso_currency_code ?? account.balances.unofficial_currency_code
				),
				statementBalanceCents: amountToCents(liability.last_statement_balance),
				minimumPaymentCents: amountToCents(liability.minimum_payment_amount),
				currentBalanceCents: amountToCents(account.balances.current),
				dueDate: safeDate(liability.next_payment_due_date),
				statementDate: safeDate(liability.last_statement_issue_date),
				isOverdue: liability.is_overdue,
				autopayEnabled: false
			});
		}

		const syncedAt = new Date().toISOString();
		await replacePlaidCards(localItemId, snapshots, syncedAt);
		await markPlaidItemSynced(localItemId, syncedAt);
		return { syncedAt, count: snapshots.length };
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw await sanitizedPlaidError(error, localItemId);
	}
}

export async function syncAllPlaidItems(): Promise<{
	syncedItems: number;
	cardCount: number;
	lastSyncedAt: string | null;
}> {
	const connections = await listPlaidConnections();
	const results = await Promise.all(connections.map((connection) => syncPlaidItem(connection.id)));
	return {
		syncedItems: results.length,
		cardCount: results.reduce((total, result) => total + result.count, 0),
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
