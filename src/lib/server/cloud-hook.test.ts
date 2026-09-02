import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../../hooks.server';
import {
	resetCloudDatabaseForTests,
	setCloudDatabaseAdapterForTests,
	type CloudDatabaseAdapter,
	type CloudRow
} from './cloud-database';
import { resetCryptoStateForTests } from './crypto';

const ENV_KEYS = [
	'CARDDUE_MODE',
	'DATABASE_URL',
	'CARDDUE_MASTER_KEY',
	'CARDDUE_OWNER_PASSWORD_HASH',
	'CARDDUE_AUTH_MODE',
	'CARDDUE_ALLOWED_HOSTS',
	'CARDDUE_GOOGLE_CLIENT_ID',
	'CARDDUE_GOOGLE_CLIENT_SECRET',
	'CARDDUE_GOOGLE_BOOTSTRAP_HASH',
	'CRON_SECRET',
	'VERCEL'
] as const;

const CRON_SECRET = 'x'.repeat(32);

const emptyAdapter: CloudDatabaseAdapter = {
	async query<T extends CloudRow>(): Promise<T[]> {
		return [];
	},
	async transaction(): Promise<CloudRow[][]> {
		return [];
	}
};

async function cloudRequest(
	path: string,
	options: {
		headers?: HeadersInit;
		host?: string;
		protocol?: 'http' | 'https';
		routeId?: string;
	} = {}
): Promise<Response> {
	const protocol = options.protocol ?? 'https';
	const headers = new Headers(options.headers);
	headers.set('host', options.host ?? 'cards.example.test');
	const request = new Request(`${protocol}://cards.example.test${path}`, {
		headers
	});
	return handle({
		event: {
			request,
			url: new URL(request.url),
			route: { id: options.routeId ?? path },
			cookies: { get: () => undefined }
		} as never,
		resolve: (() => new Response('resolved')) as never
	});
}

