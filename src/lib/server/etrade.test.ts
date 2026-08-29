import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FinancialAccount } from '$lib/types';
import { resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests } from './database';
import {
	beginEtradeAuthorization,
	completeEtradeAuthorization,
	configureEtrade,
	etradeStatus,
	etradeTestHelpers,
	oauthAuthorizationHeader,
	setEtradeFetchForTests
} from './etrade';
import {
	getEtradeAuthorization,
	getEtradeConfiguration,
	saveEtradeAuthorization
} from './etrade-store';
import { runAsTenant } from './tenant';

const FIRST_TENANT = '10000000-0000-4000-8000-000000000001';
const SECOND_TENANT = '20000000-0000-4000-8000-000000000002';

describe.sequential('E*TRADE read-only integration', () => {
	let dataDirectory: string;
	let previousDataDirectory: string | undefined;
	let previousMode: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		previousMode = process.env.CARDDUE_MODE;
		dataDirectory = mkdtempSync(join(tmpdir(), 'carddue-etrade-test-'));
		process.env.CARDDUE_DATA_DIR = dataDirectory;
		process.env.CARDDUE_MODE = 'local';
		resetCryptoStateForTests();
		closeDatabaseForTests();
		setEtradeFetchForTests();
	});

	afterEach(() => {
		setEtradeFetchForTests();
		closeDatabaseForTests();
		resetCryptoStateForTests();
		rmSync(dataDirectory, { recursive: true, force: true });
		if (previousDataDirectory === undefined) delete process.env.CARDDUE_DATA_DIR;
		else process.env.CARDDUE_DATA_DIR = previousDataDirectory;
		if (previousMode === undefined) delete process.env.CARDDUE_MODE;
		else process.env.CARDDUE_MODE = previousMode;
	});

	it('signs OAuth requests deterministically without exposing the consumer secret', () => {
		const header = oauthAuthorizationHeader(
			'GET',
			'https://api.etrade.com/v1/accounts/account-key/orders.json?status=OPEN&count=100',
			{
				consumerKey: 'synthetic-consumer-key',
				consumerSecret: 'synthetic-consumer-secret',
				token: 'synthetic-access-token',
				tokenSecret: 'synthetic-access-secret',
				nonce: 'fixed-nonce',
				timestamp: 1_700_000_000
			}
		);

		expect(header).toContain('oauth_consumer_key="synthetic-consumer-key"');
		expect(header).toContain('oauth_nonce="fixed-nonce"');
		expect(header).toContain('oauth_signature="4n0e59fJ8o%2FQK%2BU4oCY0snH87bY%3D"');
		expect(header).not.toContain('synthetic-consumer-secret');
		expect(header).not.toContain('synthetic-access-secret');
	});

	it('encrypts credentials and completes the five-minute authorization flow', async () => {
		const observedHeaders: string[] = [];
		setEtradeFetchForTests(async (input, init) => {
			const url = String(input);
			observedHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
			if (url.endsWith('/oauth/request_token')) {
				return new Response(
					'oauth_token=request-token&oauth_token_secret=request-token-secret&oauth_callback_confirmed=false'
				);
			}
			if (url.endsWith('/oauth/access_token')) {
				return new Response('oauth_token=access-token&oauth_token_secret=access-token-secret');
			}
			if (url.endsWith('/v1/accounts/list.json')) {
				return Response.json({
					AccountListResponse: {
						Accounts: {
							Account: [
								{
									accountId: '10001234',
									accountIdKey: 'account-key',
									accountName: 'Individual Brokerage',
									accountStatus: 'ACTIVE',
									institutionType: 'BROKERAGE'
								}
							]
						}
					}
				});
			}
			throw new Error(`Unexpected URL: ${url}`);
		});

		await configureEtrade('synthetic-key', 'synthetic-secret');
		const pending = await beginEtradeAuthorization();
		expect(pending.authorization).toBe('pending');
		expect(pending.authorizationUrl).toContain('us.etrade.com/e/t/etws/authorize');

		const connected = await completeEtradeAuthorization('VERIFY1');
		expect(connected).toMatchObject({
			configured: true,
			authorization: 'connected',
			accountCount: 1
		});
		expect(observedHeaders[0]).toContain('oauth_callback="oob"');
		expect(observedHeaders.join('\n')).not.toContain('synthetic-secret');

		const database = readFileSync(join(dataDirectory, 'carddue.sqlite3'));
		expect(database.includes(Buffer.from('synthetic-key'))).toBe(false);
		expect(database.includes(Buffer.from('synthetic-secret'))).toBe(false);
		expect(database.includes(Buffer.from('access-token-secret'))).toBe(false);
	});

	it('marks a prior Eastern calendar-day token as expired', async () => {
		await configureEtrade('synthetic-key', 'synthetic-secret');
		await saveEtradeAuthorization({
			state: 'connected',
			accessToken: 'access-token',
			accessTokenSecret: 'access-token-secret',
			authorizedAt: '2000-01-01T12:00:00.000Z',
			authorizedEasternDay: '2000-01-01',
			accountCount: 2
		});

		expect(await etradeStatus()).toMatchObject({
			configured: true,
			authorization: 'expired',
			accountCount: 2
		});
	});

	it('isolates encrypted credentials and authorization by tenant', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			await configureEtrade('first-synthetic-key', 'first-synthetic-secret');
			await saveEtradeAuthorization({
				state: 'connected',
				accessToken: 'first-access-token',
				accessTokenSecret: 'first-access-secret',
				authorizedAt: new Date().toISOString(),
				authorizedEasternDay: etradeTestHelpers.easternDay(),
				accountCount: 1
			});
		});

		await expect(runAsTenant(SECOND_TENANT, () => getEtradeConfiguration())).resolves.toBeNull();
		await expect(runAsTenant(SECOND_TENANT, () => getEtradeAuthorization())).resolves.toEqual({
			state: 'disconnected'
		});
		await expect(runAsTenant(FIRST_TENANT, () => getEtradeConfiguration())).resolves.toEqual({
			consumerKey: 'first-synthetic-key',
			consumerSecret: 'first-synthetic-secret'
		});
	});

	it('maps only allowlisted open-order fields and matches by last four', () => {
		const accounts = etradeTestHelpers.parseAccounts(
			JSON.stringify({
				AccountListResponse: {
					Accounts: {
						Account: [
							{
								accountId: '10001234',
								accountIdKey: 'account-key',
								accountName: 'Brokerage',
								accountStatus: 'ACTIVE',
								institutionType: 'BROKERAGE'
							}
						]
					}
				}
			})
		);
		const matched = etradeTestHelpers.selectEtradeAccount(
			{ last4: '1234', nickname: 'Brokerage' } as FinancialAccount,
			accounts
		);
		expect(matched?.accountIdKey).toBe('account-key');

		const orders = etradeTestHelpers.parseOrders(
			JSON.stringify({
				OrdersResponse: {
					Order: [
						{
							orderId: 42,
							orderDetail: [
								{
									status: 'OPEN',
									priceType: 'LIMIT',
									limitPrice: 123.45,
									orderTerm: 'GOOD_FOR_DAY',
									marketSession: 'REGULAR',
									placedTime: 1_700_000_000_000,
									instrument: [
										{
											Product: { symbol: 'SYN' },
											symbolDescription: 'Synthetic Corp',
											orderAction: 'BUY',
											orderedQuantity: 5,
											filledQuantity: 1
										}
									]
								}
							]
						}
					]
				}
			}),
			'00000000-0000-4000-8000-000000000002'
		);

		expect(orders).toHaveLength(1);
		expect(orders[0]).toMatchObject({
			provider: 'etrade',
			symbol: 'SYN',
			description: 'Synthetic Corp',
			action: 'BUY',
			quantity: 5,
			filledQuantity: 1,
			status: 'OPEN',
			priceType: 'LIMIT',
			limitPriceMicros: 123_450_000,
			term: 'GOOD_FOR_DAY',
			marketSession: 'REGULAR',
			placedAt: '2023-11-14T22:13:20.000Z'
		});
		expect(orders[0]).not.toHaveProperty('accountId');
		expect(orders[0]).not.toHaveProperty('orderId');

		const secondOrder = etradeTestHelpers.parseOrders(
			JSON.stringify({
				OrdersResponse: {
					Order: [
						{ orderId: 42, orderDetail: [{ instrument: [{ Product: { symbol: 'ONE' } }] }] },
						{ orderId: 43, orderDetail: [{ instrument: [{ Product: { symbol: 'TWO' } }] }] }
					]
				}
			}),
			'00000000-0000-4000-8000-000000000002'
		);
		expect(new Set(secondOrder.map((order) => order.id)).size).toBe(2);
	});
});
