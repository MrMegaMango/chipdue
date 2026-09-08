import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests, getDatabase } from './database';
import {
	activateMethodCreditScoreConnection,
	getMethodConfiguration,
	methodCreditScoreStatus,
	startMethodCreditScoreOnboarding,
	syncMethodCreditScores
} from './method-credit-score';
import { getMethodCreditScoreState } from './method-credit-score-store';
import { listCreditScores } from './credit-scores';

describe.sequential('Method automatic credit scores', () => {
	let temporaryDirectory: string;
	let previousDataDirectory: string | undefined;
	let previousApiKey: string | undefined;
	let previousEnvironment: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		previousApiKey = process.env.METHOD_API_KEY;
		previousEnvironment = process.env.METHOD_ENV;
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-method-scores-'));
		process.env.CARDDUE_DATA_DIR = temporaryDirectory;
		process.env.METHOD_API_KEY = 'sk_test_automatic_score_key_123456';
		process.env.METHOD_ENV = 'development';
		closeDatabaseForTests();
		resetCryptoStateForTests();
	});

	afterEach(() => {
		closeDatabaseForTests();
		resetCryptoStateForTests();
		if (previousDataDirectory === undefined) delete process.env.CARDDUE_DATA_DIR;
		else process.env.CARDDUE_DATA_DIR = previousDataDirectory;
		if (previousApiKey === undefined) delete process.env.METHOD_API_KEY;
		else process.env.METHOD_API_KEY = previousApiKey;
		if (previousEnvironment === undefined) delete process.env.METHOD_ENV;
		else process.env.METHOD_ENV = previousEnvironment;
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('stays disabled until server credentials are configured', async () => {
		delete process.env.METHOD_API_KEY;

		expect(getMethodConfiguration()).toBeNull();
		expect(await methodCreditScoreStatus()).toMatchObject({
			state: 'not_configured',
			lastSyncedAt: null
		});
	});

	it('verifies identity, enrolls monitoring, and imports encrypted scores', async () => {
		const requests: Array<{ path: string; method: string; body: unknown; headers: Headers }> = [];
		const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
			const method = init?.method ?? 'GET';
			const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
			const headers = new Headers(init?.headers);
			requests.push({ path: url.pathname, method, body, headers });

			if (url.pathname === '/entities' && method === 'POST') {
				return Response.json({ data: { id: 'ent_example123', status: 'pending' } });
			}
			if (url.pathname === '/opal/token' && method === 'POST') {
				return Response.json({
					data: { token: 'otkn_example123', session_id: 'osess_example123' }
				});
			}
			if (url.pathname === '/entities/ent_example123' && method === 'GET') {
				return Response.json({ data: { id: 'ent_example123', status: 'active' } });
			}
			if (url.pathname.endsWith('/subscriptions') && method === 'GET') {
				return Response.json({ data: {} });
			}
			if (url.pathname.endsWith('/subscriptions') && method === 'POST') {
				return Response.json({
					data: { id: 'sub_example123', name: 'credit_score', status: 'active' }
				});
			}
			if (url.pathname.endsWith('/credit_scores') && method === 'POST') {
				return Response.json({
					data: {
						id: 'crs_example123',
						entity_id: 'ent_example123',
						status: 'pending',
						scores: null
					}
				});
			}
			if (url.pathname.endsWith('/credit_scores') && method === 'GET') {
				return Response.json({
					success: true,
					data: [
						{
							id: 'crs_example123',
							entity_id: 'ent_example123',
							status: 'completed',
							scores: [
								{
									score: 734,
									source: 'equifax',
									model: 'vantage_4',
									factors: [
										{
											code: '00034',
											description: 'Revolving balances are too high'
										}
									],
									created_at: '2026-09-08T15:30:00.000Z'
								}
							]
						}
					]
				});
			}
			return Response.json({ message: 'Unexpected request' }, { status: 500 });
		});

		const session = await startMethodCreditScoreOnboarding(
			{ firstName: 'Test', lastName: 'Person', phone: '+14155550123' },
			fetcher
		);
		expect(session).toEqual({
			token: 'otkn_example123',
			sessionId: 'osess_example123',
			opalUrl: 'https://opal.dev.methodfi.com?token=otkn_example123',
			opalOrigin: 'https://opal.dev.methodfi.com'
		});
		expect(await getMethodCreditScoreState()).toMatchObject({
			state: 'onboarding',
			entityId: 'ent_example123'
		});

		await activateMethodCreditScoreConnection(fetcher);
		expect(await getMethodCreditScoreState()).toMatchObject({
			state: 'connected',
			subscriptionId: 'sub_example123',
			pendingRequestId: 'crs_example123'
		});

		await expect(syncMethodCreditScores(fetcher)).resolves.toMatchObject({
			imported: 1,
			newestRecordedDate: '2026-09-08'
		});
		expect(await listCreditScores()).toMatchObject([
			{
				score: 734,
				bureau: 'equifax',
				model: 'VantageScore 4.0',
				source: 'Method',
				origin: 'automatic',
				factors: [{ code: '00034', description: 'Revolving balances are too high' }]
			}
		]);
		expect(await methodCreditScoreStatus()).toMatchObject({
			state: 'connected',
			environment: 'development',
			lastSyncedAt: expect.any(String)
		});

		expect(requests[0]).toMatchObject({
			path: '/entities',
			method: 'POST',
			body: {
				type: 'individual',
				individual: {
					first_name: 'Test',
					last_name: 'Person',
					phone: '+14155550123'
				}
			}
		});
		expect(
			requests.every((request) => request.headers.get('Method-Version') === '2026-03-30')
		).toBe(true);
		expect(
			requests.every(
				(request) =>
					request.headers.get('authorization') === 'Bearer sk_test_automatic_score_key_123456'
			)
		).toBe(true);
		expect(JSON.stringify(getDatabase().prepare('SELECT value FROM metadata').all())).not.toContain(
			'ent_example123'
		);
		expect(
			JSON.stringify(getDatabase().prepare('SELECT payload_enc FROM cards').all())
		).not.toContain('Revolving balances are too high');
	});
});