describe.sequential('cloud request guard', () => {
	let previous: Record<string, string | undefined>;

	beforeEach(() => {
		previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
		process.env.CARDDUE_MODE = 'cloud';
		delete process.env.CARDDUE_AUTH_MODE;
		process.env.DATABASE_URL = [
			'postgresql://carddue_runtime:secret',
			'ep-chipdue-test.us-west-2.aws.neon.tech/carddue?sslmode=require'
		].join('@');
		process.env.CARDDUE_MASTER_KEY = Buffer.alloc(32, 4).toString('base64url');
		process.env.CARDDUE_OWNER_PASSWORD_HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 2).toString('base64url')}$${Buffer.alloc(32, 3).toString('base64url')}`;
		process.env.CARDDUE_ALLOWED_HOSTS = 'cards.example.test';
		process.env.CRON_SECRET = CRON_SECRET;
		delete process.env.CARDDUE_GOOGLE_CLIENT_ID;
		delete process.env.CARDDUE_GOOGLE_CLIENT_SECRET;
		delete process.env.CARDDUE_GOOGLE_BOOTSTRAP_HASH;
		delete process.env.VERCEL;
		setCloudDatabaseAdapterForTests(emptyAdapter);
		resetCryptoStateForTests();
	});

	afterEach(() => {
		resetCloudDatabaseForTests();
		resetCryptoStateForTests();
		for (const key of ENV_KEYS) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it('rejects an unlisted raw Host before resolving a page', async () => {
		const response = await cloudRequest('/', { host: 'attacker.invalid' });
		expect(response.status).toBe(403);
		expect(response.headers.get('cache-control')).toContain('no-store');
	});

	it('requires HTTPS before resolving a page', async () => {
		const response = await cloudRequest('/', { protocol: 'http' });
		expect(response.status).toBe(403);
	});

	it('requires an opaque session for private APIs', async () => {
		const response = await cloudRequest('/api/cards');
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: { code: 'AUTH_REQUIRED', message: 'Authentication is required.' }
		});
	});

	it('authorizes the matched API route even when the URL spelling is encoded', async () => {
		const response = await cloudRequest('/api/%63ards', { routeId: '/api/cards' });
		expect(response.status).toBe(401);
	});

	it('allows auth session discovery without an existing session', async () => {
		const response = await cloudRequest('/api/auth/session');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('resolved');
	});

	it('allows unauthenticated visitors to start an admin access request', async () => {
		const response = await cloudRequest('/api/access-request');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('resolved');
	});

	it('lets the Google start and callback routes perform their own intent validation', async () => {
		for (const path of [
			'/api/auth/google/start',
			'/api/auth/google/callback',
			'/api/auth/google/bootstrap',
			'/api/auth/google/bootstrap/continue'
		]) {
			const response = await cloudRequest(path);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('resolved');
		}
	});

	it('allows an authenticated scheduled-sync route without a user session', async () => {
		const response = await cloudRequest('/api/cron/plaid-sync/morning-pdt', {
			routeId: '/api/cron/plaid-sync/[candidate]',
			headers: {
				authorization: `Bearer ${CRON_SECRET}`,
				'user-agent': 'vercel-cron/1.0'
			}
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('resolved');
	});

	it("accepts an authenticated cron on Vercel's generated production hostname", async () => {
		process.env.VERCEL = '1';
		const response = await cloudRequest('/api/cron/plaid-sync/morning-pdt', {
			host: 'chipdue-generated-team.vercel.app',
			routeId: '/api/cron/plaid-sync/[candidate]',
			headers: {
				authorization: `Bearer ${CRON_SECRET}`,
				'user-agent': 'vercel-cron/1.0',
				'x-forwarded-proto': 'https'
			}
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('resolved');
	});

	it('keeps generated Vercel hostnames closed to every other request', async () => {
		process.env.VERCEL = '1';
		const response = await cloudRequest('/api/health', {
			host: 'chipdue-generated-team.vercel.app',
			headers: { 'x-forwarded-proto': 'https' }
		});
		expect(response.status).toBe(403);
	});

	it('rejects unauthenticated requests before bypassing the cron host allowlist', async () => {
		process.env.VERCEL = '1';
		const response = await cloudRequest('/api/cron/plaid-sync/morning-pdt', {
			host: 'chipdue-generated-team.vercel.app',
			routeId: '/api/cron/plaid-sync/[candidate]',
			headers: { 'x-forwarded-proto': 'https' }
		});
		expect(response.status).toBe(404);
	});

	it('requires HTTPS for authenticated cron requests on generated hostnames', async () => {
		process.env.VERCEL = '1';
		const response = await cloudRequest('/api/cron/plaid-sync/morning-pdt', {
			host: 'chipdue-generated-team.vercel.app',
			routeId: '/api/cron/plaid-sync/[candidate]',
			headers: {
				authorization: `Bearer ${CRON_SECRET}`,
				'user-agent': 'vercel-cron/1.0',
				'x-forwarded-proto': 'http'
			}
		});
		expect(response.status).toBe(403);
	});

	it('removes the password endpoint at the hook boundary in Google-only mode', async () => {
		process.env.CARDDUE_AUTH_MODE = 'google';
		delete process.env.CARDDUE_OWNER_PASSWORD_HASH;
		process.env.CARDDUE_GOOGLE_CLIENT_ID = [
			'synthetic-chipdue',
			'client.apps.googleusercontent.com'
		].join('-');
		process.env.CARDDUE_GOOGLE_CLIENT_SECRET = ['synthetic', 'client', 'secret'].join('-');
		const response = await cloudRequest('/api/auth/login');
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: { code: 'NOT_FOUND', message: 'The requested endpoint is unavailable.' }
		});
	});

	it('refuses accidental local mode on Vercel', async () => {
		process.env.CARDDUE_MODE = 'local';
		delete process.env.DATABASE_URL;
		process.env.VERCEL = '1';
		const response = await cloudRequest('/');
		expect(response.status).toBe(503);
	});
});
