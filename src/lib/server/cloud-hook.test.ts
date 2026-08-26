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
	'CARDDUE_ALLOWED_HOSTS',
	'VERCEL'
] as const;

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
	options: { host?: string; protocol?: 'http' | 'https'; routeId?: string } = {}
): Promise<Response> {
	const protocol = options.protocol ?? 'https';
	const request = new Request(`${protocol}://cards.example.test${path}`, {
		headers: { host: options.host ?? 'cards.example.test' }
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
		process.env.DATABASE_URL = [
			'postgresql://carddue_runtime:secret',
			'ep-carddue-test.us-west-2.aws.neon.tech/carddue?sslmode=require'
		].join('@');
		process.env.CARDDUE_MASTER_KEY = Buffer.alloc(32, 4).toString('base64url');
		process.env.CARDDUE_OWNER_PASSWORD_HASH = `scrypt$16384$8$1$${Buffer.alloc(16, 2).toString('base64url')}$${Buffer.alloc(32, 3).toString('base64url')}`;
		process.env.CARDDUE_ALLOWED_HOSTS = 'cards.example.test';
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

	it('refuses accidental local mode on Vercel', async () => {
		process.env.CARDDUE_MODE = 'local';
		delete process.env.DATABASE_URL;
		process.env.VERCEL = '1';
		const response = await cloudRequest('/');
		expect(response.status).toBe(503);
	});
});
