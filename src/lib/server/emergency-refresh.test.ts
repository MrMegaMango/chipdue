import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle } from '../../hooks.server';
import { refreshEmergencySnapshot } from './emergency-refresh';
import type { PrivateRecordRow } from './record-rows';
import { currentTenantId, runAsTenant } from './tenant';

const dependencies = vi.hoisted(() => ({
	configured: true,
	read: vi.fn(),
	publish: vi.fn(),
	authenticate: vi.fn()
}));

vi.mock('./record-rows', () => ({ listRecordRows: dependencies.read }));
vi.mock('./emergency-snapshot', () => ({ publishEmergencySnapshot: dependencies.publish }));
vi.mock('./emergency-store', () => ({ emergencyStorageConfigured: () => dependencies.configured }));
vi.mock('./auth', () => ({
	SESSION_COOKIE_NAME: 'synthetic-session',
	authenticatedTenantId: dependencies.authenticate
}));

const FIRST_TENANT = '10000000-0000-4000-8000-000000000001';
const SECOND_TENANT = '20000000-0000-4000-8000-000000000002';
const START = Date.parse('2026-10-25T18:00:00.000Z');
const requestContext = Symbol.for('@vercel/request-context');
let previousContext: PropertyDescriptor | undefined;
let retained: Promise<unknown>[];

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function rows(id: string): PrivateRecordRow[] {
	return [
		{
			id,
			source: 'manual',
			plaid_item_id: null,
			external_account_ref: null,
			payload_enc: 'unused-by-orchestration-test',
			last_synced_at: null,
			created_at: new Date(START).toISOString(),
			updated_at: new Date(START).toISOString()
		}
	];
}

async function successfulMutation(tenantId: string): Promise<Response> {
	const request = new Request('https://cards.example.test/api/accounts/synthetic-account', {
		method: 'PATCH',
		headers: { host: 'cards.example.test', 'x-forwarded-proto': 'https' }
	});
	return handle({
		event: {
			request,
			url: new URL(request.url),
			route: { id: '/api/accounts/[id]' },
			cookies: { get: () => tenantId },
			locals: {}
		} as never,
		resolve: (async () => new Response('Financial update saved.', { status: 200 })) as never
	});
}

