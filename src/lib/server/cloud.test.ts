import { createHash, scryptSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as loginEndpoint } from '../../routes/api/auth/login/+server';
import { POST as logoutEndpoint } from '../../routes/api/auth/logout/+server';
import { GET as sessionEndpoint } from '../../routes/api/auth/session/+server';
import {
	authenticateSession,
	loginWithPassword,
	resetAuthStateForTests,
	setSessionCookie
} from './auth';
import { createManualCard } from './cards';
import {
	CLOUD_MIGRATION_STATEMENTS,
	CLOUD_SCHEMA_VERSION,
	resetCloudDatabaseForTests,
	setCloudDatabaseAdapterForTests,
	type CloudDatabaseAdapter,
	type CloudRow,
	type CloudStatement
} from './cloud-database';
import { resetCryptoStateForTests } from './crypto';
import { getCloudRuntimeConfig, getRuntimeMode } from './runtime';
import { createManualCardSchema } from './schemas';

const CLOUD_ENV_KEYS = [
	'CARDDUE_MODE',
	'DATABASE_URL',
	'CARDDUE_MASTER_KEY',
	'CARDDUE_OWNER_PASSWORD_HASH',
	'CARDDUE_ALLOWED_HOSTS',
	'CARDDUE_SESSION_TTL_HOURS',
	'CARDDUE_GOOGLE_CLIENT_ID',
	'CARDDUE_GOOGLE_CLIENT_SECRET',
	'VERCEL'
] as const;

