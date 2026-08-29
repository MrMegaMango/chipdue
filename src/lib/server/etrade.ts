import { createHmac, randomBytes } from 'node:crypto';
import type {
	BrokerageHistoryEstimateResponse,
	BrokerageOrder,
	BrokerageOrdersResponse,
	FinancialAccount
} from '$lib/types';
import { privateUuid } from './crypto';
import {
	getEtradeAuthorization,
	getEtradeConfiguration,
	removeEtradeConfiguration,
	saveEtradeAuthorization,
	saveEtradeConfiguration,
	type EtradeAuthorization,
	type EtradeConfiguration
} from './etrade-store';
import { AppError } from './errors';
import { reconstructBrokerageHistory } from './brokerage-history';
import { getFinancialAccount, replaceEstimatedFinancialAccountHistory } from './financial-records';
import { historicalCloseSeries } from './market-history';

const ETRADE_API_ORIGIN = 'https://api.etrade.com';
const ETRADE_AUTHORIZE_URL = 'https://us.etrade.com/e/t/etws/authorize';
const REQUEST_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const EASTERN_TIME_ZONE = 'America/New_York';

type JsonRecord = Record<string, unknown>;
type EtradeFetch = typeof fetch;
let etradeFetch: EtradeFetch = fetch;

class EtradeHttpError extends Error {
	constructor(readonly status: number) {
		super('E*TRADE request failed.');
	}
}

export interface EtradePublicStatus {
	configured: boolean;
	authorization: 'not_configured' | 'disconnected' | 'pending' | 'connected' | 'expired';
	accountCount: number;
	authorizedAt: string | null;
	authorizationUrl: string | null;
}

interface EtradeAccount {
	accountId: string;
	accountIdKey: string;
	accountName: string;
	accountStatus: string;
	institutionType: string;
}

export interface EtradePosition {
	symbol: string;
	securityType: string;
	quantity: number;
	marketValue: number;
}

export interface EtradeTransaction {
	date: string;
	amount: number;
	transactionType: string;
	symbol: string | null;
	securityType: string;
	quantity: number;
}

interface EtradePortfolio {
	positions: EtradePosition[];
	cashBalance: number;
	totalPages: number;
}

interface OAuthHeaderOptions {
	consumerKey: string;
	consumerSecret: string;
	token?: string;
	tokenSecret?: string;
	callback?: string;
	verifier?: string;
	nonce?: string;
	timestamp?: number;
}

function oauthEncode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
	);
}

