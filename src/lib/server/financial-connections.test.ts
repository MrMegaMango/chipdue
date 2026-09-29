import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialConnection } from '$lib/types';
import { POST as syncConnection } from '../../routes/api/connections/[id]/sync/+server';
import { POST as syncConnectionTransactions } from '../../routes/api/connections/[id]/transactions/sync/+server';
import { POST as syncTransactions } from '../../routes/api/connections/transactions/sync/+server';
import { AppError } from './errors';

const connectionMocks = vi.hoisted(() => ({
	listPlaidConnections: vi.fn(),
	syncPlaidItem: vi.fn(),
	plaidConfigurationStatus: vi.fn(),
	syncAllPlaidItems: vi.fn(),
	disconnectPlaidItem: vi.fn()
}));

vi.mock('./plaid-store', () => ({
	listPlaidConnections: connectionMocks.listPlaidConnections
}));

vi.mock('./plaid-config', () => ({
	isInstallationPlaidConfigured: () => true
}));

vi.mock('./plaid', () => ({
	disconnectPlaidItem: connectionMocks.disconnectPlaidItem,
	plaidConfigurationStatus: connectionMocks.plaidConfigurationStatus,
	syncAllPlaidItems: connectionMocks.syncAllPlaidItems,
	syncPlaidItem: connectionMocks.syncPlaidItem
}));

import {
	syncAllTenantFinancialConnections,
	syncCurrentTenantFinancialConnections,
	syncFinancialConnection
} from './financial-connections';

function connection(id: string, institutionName: string | null): FinancialConnection {
	return {
		id,
		provider: 'plaid',
		institutionName,
		status: 'healthy',
		lastSyncedAt: null,
		createdAt: '2026-08-31T12:00:00.000Z'
	};
}