describe.sequential('background emergency refresh', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(START);
		vi.stubEnv('CARDDUE_MODE', 'cloud');
		vi.stubEnv('CARDDUE_AUTH_MODE', 'google');
		vi.stubEnv(
			'DATABASE_URL',
			[
				'postgresql://carddue_runtime:synthetic-password',
				'ep-chipdue-test.us-west-2.aws.neon.tech/carddue?sslmode=require'
			].join('@')
		);
		vi.stubEnv('CARDDUE_MASTER_KEY', Buffer.alloc(32, 29).toString('base64url'));
		vi.stubEnv('CARDDUE_OWNER_PASSWORD_HASH', undefined);
		vi.stubEnv('CARDDUE_ALLOWED_HOSTS', 'cards.example.test');
		vi.stubEnv('CARDDUE_GOOGLE_CLIENT_ID', 'synthetic-chipdue.apps.googleusercontent.com');
		vi.stubEnv('CARDDUE_GOOGLE_CLIENT_SECRET', 'synthetic-google-client-secret');
		vi.stubEnv('CARDDUE_GOOGLE_BOOTSTRAP_HASH', undefined);
		vi.stubEnv('CARDDUE_SESSION_TTL_HOURS', '1');
		vi.stubEnv('VERCEL', '1');
		dependencies.configured = true;
		dependencies.read.mockReset().mockResolvedValue([]);
		dependencies.publish.mockReset().mockResolvedValue(undefined);
		dependencies.authenticate.mockReset().mockImplementation(async (token: string) => token);
		retained = [];
		previousContext = Object.getOwnPropertyDescriptor(globalThis, requestContext);
		// Exercise the installed SDK's real waitUntil adapter through its runtime hook.
		Object.defineProperty(globalThis, requestContext, {
			configurable: true,
			value: { get: () => ({ waitUntil: (promise: Promise<unknown>) => retained.push(promise) }) }
		});
	});

	afterEach(() => {
		if (previousContext) Object.defineProperty(globalThis, requestContext, previousContext);
		else Reflect.deleteProperty(globalThis, requestContext);
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('returns successful responses before stalled backups and retains each tenant across async reads and saves', async () => {
		const firstRead = deferred<PrivateRecordRow[]>();
		const secondRead = deferred<PrivateRecordRow[]>();
		const finishSave = deferred<void>();
		const readTenants: string[] = [];
		const saveTenants: string[] = [];
		dependencies.read.mockImplementation(async () => {
			const tenantId = currentTenantId();
			const result = await (tenantId === FIRST_TENANT ? firstRead.promise : secondRead.promise);
			readTenants.push(currentTenantId());
			return result;
		});
		dependencies.publish.mockImplementation(async () => {
			saveTenants.push(currentTenantId());
			await finishSave.promise;
			saveTenants.push(currentTenantId());
		});
		let responsesReturned = 0;
		const responses = Promise.all(
			[FIRST_TENANT, SECOND_TENANT].map(async (tenantId) => {
				const response = await successfulMutation(tenantId);
				responsesReturned += 1;
				return response;
			})
		);
		try {
			await nextTurn();
			expect(responsesReturned).toBe(2);
			expect(retained).toHaveLength(2);
			expect(dependencies.publish).not.toHaveBeenCalled();
			for (const response of await responses) {
				expect(response.status).toBe(200);
				expect(await response.text()).toBe('Financial update saved.');
			}
			vi.setSystemTime(START + 5000);
			secondRead.resolve(rows(SECOND_TENANT));
			await nextTurn();
			firstRead.resolve(rows(FIRST_TENANT));
			await nextTurn();
			expect(readTenants).toEqual([SECOND_TENANT, FIRST_TENANT]);
			expect(saveTenants).toEqual([SECOND_TENANT, FIRST_TENANT]);
			expect(dependencies.publish).toHaveBeenNthCalledWith(1, rows(SECOND_TENANT), START);
			expect(dependencies.publish).toHaveBeenNthCalledWith(2, rows(FIRST_TENANT), START);
			finishSave.resolve();
			await Promise.all(retained);
			expect(saveTenants).toEqual([SECOND_TENANT, FIRST_TENANT, SECOND_TENANT, FIRST_TENANT]);
		} finally {
			firstRead.resolve([]);
			secondRead.resolve([]);
			finishSave.resolve();
			await responses;
			await Promise.all(retained);
		}
	});

	it('reuses already-fetched rows and their original capture time without another database read', async () => {
		const sourceRows = rows(FIRST_TENANT);
		await runAsTenant(FIRST_TENANT, () => refreshEmergencySnapshot(sourceRows, START - 1000));
		await Promise.all(retained);
		expect(dependencies.read).not.toHaveBeenCalled();
		expect(dependencies.publish).toHaveBeenCalledWith(sourceRows, START - 1000);
		expect(retained).toHaveLength(1);
	});

	it('contains a background failure after the successful response without exposing error details', async () => {
		const finishSave = deferred<void>();
		dependencies.publish.mockReturnValue(finishSave.promise);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const response = await successfulMutation(FIRST_TENANT);
		expect(response.status).toBe(200);
		expect(retained).toHaveLength(1);
		finishSave.reject(new Error('synthetic-private-backup-error'));
		await expect(retained[0]).resolves.toBeUndefined();
		expect(logged).toHaveBeenCalledExactlyOnceWith(
			'The emergency financial copy could not be refreshed.'
		);
	});

	it('awaits completion outside Vercel instead of leaving unretained work', async () => {
		vi.stubEnv('VERCEL', undefined);
		const finishSave = deferred<void>();
		dependencies.publish.mockReturnValue(finishSave.promise);
		let completed = false;
		const refresh = runAsTenant(FIRST_TENANT, async () => {
			await refreshEmergencySnapshot(rows(FIRST_TENANT), START);
			completed = true;
		});
		try {
			await nextTurn();
			expect(completed).toBe(false);
			expect(retained).toHaveLength(0);
			finishSave.resolve();
			await refresh;
			expect(completed).toBe(true);
		} finally {
			finishSave.resolve();
			await refresh;
		}
	});
});