export function oauthAuthorizationHeader(
	method: string,
	requestUrl: string,
	options: OAuthHeaderOptions
): string {
	const url = new URL(requestUrl);
	const oauthParameters: Array<[string, string]> = [
		['oauth_consumer_key', options.consumerKey],
		['oauth_nonce', options.nonce ?? randomBytes(18).toString('base64url')],
		['oauth_signature_method', 'HMAC-SHA1'],
		['oauth_timestamp', String(options.timestamp ?? Math.floor(Date.now() / 1000))]
	];
	if (options.token) oauthParameters.push(['oauth_token', options.token]);
	if (options.callback) oauthParameters.push(['oauth_callback', options.callback]);
	if (options.verifier) oauthParameters.push(['oauth_verifier', options.verifier]);

	const signatureParameters = [...Array.from(url.searchParams.entries()), ...oauthParameters]
		.map(([key, value]) => [oauthEncode(key), oauthEncode(value)] as const)
		.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
			if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
			if (leftValue === rightValue) return 0;
			return leftValue < rightValue ? -1 : 1;
		});
	const parameterString = signatureParameters.map(([key, value]) => `${key}=${value}`).join('&');
	const normalizedUrl = `${url.protocol}//${url.host}${url.pathname}`;
	const signatureBase = [
		method.toUpperCase(),
		oauthEncode(normalizedUrl),
		oauthEncode(parameterString)
	].join('&');
	const signingKey = `${oauthEncode(options.consumerSecret)}&${oauthEncode(options.tokenSecret ?? '')}`;
	const signature = createHmac('sha1', signingKey).update(signatureBase).digest('base64');

	return `OAuth realm="",${[...oauthParameters, ['oauth_signature', signature] as [string, string]]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`)
		.join(',')}`;
}

function easternDay(date = new Date()): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: EASTERN_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(date);
	const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return `${value.year}-${value.month}-${value.day}`;
}

function pendingAuthorizationIsCurrent(
	authorization: EtradeAuthorization,
	now = Date.now()
): boolean {
	return (
		authorization.state === 'pending' &&
		Number.isFinite(Date.parse(authorization.createdAt)) &&
		now - Date.parse(authorization.createdAt) >= 0 &&
		now - Date.parse(authorization.createdAt) < REQUEST_TOKEN_TTL_MS
	);
}

function connectedAuthorizationIsCurrent(
	authorization: EtradeAuthorization,
	now = new Date()
): boolean {
	return (
		authorization.state === 'connected' && authorization.authorizedEasternDay === easternDay(now)
	);
}

function authorizationUrl(configuration: EtradeConfiguration, requestToken: string): string {
	const url = new URL(ETRADE_AUTHORIZE_URL);
	url.searchParams.set('key', configuration.consumerKey);
	url.searchParams.set('token', requestToken);
	return url.toString();
}

async function readLimitedResponse(response: Response): Promise<string> {
	const declaredLength = Number(response.headers.get('content-length') ?? 0);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		throw new AppError('ETRADE_UNAVAILABLE', 'E*TRADE returned an unexpected response.', 502);
	}
	const body = await response.text();
	if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
		throw new AppError('ETRADE_UNAVAILABLE', 'E*TRADE returned an unexpected response.', 502);
	}
	return body;
}

async function signedRequest(
	method: 'GET',
	requestUrl: string,
	configuration: EtradeConfiguration,
	authorization: {
		token?: string;
		tokenSecret?: string;
		callback?: string;
		verifier?: string;
	} = {}
): Promise<{ response: Response; body: string }> {
	let response: Response;
	try {
		response = await etradeFetch(requestUrl, {
			method,
			headers: {
				accept: 'application/json',
				authorization: oauthAuthorizationHeader(method, requestUrl, {
					consumerKey: configuration.consumerKey,
					consumerSecret: configuration.consumerSecret,
					...authorization
				})
			},
			redirect: 'error',
			signal: AbortSignal.timeout(15_000)
		});
	} catch {
		throw new AppError('ETRADE_UNAVAILABLE', 'E*TRADE could not complete the request.', 502);
	}
	const body = await readLimitedResponse(response);
	return { response, body };
}

function tokenFromResponse(body: string): { token: string; secret: string } {
	const values = new URLSearchParams(body);
	const token = values.get('oauth_token') ?? '';
	const secret = values.get('oauth_token_secret') ?? '';
	const includesControlCharacter = [...(token + secret)].some((character) => {
		const code = character.charCodeAt(0);
		return code < 0x20 || code === 0x7f;
	});
	if (
		token.length < 4 ||
		token.length > 1024 ||
		secret.length < 4 ||
		secret.length > 1024 ||
		includesControlCharacter
	) {
		throw new AppError('ETRADE_UNAVAILABLE', 'E*TRADE returned an unexpected response.', 502);
	}
	return { token, secret };
}

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function field(record: JsonRecord | null, ...names: string[]): unknown {
	for (const name of names) {
		if (record && Object.hasOwn(record, name)) return record[name];
	}
	return undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function safeText(value: unknown, maximum: number, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : fallback;
}

function safeIdentifier(value: unknown): string {
	if (typeof value === 'string') return safeText(value, 64);
	return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
}

function safeNumber(value: unknown, fallback = 0): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) && Math.abs(parsed) <= 1_000_000_000_000 ? parsed : fallback;
}

function priceMicros(value: unknown): number | null {
	const parsed = safeNumber(value, Number.NaN);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	const micros = Math.round(parsed * 1_000_000);
	return Number.isSafeInteger(micros) ? micros : null;
}

function epochTimestamp(value: unknown): string | null {
	const parsed = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	const date = new Date(parsed > 10_000_000_000 ? parsed : parsed * 1000);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function transactionDate(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
		const american = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
		if (american) return `${american[3]}-${american[1]}-${american[2]}`;
	}
	const timestamp = epochTimestamp(value);
	return timestamp?.slice(0, 10) ?? null;
}

function parseJson(body: string): JsonRecord {
	if (!body.trim()) return {};
	try {
		return asRecord(JSON.parse(body)) ?? {};
	} catch {
		throw new AppError('ETRADE_UNAVAILABLE', 'E*TRADE returned an unexpected response.', 502);
	}
}

function parseAccounts(body: string): EtradeAccount[] {
	const root = parseJson(body);
	const response = asRecord(field(root, 'AccountListResponse', 'accountListResponse'));
	const accounts = asRecord(field(response, 'Accounts', 'accounts'));
	return asArray(field(accounts, 'Account', 'account')).flatMap((value) => {
		const account = asRecord(value);
		const accountId = safeText(field(account, 'accountId', 'AccountId'), 64);
		const accountIdKey = safeText(field(account, 'accountIdKey', 'AccountIdKey'), 256);
		if (!accountId || !accountIdKey) return [];
		return [
			{
				accountId,
				accountIdKey,
				accountName: safeText(field(account, 'accountName', 'AccountName'), 160),
				accountStatus: safeText(field(account, 'accountStatus', 'AccountStatus'), 32),
				institutionType: safeText(field(account, 'institutionType', 'InstitutionType'), 32)
			}
		];
	});
}

function parseOrders(body: string, financialAccountId: string): BrokerageOrder[] {
	const root = parseJson(body);
	const response = asRecord(field(root, 'OrdersResponse', 'ordersResponse'));
	const orders = asArray(field(response, 'Order', 'order'));
	const parsed: BrokerageOrder[] = [];
	for (const rawOrder of orders) {
		const order = asRecord(rawOrder);
		const orderId = safeIdentifier(field(order, 'orderId', 'OrderId'));
		for (const [detailIndex, rawDetail] of asArray(
			field(order, 'orderDetail', 'OrderDetail')
		).entries()) {
			const detail = asRecord(rawDetail);
			for (const [instrumentIndex, rawInstrument] of asArray(
				field(detail, 'instrument', 'Instrument')
			).entries()) {
				const instrument = asRecord(rawInstrument);
				const product = asRecord(field(instrument, 'Product', 'product'));
				const symbol = safeText(field(product, 'symbol', 'Symbol'), 32, 'Security');
				parsed.push({
					id: privateUuid(
						`${orderId || 'order'}:${detailIndex}:${instrumentIndex}`,
						`etrade-order:${financialAccountId}`
					),
					provider: 'etrade',
					symbol,
					description:
						safeText(field(instrument, 'symbolDescription', 'SymbolDescription'), 160) || null,
					action: safeText(field(instrument, 'orderAction', 'OrderAction'), 32, 'ORDER'),
					quantity: safeNumber(
						field(instrument, 'orderedQuantity', 'OrderedQuantity', 'quantity', 'Quantity')
					),
					filledQuantity: safeNumber(field(instrument, 'filledQuantity', 'FilledQuantity')),
					status: safeText(field(detail, 'status', 'Status'), 32, 'OPEN'),
					priceType: safeText(field(detail, 'priceType', 'PriceType'), 48, 'MARKET'),
					limitPriceMicros: priceMicros(field(detail, 'limitPrice', 'LimitPrice')),
					stopPriceMicros: priceMicros(field(detail, 'stopPrice', 'StopPrice')),
					term: safeText(field(detail, 'orderTerm', 'OrderTerm'), 48, 'GOOD_FOR_DAY'),
					marketSession: safeText(field(detail, 'marketSession', 'MarketSession'), 32, 'REGULAR'),
					placedAt: epochTimestamp(field(detail, 'placedTime', 'PlacedTime'))
				});
			}
		}
	}
	return parsed.slice(0, 500);
}

function parsePortfolio(body: string): EtradePortfolio {
	const root = parseJson(body);
	const response = asRecord(field(root, 'PortfolioResponse', 'portfolioResponse'));
	const portfolios = asArray(field(response, 'AccountPortfolio', 'accountPortfolio'));
	const positions: EtradePosition[] = [];
	const responseTotals = asRecord(field(response, 'totals', 'Totals'));
	let cashBalance = safeNumber(field(responseTotals, 'cashBalance', 'CashBalance'));
	let foundAccountCashBalance = false;
	for (const rawPortfolio of portfolios) {
		const portfolio = asRecord(rawPortfolio);
		const totals = asRecord(field(portfolio, 'totals', 'Totals'));
		const accountCashBalance = field(totals, 'cashBalance', 'CashBalance');
		if (accountCashBalance !== undefined) {
			if (!foundAccountCashBalance) cashBalance = 0;
			cashBalance += safeNumber(accountCashBalance);
			foundAccountCashBalance = true;
		}
		for (const rawPosition of asArray(field(portfolio, 'Position', 'position'))) {
			const position = asRecord(rawPosition);
			const product = asRecord(field(position, 'Product', 'product'));
			const symbol = safeText(field(product, 'symbol', 'Symbol'), 32);
			if (!symbol) continue;
			positions.push({
				symbol,
				securityType: safeText(field(product, 'securityType', 'SecurityType'), 32),
				quantity: safeNumber(field(position, 'quantity', 'Quantity')),
				marketValue: safeNumber(field(position, 'marketValue', 'MarketValue'))
			});
		}
	}
	const portfolioPages = portfolios.map((value) =>
		safeNumber(field(asRecord(value), 'totalPages', 'TotalPages'), 1)
	);
	const totalPages = Math.max(
		1,
		Math.trunc(safeNumber(field(response, 'totalPages', 'TotalPages'), 1)),
		...portfolioPages.map((value) => Math.trunc(value))
	);
	return { positions: positions.slice(0, 500), cashBalance, totalPages };
}

function parseTransactions(body: string): {
	transactions: EtradeTransaction[];
	marker: string | null;
} {
	const root = parseJson(body);
	const response = asRecord(field(root, 'TransactionListResponse', 'transactionListResponse'));
	const transactions = asArray(field(response, 'Transaction', 'transaction')).flatMap(
		(rawTransaction) => {
			const transaction = asRecord(rawTransaction);
			const brokerage = asRecord(field(transaction, 'brokerage', 'Brokerage'));
			const product = asRecord(field(brokerage, 'product', 'Product'));
			const date = transactionDate(
				field(transaction, 'transactionDate', 'TransactionDate', 'postDate', 'PostDate')
			);
			if (!date) return [];
			const symbol = safeText(field(product, 'symbol', 'Symbol'), 32) || null;
			return [
				{
					date,
					amount: safeNumber(field(transaction, 'amount', 'Amount')),
					transactionType: safeText(
						field(transaction, 'transactionType', 'TransactionType'),
						64,
						'Other'
					),
					symbol,
					securityType: safeText(field(product, 'securityType', 'SecurityType'), 32),
					quantity: safeNumber(field(brokerage, 'quantity', 'Quantity'))
				}
			];
		}
	);
	return {
		transactions: transactions.slice(0, 2_000),
		marker: safeText(field(response, 'marker', 'Marker'), 512) || null
	};
}

async function requestJsonWithAccess(
	requestUrl: string,
	configuration: EtradeConfiguration,
	authorization: Extract<EtradeAuthorization, { state: 'connected' }>,
	retryAfterRenewal = true
): Promise<string> {
	const result = await signedRequest('GET', requestUrl, configuration, {
		token: authorization.accessToken,
		tokenSecret: authorization.accessTokenSecret
	});
	if (result.response.ok) return result.body;
	if (retryAfterRenewal && [401, 403].includes(result.response.status)) {
		const renewal = await signedRequest(
			'GET',
			`${ETRADE_API_ORIGIN}/oauth/renew_access_token`,
			configuration,
			{
				token: authorization.accessToken,
				tokenSecret: authorization.accessTokenSecret
			}
		);
		if (renewal.response.ok) {
			return requestJsonWithAccess(requestUrl, configuration, authorization, false);
		}
		await saveEtradeAuthorization({ state: 'disconnected' });
		throw new AppError(
			'ETRADE_RECONNECT_REQUIRED',
			'Reconnect E*TRADE to load today’s account data.',
			409
		);
	}
	throw new EtradeHttpError(result.response.status);
}

async function loadEtradePortfolio(
	account: EtradeAccount,
	configuration: EtradeConfiguration,
	authorization: Extract<EtradeAuthorization, { state: 'connected' }>
): Promise<EtradePortfolio> {
	const loadPage = async (pageNumber: number): Promise<EtradePortfolio> => {
		const url = new URL(
			`${ETRADE_API_ORIGIN}/v1/accounts/${encodeURIComponent(account.accountIdKey)}/portfolio.json`
		);
		url.searchParams.set('view', 'COMPLETE');
		url.searchParams.set('totalsRequired', 'true');
		url.searchParams.set('lotsRequired', 'false');
		url.searchParams.set('count', '50');
		url.searchParams.set('pageNumber', String(pageNumber));
		return parsePortfolio(
			await requestJsonWithAccess(url.toString(), configuration, authorization)
		);
	};
	const first = await loadPage(1);
	const positions = [...first.positions];
	for (let page = 2; page <= Math.min(first.totalPages, 10); page += 1) {
		positions.push(...(await loadPage(page)).positions);
	}
	return { positions: positions.slice(0, 500), cashBalance: first.cashBalance, totalPages: 1 };
}

async function loadEtradeTransactions(
	account: EtradeAccount,
	configuration: EtradeConfiguration,
	authorization: Extract<EtradeAuthorization, { state: 'connected' }>,
	startDate: string,
	endDate: string
): Promise<EtradeTransaction[]> {
	const format = (date: string) => `${date.slice(5, 7)}${date.slice(8, 10)}${date.slice(0, 4)}`;
	const transactions: EtradeTransaction[] = [];
	let marker: string | null = null;
	for (let page = 0; page < 40; page += 1) {
		const url = new URL(
			`${ETRADE_API_ORIGIN}/v1/accounts/${encodeURIComponent(account.accountIdKey)}/transactions.json`
		);
		url.searchParams.set('startDate', format(startDate));
		url.searchParams.set('endDate', format(endDate));
		url.searchParams.set('sortOrder', 'DESC');
		url.searchParams.set('count', '50');
		if (marker) url.searchParams.set('marker', marker);
		const pageResult = parseTransactions(
			await requestJsonWithAccess(url.toString(), configuration, authorization)
		);
		transactions.push(...pageResult.transactions);
		if (!pageResult.marker || pageResult.marker === marker || transactions.length >= 2_000) break;
		marker = pageResult.marker;
	}
	return transactions.slice(0, 2_000);
}

async function listEtradeAccounts(
	configuration: EtradeConfiguration,
	authorization: Extract<EtradeAuthorization, { state: 'connected' }>
): Promise<EtradeAccount[]> {
	try {
		return parseAccounts(
			await requestJsonWithAccess(
				`${ETRADE_API_ORIGIN}/v1/accounts/list.json`,
				configuration,
				authorization
			)
		);
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError('ETRADE_UNAVAILABLE', 'E*TRADE could not load account details.', 502);
	}
}

function isEtradeAccount(account: FinancialAccount): boolean {
	return /(?:^|\b)e\s*\*?\s*trade(?:\b|$)/i.test(account.institution ?? '');
}

function selectEtradeAccount(
	financialAccount: FinancialAccount,
	accounts: EtradeAccount[]
): EtradeAccount | null {
	const activeBrokerageAccounts = accounts.filter(
		(account) =>
			account.accountStatus.toUpperCase() !== 'CLOSED' &&
			(!account.institutionType || account.institutionType.toUpperCase() === 'BROKERAGE')
	);
	if (financialAccount.last4) {
		const matches = activeBrokerageAccounts.filter((account) =>
			account.accountId.endsWith(financialAccount.last4 ?? '')
		);
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) {
			const named = matches.filter(
				(account) =>
					account.accountName.trim().toLowerCase() ===
					financialAccount.nickname.trim().toLowerCase()
			);
			if (named.length === 1) return named[0];
		}
	}
	return activeBrokerageAccounts.length === 1 ? activeBrokerageAccounts[0] : null;
}

export async function etradeStatus(): Promise<EtradePublicStatus> {
	const configuration = await getEtradeConfiguration();
	if (!configuration) {
		return {
			configured: false,
			authorization: 'not_configured',
			accountCount: 0,
			authorizedAt: null,
			authorizationUrl: null
		};
	}
	const authorization = await getEtradeAuthorization();
	if (authorization.state === 'pending' && pendingAuthorizationIsCurrent(authorization)) {
		return {
			configured: true,
			authorization: 'pending',
			accountCount: 0,
			authorizedAt: null,
			authorizationUrl: authorizationUrl(configuration, authorization.requestToken)
		};
	}
	if (authorization.state === 'connected' && connectedAuthorizationIsCurrent(authorization)) {
		return {
			configured: true,
			authorization: 'connected',
			accountCount: authorization.accountCount,
			authorizedAt: authorization.authorizedAt,
			authorizationUrl: null
		};
	}
	return {
		configured: true,
		authorization: authorization.state === 'connected' ? 'expired' : 'disconnected',
		accountCount: authorization.state === 'connected' ? authorization.accountCount : 0,
		authorizedAt: authorization.state === 'connected' ? authorization.authorizedAt : null,
		authorizationUrl: null
	};
}

export async function configureEtrade(consumerKey: string, consumerSecret: string): Promise<void> {
	await saveEtradeConfiguration(consumerKey, consumerSecret);
}

export async function beginEtradeAuthorization(): Promise<EtradePublicStatus> {
	const configuration = await getEtradeConfiguration();
	if (!configuration) {
		throw new AppError('ETRADE_NOT_CONFIGURED', 'Enter your E*TRADE API credentials first.', 409);
	}
	const result = await signedRequest(
		'GET',
		`${ETRADE_API_ORIGIN}/oauth/request_token`,
		configuration,
		{ callback: 'oob' }
	);
	if (!result.response.ok) {
		throw new AppError('ETRADE_CREDENTIALS_REJECTED', 'E*TRADE rejected the API credentials.', 400);
	}
	const token = tokenFromResponse(result.body);
	await saveEtradeAuthorization({
		state: 'pending',
		requestToken: token.token,
		requestTokenSecret: token.secret,
		createdAt: new Date().toISOString()
	});
	return etradeStatus();
}

export async function completeEtradeAuthorization(verifier: string): Promise<EtradePublicStatus> {
	const configuration = await getEtradeConfiguration();
	const authorization = await getEtradeAuthorization();
	if (!configuration) {
		throw new AppError('ETRADE_NOT_CONFIGURED', 'Enter your E*TRADE API credentials first.', 409);
	}
	if (authorization.state !== 'pending' || !pendingAuthorizationIsCurrent(authorization)) {
		await saveEtradeAuthorization({ state: 'disconnected' });
		throw new AppError(
			'ETRADE_AUTHORIZATION_EXPIRED',
			'Start E*TRADE authorization again; its code is valid for five minutes.',
			409
		);
	}
	const result = await signedRequest(
		'GET',
		`${ETRADE_API_ORIGIN}/oauth/access_token`,
		configuration,
		{
			token: authorization.requestToken,
			tokenSecret: authorization.requestTokenSecret,
			verifier
		}
	);
	if (!result.response.ok) {
		throw new AppError(
			'ETRADE_AUTHORIZATION_REJECTED',
			'E*TRADE could not confirm that verification code.',
			400
		);
	}
	const token = tokenFromResponse(result.body);
	const connected: Extract<EtradeAuthorization, { state: 'connected' }> = {
		state: 'connected',
		accessToken: token.token,
		accessTokenSecret: token.secret,
		authorizedAt: new Date().toISOString(),
		authorizedEasternDay: easternDay(),
		accountCount: 0
	};
	await saveEtradeAuthorization(connected);
	try {
		const accounts = await listEtradeAccounts(configuration, connected);
		connected.accountCount = accounts.length;
		await saveEtradeAuthorization(connected);
	} catch {
		// The authorization itself succeeded. Account discovery can be retried when orders load.
		if ((await getEtradeAuthorization()).state !== 'connected') {
			throw new AppError(
				'ETRADE_AUTHORIZATION_REJECTED',
				'E*TRADE authorized the request but did not accept the resulting access token.',
				400
			);
		}
	}
	return etradeStatus();
}

export async function disconnectEtrade(): Promise<{ revoked: boolean }> {
	const [configuration, authorization] = await Promise.all([
		getEtradeConfiguration(),
		getEtradeAuthorization()
	]);
	let revoked = false;
	if (
		configuration &&
		authorization.state === 'connected' &&
		connectedAuthorizationIsCurrent(authorization)
	) {
		try {
			const result = await signedRequest(
				'GET',
				`${ETRADE_API_ORIGIN}/oauth/revoke_access_token`,
				configuration,
				{
					token: authorization.accessToken,
					tokenSecret: authorization.accessTokenSecret
				}
			);
			revoked = result.response.ok;
		} catch {
			// Local access is forgotten even when E*TRADE is temporarily unavailable.
		}
	}
	await saveEtradeAuthorization({ state: 'disconnected' });
	return { revoked };
}

export async function forgetEtradeConfiguration(): Promise<void> {
	await disconnectEtrade();
	await removeEtradeConfiguration();
}

export async function listEtradeOpenOrders(
	financialAccountId: string
): Promise<BrokerageOrdersResponse> {
	const financialAccount = await getFinancialAccount(financialAccountId);
	if (financialAccount.accountType !== 'brokerage' || !isEtradeAccount(financialAccount)) {
		return {
			availability: 'account_not_found',
			provider: 'etrade',
			orders: [],
			refreshedAt: null
		};
	}
	const configuration = await getEtradeConfiguration();
	if (!configuration) {
		return {
			availability: 'not_configured',
			provider: 'etrade',
			orders: [],
			refreshedAt: null
		};
	}
	const authorization = await getEtradeAuthorization();
	if (authorization.state !== 'connected' || !connectedAuthorizationIsCurrent(authorization)) {
		return {
			availability: 'authorization_required',
			provider: 'etrade',
			orders: [],
			refreshedAt: null
		};
	}
	const account = selectEtradeAccount(
		financialAccount,
		await listEtradeAccounts(configuration, authorization)
	);
	if (!account) {
		return {
			availability: 'account_not_found',
			provider: 'etrade',
			orders: [],
			refreshedAt: null
		};
	}
	let body: string;
	try {
		const url = new URL(
			`${ETRADE_API_ORIGIN}/v1/accounts/${encodeURIComponent(account.accountIdKey)}/orders.json`
		);
		url.searchParams.set('status', 'OPEN');
		url.searchParams.set('count', '100');
		body = await requestJsonWithAccess(url.toString(), configuration, authorization);
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError('ETRADE_UNAVAILABLE', 'E*TRADE could not load open orders.', 502);
	}
	return {
		availability: 'available',
		provider: 'etrade',
		orders: parseOrders(body, financialAccount.id),
		refreshedAt: new Date().toISOString()
	};
}

export async function rebuildEtradeBrokerageHistory(
	financialAccountId: string
): Promise<BrokerageHistoryEstimateResponse> {
	const financialAccount = await getFinancialAccount(financialAccountId);
	const unavailable = (
		availability: BrokerageHistoryEstimateResponse['availability']
	): BrokerageHistoryEstimateResponse => ({
		availability,
		provider: 'etrade',
		account: null,
		estimatedPointCount: 0,
		startDate: null,
		endDate: null,
		unpricedSymbols: [],
		refreshedAt: null
	});
	if (financialAccount.accountType !== 'brokerage' || !isEtradeAccount(financialAccount)) {
		return unavailable('account_not_found');
	}
	const configuration = await getEtradeConfiguration();
	if (!configuration) return unavailable('not_configured');
	const authorization = await getEtradeAuthorization();
	if (authorization.state !== 'connected' || !connectedAuthorizationIsCurrent(authorization)) {
		return unavailable('authorization_required');
	}
	const account = selectEtradeAccount(
		financialAccount,
		await listEtradeAccounts(configuration, authorization)
	);
	if (!account) return unavailable('account_not_found');

	const end = new Date();
	end.setUTCHours(0, 0, 0, 0);
	end.setUTCDate(end.getUTCDate() - 1);
	const start = new Date(end);
	start.setUTCFullYear(start.getUTCFullYear() - 2);
	const startDate = start.toISOString().slice(0, 10);
	const endDate = end.toISOString().slice(0, 10);
	let portfolio: EtradePortfolio;
	let transactions: EtradeTransaction[];
	try {
		[portfolio, transactions] = await Promise.all([
			loadEtradePortfolio(account, configuration, authorization),
			loadEtradeTransactions(account, configuration, authorization, startDate, endDate)
		]);
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError(
			'ETRADE_UNAVAILABLE',
			'E*TRADE could not load the portfolio history inputs.',
			502
		);
	}
	const symbols = [
		...portfolio.positions.map((position) => position.symbol),
		...transactions.flatMap((transaction) => (transaction.symbol ? [transaction.symbol] : []))
	];
	const prices = await historicalCloseSeries(symbols, startDate, endDate);
	const estimate = reconstructBrokerageHistory(
		financialAccount,
		portfolio.positions,
		portfolio.cashBalance,
		transactions,
		prices,
		startDate,
		endDate
	);
	if (estimate.points.length === 0) {
		throw new AppError(
			'MARKET_HISTORY_UNAVAILABLE',
			'Historical closing prices are temporarily unavailable for this portfolio.',
			502
		);
	}
	const updatedAccount = await replaceEstimatedFinancialAccountHistory(
		financialAccount.id,
		estimate.points,
		{ latestObservedNetContributionsCents: estimate.currentNetContributionsCents }
	);
	return {
		availability: 'available',
		provider: 'etrade',
		account: updatedAccount,
		estimatedPointCount: updatedAccount.balanceHistory.filter(
			(point) => point.source === 'estimated'
		).length,
		startDate,
		endDate,
		unpricedSymbols: estimate.unpricedSymbols,
		refreshedAt: new Date().toISOString()
	};
}

export function setEtradeFetchForTests(value?: EtradeFetch): void {
	etradeFetch = value ?? fetch;
}

export const etradeTestHelpers = {
	easternDay,
	parseAccounts,
	parseOrders,
	parsePortfolio,
	parseTransactions,
	selectEtradeAccount
};