function syncResult() {
	return {
		syncedAt: '2026-08-31T12:30:00.000Z',
		count: 1,
		accountCount: 2,
		transactionCount: 3
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe('current-tenant financial connection sync', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.stubEnv('CARDDUE_MODE', 'local');
		vi.stubEnv('DATABASE_URL', '');
		vi.stubEnv('VERCEL', '');
		connectionMocks.plaidConfigurationStatus.mockResolvedValue({ configured: true });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('waits for healthy connections and reports a failed institution after skipped connections', async () => {
		const connections = [
			{ ...connection('paused', 'Paused Bank'), syncPaused: true },
			connection('amex', 'American Express'),
			connection('chase', 'Chase')
		];
		connectionMocks.listPlaidConnections.mockResolvedValue(connections);
		const healthySync = deferred<ReturnType<typeof syncResult>>();
		connectionMocks.syncPlaidItem.mockImplementation(async (id: string) => {
			if (id === 'chase') {
				throw new AppError('PLAID_LOGIN_REQUIRED', 'This connection needs to be updated.', 409);
			}
			return healthySync.promise;
		});
		let complete = false;
		const resultPromise = syncCurrentTenantFinancialConnections().finally(() => {
			complete = true;
		});

		await vi.waitFor(() => expect(connectionMocks.syncPlaidItem).toHaveBeenCalledTimes(2));
		expect(complete).toBe(false);
		healthySync.resolve(syncResult());
		await expect(resultPromise).resolves.toEqual({
			syncedConnections: 1,
			failedConnections: 1,
			skippedConnections: 1,
			cardCount: 1,
			accountCount: 2,
			transactionCount: 3,
			lastSyncedAt: '2026-08-31T12:30:00.000Z',
			failures: [
				{
					connectionId: 'chase',
					institutionName: 'Chase',
					code: 'PLAID_LOGIN_REQUIRED',
					message: 'This connection needs to be updated.'
				}
			]
		});
		expect(connectionMocks.syncPlaidItem.mock.calls.map(([id]) => id)).toEqual(['amex', 'chase']);
		expect(connectionMocks.listPlaidConnections).toHaveBeenCalledTimes(1);
	});

	it('waits for every attempt before throwing the first sanitized failure when all fail', async () => {
		connectionMocks.listPlaidConnections.mockResolvedValue([
			connection('chase', 'Chase'),
			connection('other', 'Other Bank')
		]);
		const laterSync = deferred<ReturnType<typeof syncResult>>();
		connectionMocks.syncPlaidItem.mockImplementation(async (id: string) => {
			if (id === 'chase') {
				throw new AppError('PLAID_LOGIN_REQUIRED', 'This connection needs to be updated.', 409);
			}
			return laterSync.promise;
		});
		let complete = false;
		const resultPromise = syncCurrentTenantFinancialConnections().catch((error: unknown) => {
			complete = true;
			return error;
		});

		await vi.waitFor(() => expect(connectionMocks.syncPlaidItem).toHaveBeenCalledTimes(2));
		expect(complete).toBe(false);
		laterSync.reject(new Error('Raw provider details must stay private'));
		await expect(resultPromise).resolves.toMatchObject({
			code: 'PLAID_LOGIN_REQUIRED',
			message: 'Sync failed for Chase: This connection needs to be updated.',
			status: 409
		});
	});

	it('sanitizes unknown failures in partial results', async () => {
		connectionMocks.listPlaidConnections.mockResolvedValue([
			connection('healthy', 'Healthy Bank'),
			connection('failed', 'Failed Bank')
		]);
		connectionMocks.syncPlaidItem.mockImplementation(async (id: string) => {
			if (id === 'failed') throw new Error('Raw provider token: example-private-value');
			return syncResult();
		});

		await expect(syncCurrentTenantFinancialConnections()).resolves.toMatchObject({
			syncedConnections: 1,
			failedConnections: 1,
			skippedConnections: 0,
			failures: [
				{
					connectionId: 'failed',
					institutionName: 'Failed Bank',
					code: 'INTERNAL_ERROR',
					message: 'The request could not be completed.'
				}
			]
		});
	});

	it('skips paused connections and connections awaiting repair without provider calls', async () => {
		connectionMocks.listPlaidConnections.mockResolvedValue([
			{ ...connection('paused', 'Paused Bank'), syncPaused: true },
			{ ...connection('repair', 'Repair Bank'), status: 'needs_update' }
		]);

		await expect(syncCurrentTenantFinancialConnections()).resolves.toEqual({
			syncedConnections: 0,
			failedConnections: 0,
			skippedConnections: 2,
			cardCount: 0,
			accountCount: 0,
			transactionCount: 0,
			lastSyncedAt: null,
			failures: []
		});
		expect(connectionMocks.syncPlaidItem).not.toHaveBeenCalled();
	});

	it('enables transaction sync only for connections currently eligible on the server', async () => {
		connectionMocks.listPlaidConnections.mockResolvedValue([
			{ ...connection('paused', 'Paused Bank'), syncPaused: true },
			{ ...connection('repair', 'Repair Bank'), status: 'needs_update' },
			connection('healthy', 'Healthy Bank')
		]);
		connectionMocks.syncPlaidItem.mockResolvedValue(syncResult());
		const request = new Request('http://localhost/api/connections/transactions/sync', {
			method: 'POST',
			headers: { origin: 'http://localhost' }
		});

		const response = (await syncTransactions({
			request,
			url: new URL(request.url)
		} as never)) as Response;

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(await response.json()).toMatchObject({
			syncedConnections: 1,
			failedConnections: 0,
			skippedConnections: 2,
			failures: []
		});
		expect(connectionMocks.syncPlaidItem).toHaveBeenCalledTimes(1);
		expect(connectionMocks.syncPlaidItem).toHaveBeenCalledWith('healthy', {
			enableTransactions: true
		});
	});

	it('rejects cross-origin bulk transaction sync before listing or syncing connections', async () => {
		const request = new Request('http://localhost/api/connections/transactions/sync', {
			method: 'POST',
			headers: { origin: 'https://untrusted.example' }
		});

		const response = (await syncTransactions({
			request,
			url: new URL(request.url)
		} as never)) as Response;

		expect(response.status).toBe(403);
		expect(connectionMocks.listPlaidConnections).not.toHaveBeenCalled();
		expect(connectionMocks.syncPlaidItem).not.toHaveBeenCalled();
	});

	describe.each([
		{ path: 'sync', handler: syncConnection, options: {} },
		{
			path: 'transactions/sync',
			handler: syncConnectionTransactions,
			options: { enableTransactions: true }
		}
	])('individual connection $path route', ({ path, handler, options }) => {
		const connectionId = '00000000-0000-4000-8000-000000000001';

		async function post(
			query = '',
			id = connectionId,
			origin = 'http://localhost'
		): Promise<Response> {
			const request = new Request(`http://localhost/api/connections/${id}/${path}${query}`, {
				method: 'POST',
				headers: { origin }
			});
			return (await handler({
				request,
				url: new URL(request.url),
				params: { id }
			} as never)) as Response;
		}

		it('imports available data only when explicitly requested after Link', async () => {
			connectionMocks.listPlaidConnections.mockResolvedValue([
				connection(connectionId, 'Synthetic Bank')
			]);
			connectionMocks.syncPlaidItem.mockResolvedValue(syncResult());

			const response = await post('?afterLink=true');

			expect(response.status).toBe(200);
			expect(response.headers.get('cache-control')).toContain('no-store');
			expect(await response.json()).toMatchObject({ cardCount: 1, accountCount: 2 });
			expect(connectionMocks.syncPlaidItem).toHaveBeenCalledWith(connectionId, {
				...options,
				afterLink: true
			});
		});

		it.each(['', '?afterLink=false', '?afterLink=', '?afterLink=1', '?afterLink=TRUE'])(
			'keeps normal bank refresh behavior for query %j',
			async (query) => {
				connectionMocks.listPlaidConnections.mockResolvedValue([
					connection(connectionId, 'Synthetic Bank')
				]);
				connectionMocks.syncPlaidItem.mockResolvedValue(syncResult());

				expect((await post(query)).status).toBe(200);
				expect(connectionMocks.syncPlaidItem).toHaveBeenCalledWith(connectionId, {
					...options,
					afterLink: false
				});
			}
		);

		it('rejects cross-origin requests even after Link', async () => {
			const response = await post('?afterLink=true', connectionId, 'https://untrusted.example');

			expect(response.status).toBe(403);
			expect(connectionMocks.listPlaidConnections).not.toHaveBeenCalled();
			expect(connectionMocks.syncPlaidItem).not.toHaveBeenCalled();
		});

		it('rejects malformed connection identifiers even after Link', async () => {
			const response = await post('?afterLink=true', 'invalid-id');

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 'INVALID_ID' } });
			expect(connectionMocks.listPlaidConnections).not.toHaveBeenCalled();
			expect(connectionMocks.syncPlaidItem).not.toHaveBeenCalled();
		});

		it('rejects connections absent from the current tenant even after Link', async () => {
			connectionMocks.listPlaidConnections.mockResolvedValue([
				connection('00000000-0000-4000-8000-000000000002', 'Other Bank')
			]);

			const response = await post('?afterLink=true');

			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ error: { code: 'CONNECTION_NOT_FOUND' } });
			expect(connectionMocks.listPlaidConnections).toHaveBeenCalledOnce();
			expect(connectionMocks.syncPlaidItem).not.toHaveBeenCalled();
		});
	});

	it.each([
		{ syncPaused: true, status: 'healthy' as const },
		{ syncPaused: false, status: 'needs_update' as const }
	])('allows an explicit sync with connection state %j', async (state) => {
		connectionMocks.listPlaidConnections.mockResolvedValue([
			{ ...connection('explicit', 'Synthetic Bank'), ...state }
		]);
		connectionMocks.syncPlaidItem.mockResolvedValue(syncResult());

		await expect(syncFinancialConnection('explicit')).resolves.toEqual({
			syncedAt: '2026-08-31T12:30:00.000Z',
			cardCount: 1,
			accountCount: 2,
			transactionCount: 3
		});
		expect(connectionMocks.syncPlaidItem).toHaveBeenCalledWith('explicit', {});
	});

	it('uses the provider name when the institution name is unavailable', async () => {
		connectionMocks.listPlaidConnections.mockResolvedValue([connection('unknown', null)]);
		connectionMocks.syncPlaidItem.mockRejectedValue(
			new AppError('PLAID_UNAVAILABLE', 'Plaid could not complete the request.', 502)
		);

		await expect(syncCurrentTenantFinancialConnections()).rejects.toMatchObject({
			message: 'Sync failed for Plaid: Plaid could not complete the request.'
		});
	});

	it('includes skipped connections in the all-tenant summary', async () => {
		connectionMocks.syncAllPlaidItems.mockResolvedValue({
			syncedItems: 2,
			failedItems: 1,
			skippedItems: 3,
			cardCount: 4,
			accountCount: 5,
			transactionCount: 6,
			lastSyncedAt: '2026-08-31T12:30:00.000Z'
		});

		await expect(syncAllTenantFinancialConnections()).resolves.toEqual({
			syncedConnections: 2,
			failedConnections: 1,
			skippedConnections: 3,
			cardCount: 4,
			accountCount: 5,
			transactionCount: 6,
			lastSyncedAt: '2026-08-31T12:30:00.000Z'
		});
	});
});