function passwordHash(password: string, saltByte = 3): string {
	const salt = Buffer.alloc(16, saltByte);
	const hash = scryptSync(password, salt, 32, {
		N: 16_384,
		r: 8,
		p: 1,
		maxmem: 64 * 1024 * 1024
	});
	return `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function setValidCloudEnvironment(): void {
	process.env.CARDDUE_MODE = 'cloud';
	process.env.DATABASE_URL = [
		'postgresql://carddue_runtime:secret',
		'ep-carddue-test.us-west-2.aws.neon.tech/carddue?sslmode=require'
	].join('@');
	process.env.CARDDUE_MASTER_KEY = Buffer.alloc(32, 7).toString('base64url');
	process.env.CARDDUE_OWNER_PASSWORD_HASH = passwordHash('correct horse');
	process.env.CARDDUE_ALLOWED_HOSTS = 'cards.example.test';
	delete process.env.CARDDUE_SESSION_TTL_HOURS;
	delete process.env.CARDDUE_GOOGLE_CLIENT_ID;
	delete process.env.CARDDUE_GOOGLE_CLIENT_SECRET;
	delete process.env.VERCEL;
}

class AuthMemoryAdapter implements CloudDatabaseAdapter {
	readonly observed: unknown[][] = [];
	readonly sessions = new Map<
		string,
		{ password_config_ref: string; expires_at: number; last_seen_at: number }
	>();
	readonly rates = new Map<
		string,
		{ window_started_at: number; attempts: number; blocked_until: number; updated_at: number }
	>();

	async query<T extends CloudRow>(text: string, params: unknown[] = []): Promise<T[]> {
		this.observed.push(params);
		if (text.includes('INSERT INTO') && text.includes('carddue_auth_rate_limits')) {
			const [bucket, nowValue, windowValue, maxValue, blockValue] = params as [
				string,
				number,
				number,
				number,
				number
			];
			const current = this.rates.get(bucket);
			let next;
			if (!current) {
				next = { window_started_at: nowValue, attempts: 1, blocked_until: 0, updated_at: nowValue };
			} else if (current.blocked_until > nowValue) {
				next = { ...current, updated_at: nowValue };
			} else if (current.window_started_at <= nowValue - windowValue) {
				next = { window_started_at: nowValue, attempts: 1, blocked_until: 0, updated_at: nowValue };
			} else {
				const attempts = current.attempts + 1;
				next = {
					...current,
					attempts,
					blocked_until: attempts > maxValue ? nowValue + blockValue : current.blocked_until,
					updated_at: nowValue
				};
			}
			this.rates.set(bucket, next);
			return [{ attempts: next.attempts, blocked_until: next.blocked_until }] as unknown as T[];
		}
		if (
			text.includes('DELETE FROM') &&
			text.includes('carddue_auth_rate_limits WHERE updated_at')
		) {
			const threshold = params[0] as number;
			for (const [key, row] of this.rates) {
				if (row.updated_at < threshold) this.rates.delete(key);
			}
			return [];
		}
		if (text.includes('SELECT password_config_ref')) {
			const row = this.sessions.get(params[0] as string);
			return (row ? [row] : []) as unknown as T[];
		}
		if (text.includes('DELETE FROM') && text.includes('carddue_auth_sessions')) {
			this.sessions.delete(params[0] as string);
			return [];
		}
		if (text.includes('UPDATE') && text.includes('carddue_auth_sessions SET last_seen_at')) {
			const row = this.sessions.get(params[1] as string);
			if (row) row.last_seen_at = params[0] as number;
			return [];
		}
		throw new Error(`Unexpected test query: ${text.slice(0, 50)}`);
	}

	async transaction(statements: CloudStatement[]): Promise<CloudRow[][]> {
		for (const statement of statements) {
			const params = statement.params ?? [];
			this.observed.push(params);
			if (
				statement.text.includes('DELETE FROM') &&
				statement.text.includes('carddue_auth_rate_limits')
			) {
				this.rates.delete(params[0] as string);
			} else if (statement.text.includes('WHERE expires_at <=')) {
				const [now, passwordRef] = params as [number, string];
				for (const [key, row] of this.sessions) {
					if (row.expires_at <= now || row.password_config_ref !== passwordRef) {
						this.sessions.delete(key);
					}
				}
			} else if (
				statement.text.includes('INSERT INTO') &&
				statement.text.includes('carddue_auth_sessions')
			) {
				const [tokenHash, passwordRef, createdAt, expiresAt] = params as [
					string,
					string,
					number,
					number
				];
				this.sessions.set(tokenHash, {
					password_config_ref: passwordRef,
					expires_at: expiresAt,
					last_seen_at: createdAt
				});
			}
		}
		return statements.map(() => []);
	}
}

class CardMemoryAdapter implements CloudDatabaseAdapter {
	readonly observed: unknown[][] = [];
	private row: Record<string, unknown> | undefined;

	async query<T extends CloudRow>(text: string, params: unknown[] = []): Promise<T[]> {
		this.observed.push(params);
		if (text.includes('INSERT INTO') && text.includes('carddue_cards')) {
			this.row = {
				id: params[0],
				source: 'manual',
				payload_enc: params[1],
				last_synced_at: null,
				created_at: params[2],
				updated_at: params[2]
			};
			return [];
		}
		if (text.includes('FROM public.carddue_cards WHERE id')) {
			return (this.row ? [this.row] : []) as T[];
		}
		throw new Error(`Unexpected test query: ${text.slice(0, 50)}`);
	}

	async transaction(): Promise<CloudRow[][]> {
		return [];
	}
}

describe.sequential('cloud mode privacy and authentication', () => {
	let previousEnvironment: Record<string, string | undefined>;

	beforeEach(() => {
		previousEnvironment = Object.fromEntries(CLOUD_ENV_KEYS.map((key) => [key, process.env[key]]));
		setValidCloudEnvironment();
		resetCryptoStateForTests();
		resetAuthStateForTests();
		resetCloudDatabaseForTests();
	});

	afterEach(() => {
		resetCloudDatabaseForTests();
		resetCryptoStateForTests();
		resetAuthStateForTests();
		for (const key of CLOUD_ENV_KEYS) {
			const value = previousEnvironment[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it('requires explicit cloud mode and all security-critical settings', () => {
		expect(getRuntimeMode()).toBe('cloud');
		expect(getCloudRuntimeConfig().allowedHosts.has('cards.example.test')).toBe(true);

		delete process.env.CARDDUE_ALLOWED_HOSTS;
		expect(() => getCloudRuntimeConfig()).toThrow(/not securely configured/);
		process.env.CARDDUE_ALLOWED_HOSTS = 'cards.example.test';
		process.env.DATABASE_URL = [
			'postgresql://carddue_runtime',
			'ep-carddue-test.us-west-2.aws.neon.tech/carddue'
		].join('@');
		expect(() => getCloudRuntimeConfig()).toThrow(/not securely configured/);
		process.env.DATABASE_URL = [
			'postgresql://owner:secret',
			'ep-carddue-test.us-west-2.aws.neon.tech/carddue?sslmode=require'
		].join('@');
		expect(() => getCloudRuntimeConfig()).toThrow(/not securely configured/);
		process.env.DATABASE_URL = [
			'postgresql://carddue_runtime:secret',
			'ep-carddue-test.us-west-2.aws.neon.tech/carddue?sslmode=require&options=unsafe'
		].join('@');
		expect(() => getCloudRuntimeConfig()).toThrow(/not securely configured/);
		process.env.DATABASE_URL = [
			'postgresql://carddue_runtime:secret',
			'ep-carddue-test-pooler.us-west-2.aws.neon.tech/carddue?sslmode=require'
		].join('@');
		expect(() => getCloudRuntimeConfig()).toThrow(/not securely configured/);

		process.env.CARDDUE_MODE = 'local';
		expect(() => getRuntimeMode()).toThrow(/explicitly enabled/);
	});

	it('keeps cloud schema free of plaintext financial fields and runtime DDL', () => {
		const migration = CLOUD_MIGRATION_STATEMENTS.join('\n').toLowerCase();
		expect(CLOUD_SCHEMA_VERSION).toBe(1);
		expect(migration).toContain('payload_enc');
		expect(migration).toContain('access_token_enc');
		for (const plaintextField of ['nickname', 'last4', 'statement_balance', 'minimum_payment']) {
			expect(migration).not.toContain(plaintextField);
		}
	});

	it('stores only encrypted card payloads in cloud queries', async () => {
		const adapter = new CardMemoryAdapter();
		setCloudDatabaseAdapterForTests(adapter);
		const card = await createManualCard(
			createManualCardSchema.parse({
				nickname: 'Cloud private nickname',
				issuer: 'Cloud private issuer',
				last4: '9876',
				statementBalanceCents: 54_321
			})
		);
		expect(card.nickname).toBe('Cloud private nickname');
		const durableValues = JSON.stringify(adapter.observed);
		expect(durableValues).not.toContain('Cloud private nickname');
		expect(durableValues).not.toContain('Cloud private issuer');
		expect(durableValues).not.toContain('9876');
		expect(durableValues).not.toContain('54321');
	});

	it('stores opaque session, password, and rate-limit references only', async () => {
		const adapter = new AuthMemoryAdapter();
		setCloudDatabaseAdapterForTests(adapter);
		process.env.VERCEL = '1';
		const request = new Request('https://cards.example.test/api/auth/login', {
			headers: { 'x-forwarded-for': '203.0.113.19' }
		});
		const token = await loginWithPassword(request, 'correct horse');
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await authenticateSession(token)).toBe(true);

		const durableValues = JSON.stringify(adapter.observed);
		expect(durableValues).not.toContain(token);
		expect(durableValues).not.toContain('correct horse');
		expect(durableValues).not.toContain('203.0.113.19');
	});

	it('invalidates existing sessions when the configured password hash changes', async () => {
		const adapter = new AuthMemoryAdapter();
		setCloudDatabaseAdapterForTests(adapter);
		const request = new Request('https://cards.example.test/api/auth/login');
		const token = await loginWithPassword(request, 'correct horse');
		process.env.CARDDUE_OWNER_PASSWORD_HASH = passwordHash('new password', 9);
		expect(await authenticateSession(token)).toBe(false);
		expect(adapter.sessions.size).toBe(0);
	});

	it('does not let a database attacker mint a session with a public token hash', async () => {
		const adapter = new AuthMemoryAdapter();
		setCloudDatabaseAdapterForTests(adapter);
		const request = new Request('https://cards.example.test/api/auth/login');
		await loginWithPassword(request, 'correct horse');
		const validSession = [...adapter.sessions.values()][0];
		expect(validSession).toBeDefined();

		const attackerToken = Buffer.alloc(32, 19).toString('base64url');
		const publicTokenHash = createHash('sha256')
			.update('carddue:auth-session:v1:', 'utf8')
			.update(attackerToken, 'utf8')
			.digest('base64url');
		adapter.sessions.set(publicTokenHash, {
			...validSession!,
			expires_at: Date.now() + 60_000,
			last_seen_at: Date.now()
		});

		expect(await authenticateSession(attackerToken)).toBe(false);
	});

	it('rate limits repeated failures with a generic error', async () => {
		const adapter = new AuthMemoryAdapter();
		setCloudDatabaseAdapterForTests(adapter);
		const request = new Request('https://cards.example.test/api/auth/login');
		for (let attempt = 0; attempt < 5; attempt += 1) {
			await expect(loginWithPassword(request, 'wrong password')).rejects.toMatchObject({
				code: 'AUTH_FAILED',
				status: 401
			});
		}
		await expect(loginWithPassword(request, 'correct horse')).rejects.toMatchObject({
			code: 'RATE_LIMITED',
			status: 429
		});
	});

	it('uses a __Host Secure HttpOnly Strict session cookie', () => {
		let observed: { name: string; value: string; options: Record<string, unknown> } | undefined;
		const cookies = {
			set(name: string, value: string, options: Record<string, unknown>) {
				observed = { name, value, options };
			}
		};
		setSessionCookie(cookies as never, 'opaque-token');
		expect(observed).toMatchObject({
			name: '__Host-carddue_session',
			value: 'opaque-token',
			options: { path: '/', secure: true, httpOnly: true, sameSite: 'strict' }
		});
		expect(observed?.options).not.toHaveProperty('domain');
	});

	it('exposes the documented login and session API contract', async () => {
		const adapter = new AuthMemoryAdapter();
		setCloudDatabaseAdapterForTests(adapter);
		let sessionCookie: string | undefined;
		const cookies = {
			get(name: string) {
				return name === '__Host-carddue_session' ? sessionCookie : undefined;
			},
			set(name: string, value: string) {
				if (name === '__Host-carddue_session') sessionCookie = value;
			},
			delete(name: string) {
				if (name === '__Host-carddue_session') sessionCookie = undefined;
			}
		};
		const makeLoginRequest = (password: string) =>
			new Request('https://cards.example.test/api/auth/login', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					host: 'cards.example.test',
					origin: 'https://cards.example.test'
				},
				body: JSON.stringify({ password })
			});

		const rejectedRequest = makeLoginRequest('wrong password');
		const rejected = await loginEndpoint({
			cookies,
			request: rejectedRequest,
			url: new URL(rejectedRequest.url)
		} as never);
		expect(rejected.status).toBe(401);
		expect(await rejected.json()).toEqual({
			error: { code: 'AUTH_FAILED', message: 'Invalid password.' }
		});

		const acceptedRequest = makeLoginRequest('correct horse');
		const accepted = await loginEndpoint({
			cookies,
			request: acceptedRequest,
			url: new URL(acceptedRequest.url)
		} as never);
		expect(accepted.status).toBe(204);
		expect(sessionCookie).toMatch(/^[A-Za-z0-9_-]{43}$/);

		const session = await sessionEndpoint({ cookies } as never);
		expect(session.status).toBe(200);
		expect(await session.json()).toEqual({
			mode: 'cloud',
			authenticated: true,
			google: { configured: false, linked: false }
		});

		const logoutRequest = new Request('https://cards.example.test/api/auth/logout', {
			method: 'POST',
			headers: { host: 'cards.example.test', origin: 'https://cards.example.test' }
		});
		const logout = await logoutEndpoint({
			cookies,
			request: logoutRequest,
			url: new URL(logoutRequest.url)
		} as never);
		expect(logout.status).toBe(204);
		expect(sessionCookie).toBeUndefined();
		const signedOutSession = await sessionEndpoint({ cookies } as never);
		expect(await signedOutSession.json()).toEqual({
			mode: 'cloud',
			authenticated: false,
			google: { configured: false, linked: null }
		});
	});
});
