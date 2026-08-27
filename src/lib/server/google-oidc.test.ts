import { scryptSync } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as callbackEndpoint } from '../../routes/api/auth/google/callback/+server';
import { GET as startEndpoint } from '../../routes/api/auth/google/start/+server';
import { GET as sessionEndpoint } from '../../routes/api/auth/session/+server';
import {
	authenticateSession,
	loginWithPassword,
	resetAuthStateForTests,
	revokeSession,
	SESSION_COOKIE_NAME
} from './auth';
import {
	resetCloudDatabaseForTests,
	setCloudDatabaseAdapterForTests,
	type CloudDatabaseAdapter,
	type CloudRow,
	type CloudStatement
} from './cloud-database';
import { decryptJson, privateFingerprint, resetCryptoStateForTests } from './crypto';
import {
	GOOGLE_CALLBACK_PATH,
	GOOGLE_ISSUER,
	GOOGLE_TRANSACTION_COOKIE_NAME,
	resetGoogleOidcStateForTests,
	setGoogleOidcDependenciesForTests,
	verifyGoogleIdToken
} from './google-oidc';
import { getCloudRuntimeConfig } from './runtime';

const GOOGLE_ENV_KEYS = [
	'CARDDUE_MODE',
	'DATABASE_URL',
	'CARDDUE_MASTER_KEY',
	'CARDDUE_OWNER_PASSWORD_HASH',
	'CARDDUE_ALLOWED_HOSTS',
	'CARDDUE_GOOGLE_CLIENT_ID',
	'CARDDUE_GOOGLE_CLIENT_SECRET',
	'VERCEL'
] as const;

const CLIENT_ID = ['synthetic-carddue', 'client.apps.googleusercontent.com'].join('-');
const CLIENT_SECRET = ['synthetic', 'google', 'client', 'secret'].join('-');
const TRANSACTION_COOKIE_PURPOSE = 'google-oidc-transaction-cookie-v1';
const TRANSACTION_REFERENCE_PURPOSE = 'google-oidc-transaction-reference-v1';
const GOOGLE_SUBJECT_PURPOSE = 'google-oidc-subject-v1';
const LINK_METADATA_KEY = 'google_oidc_subject_ref_v1';

interface StoredRate {
	window_started_at: number;
	attempts: number;
	blocked_until: number;
	updated_at: number;
}

interface StoredSession {
	password_config_ref: string;
	expires_at: number;
	last_seen_at: number;
}

interface GoogleTransaction {
	transactionToken: string;
	intent: 'login' | 'link';
	state: string;
	nonce: string;
	codeVerifier: string;
	redirectUri: string;
	expiresAt: number;
	linkSessionToken: string | null;
}

class GoogleMemoryAdapter implements CloudDatabaseAdapter {
	readonly metadata = new Map<string, string>();
	readonly rates = new Map<string, StoredRate>();
	readonly sessions = new Map<string, StoredSession>();
	readonly observedParameters: unknown[][] = [];

	async query<T extends CloudRow>(text: string, params: unknown[] = []): Promise<T[]> {
		this.observedParameters.push(params);
		if (text.includes('SELECT value FROM public.carddue_metadata')) {
			const value = this.metadata.get(String(params[0]));
			return (value === undefined ? [] : [{ value }]) as unknown as T[];
		}
		if (text.includes('INSERT INTO public.carddue_metadata AS linked_identity')) {
			const [key, value] = params.map(String);
			const existing = this.metadata.get(key);
			if (existing !== undefined && existing !== value) return [];
			this.metadata.set(key, value);
			return [{ value }] as unknown as T[];
		}
		if (text.includes('SELECT blocked_until FROM public.carddue_auth_rate_limits')) {
			const row = this.rates.get(String(params[0]));
			return (row ? [{ blocked_until: row.blocked_until }] : []) as unknown as T[];
		}
		if (text.includes('INSERT INTO public.carddue_auth_rate_limits AS current_rate')) {
			const [bucket, now, window, maximum, block] = params as [
				string,
				number,
				number,
				number,
				number
			];
			const current = this.rates.get(bucket);
			let next: StoredRate;
			if (!current || current.window_started_at <= now - window) {
				next = { window_started_at: now, attempts: 1, blocked_until: 0, updated_at: now };
			} else if (current.blocked_until > now) {
				next = { ...current, updated_at: now };
			} else {
				const attempts = current.attempts + 1;
				next = {
					...current,
					attempts,
					blocked_until: attempts > maximum ? now + block : current.blocked_until,
					updated_at: now
				};
			}
			this.rates.set(bucket, next);
			return [{ attempts: next.attempts, blocked_until: next.blocked_until }] as unknown as T[];
		}
		if (text.includes('WHERE updated_at < $1')) {
			for (const [key, row] of this.rates) {
				if (row.updated_at < Number(params[0])) this.rates.delete(key);
			}
			return [];
		}
		if (text.includes('WHERE attempts = 0 AND blocked_until < $1')) {
			for (const [key, row] of this.rates) {
				if (row.attempts === 0 && row.blocked_until < Number(params[0])) this.rates.delete(key);
			}
			return [];
		}
		if (
			text.includes('INSERT INTO public.carddue_auth_rate_limits') &&
			text.includes('VALUES ($1, $2, 0, $3, $2)')
		) {
			const [bucket, now, expiresAt] = params as [string, number, number];
			if (this.rates.has(bucket)) return [];
			this.rates.set(bucket, {
				window_started_at: now,
				attempts: 0,
				blocked_until: expiresAt,
				updated_at: now
			});
			return [{ bucket_ref: bucket }] as unknown as T[];
		}
		if (
			text.includes('DELETE FROM public.carddue_auth_rate_limits') &&
			text.includes('attempts = 0 AND blocked_until >= $2')
		) {
			const [bucket, now] = params as [string, number];
			const row = this.rates.get(bucket);
			if (!row || row.attempts !== 0 || row.blocked_until < now) return [];
			this.rates.delete(bucket);
			return [{ bucket_ref: bucket }] as unknown as T[];
		}
		if (text.includes('SELECT password_config_ref')) {
			const row = this.sessions.get(String(params[0]));
			return (row ? [row] : []) as unknown as T[];
		}
		if (text.includes('DELETE FROM public.carddue_auth_sessions WHERE token_hash = $1')) {
			this.sessions.delete(String(params[0]));
			return [];
		}
		if (text.includes('UPDATE public.carddue_auth_sessions SET last_seen_at')) {
			const row = this.sessions.get(String(params[1]));
			if (row) row.last_seen_at = Number(params[0]);
			return [];
		}
		throw new Error(`Unexpected Google test query: ${text.slice(0, 80)}`);
	}

	async transaction(statements: CloudStatement[]): Promise<CloudRow[][]> {
		for (const statement of statements) {
			const params = statement.params ?? [];
			this.observedParameters.push(params);
			if (statement.text.includes('DELETE FROM public.carddue_auth_rate_limits')) {
				this.rates.delete(String(params[0]));
			} else if (statement.text.includes('WHERE expires_at <=')) {
				const [now, passwordRef] = params as [number, string];
				for (const [key, row] of this.sessions) {
					if (row.expires_at <= now || row.password_config_ref !== passwordRef) {
						this.sessions.delete(key);
					}
				}
			} else if (statement.text.includes('INSERT INTO public.carddue_auth_sessions')) {
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

class TestCookies {
	readonly values = new Map<string, string>();
	readonly setOptions = new Map<string, Record<string, unknown>>();
	readonly deleteOptions = new Map<string, Record<string, unknown>>();

	get(name: string): string | undefined {
		return this.values.get(name);
	}

	set(name: string, value: string, options: Record<string, unknown>): void {
		this.values.set(name, value);
		this.setOptions.set(name, options);
	}

	delete(name: string, options: Record<string, unknown>): void {
		this.values.delete(name);
		this.deleteOptions.set(name, options);
	}
}

function passwordHash(password: string): string {
	const salt = Buffer.alloc(16, 17);
	const hash = scryptSync(password, salt, 32, {
		N: 16_384,
		r: 8,
		p: 1,
		maxmem: 64 * 1024 * 1024
	});
	return `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function setCloudEnvironment(): void {
	process.env.CARDDUE_MODE = 'cloud';
	process.env.DATABASE_URL = [
		'postgresql://carddue_runtime:synthetic-password',
		'ep-carddue-test.us-west-2.aws.neon.tech/carddue?sslmode=require'
	].join('@');
	process.env.CARDDUE_MASTER_KEY = Buffer.alloc(32, 29).toString('base64url');
	process.env.CARDDUE_OWNER_PASSWORD_HASH = passwordHash('recovery password');
	process.env.CARDDUE_ALLOWED_HOSTS = 'cards.example.test';
	process.env.CARDDUE_GOOGLE_CLIENT_ID = CLIENT_ID;
	process.env.CARDDUE_GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
	delete process.env.VERCEL;
}

function startRequest(intent: 'login' | 'link', headers: Record<string, string> = {}): Request {
	return new Request(`https://cards.example.test/api/auth/google/start?intent=${intent}`, {
		headers: {
			host: 'cards.example.test',
			origin: 'https://cards.example.test',
			'sec-fetch-site': 'same-origin',
			...headers
		}
	});
}

async function callStart(cookies: TestCookies, request: Request): Promise<Response> {
	return startEndpoint({ cookies, request, url: new URL(request.url) } as never);
}

async function callCallback(cookies: TestCookies, callbackUrl: string): Promise<Response> {
	const request = new Request(callbackUrl, { headers: { host: 'cards.example.test' } });
	return callbackEndpoint({ cookies, request, url: new URL(request.url) } as never);
}

function readTransaction(cookies: TestCookies): GoogleTransaction {
	const envelope = cookies.values.get(GOOGLE_TRANSACTION_COOKIE_NAME);
	if (!envelope) throw new Error('Expected a Google transaction cookie.');
	return decryptJson<GoogleTransaction>(envelope, TRANSACTION_COOKIE_PURPOSE);
}

function callbackUrl(
	transaction: GoogleTransaction,
	overrides: { state?: string; issuer?: string; code?: string; error?: string } = {}
): string {
	const url = new URL(`https://cards.example.test${GOOGLE_CALLBACK_PATH}`);
	url.searchParams.set('state', overrides.state ?? transaction.state);
	url.searchParams.set('iss', overrides.issuer ?? GOOGLE_ISSUER);
	if (overrides.error !== undefined) url.searchParams.set('error', overrides.error);
	else url.searchParams.set('code', overrides.code ?? 'synthetic-authorization-code');
	return url.toString();
}

function linkedReference(subject: string): string {
	return privateFingerprint(`${GOOGLE_ISSUER}\0${subject}`, GOOGLE_SUBJECT_PURPOSE);
}

let signingKey: CryptoKey;
let googleKeySet: ReturnType<typeof createLocalJWKSet>;

async function signIdToken(options: {
	nonce: string;
	subject?: string;
	issuer?: string;
	audience?: string | string[];
	authorizedParty?: string;
	issuedAtOffset?: number;
	expiresIn?: number;
	email?: string;
}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const payload: Record<string, unknown> = {
		nonce: options.nonce,
		sub: options.subject ?? 'google-subject-owner'
	};
	if (options.authorizedParty !== undefined) payload.azp = options.authorizedParty;
	if (options.email !== undefined) payload.email = options.email;
	return new SignJWT(payload)
		.setProtectedHeader({ alg: 'RS256', kid: 'carddue-test-key' })
		.setIssuer(options.issuer ?? GOOGLE_ISSUER)
		.setAudience(options.audience ?? CLIENT_ID)
		.setIssuedAt(now + (options.issuedAtOffset ?? 0))
		.setExpirationTime(now + (options.expiresIn ?? 300))
		.sign(signingKey);
}

function installTokenResponse(idToken: string) {
	const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body = init?.body as URLSearchParams;
		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('redirect_uri')).toBe(`https://cards.example.test${GOOGLE_CALLBACK_PATH}`);
		expect(body.get('client_id')).toBe(CLIENT_ID);
		expect(body.get('client_secret')).toBe(CLIENT_SECRET);
		expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(body.has('refresh_token')).toBe(false);
		return new Response(JSON.stringify({ id_token: idToken, access_token: 'discarded-token' }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	});
	setGoogleOidcDependenciesForTests({ fetch: fetchMock });
	return fetchMock;
}

describe.sequential('single-owner Google OIDC', () => {
	let previousEnvironment: Record<string, string | undefined>;
	let adapter: GoogleMemoryAdapter;

	beforeAll(async () => {
		const keys = await generateKeyPair('RS256');
		signingKey = keys.privateKey;
		const publicJwk = await exportJWK(keys.publicKey);
		googleKeySet = createLocalJWKSet({
			keys: [{ ...publicJwk, alg: 'RS256', kid: 'carddue-test-key', use: 'sig' }]
		});
	});

	beforeEach(() => {
		previousEnvironment = Object.fromEntries(GOOGLE_ENV_KEYS.map((key) => [key, process.env[key]]));
		setCloudEnvironment();
		adapter = new GoogleMemoryAdapter();
		setCloudDatabaseAdapterForTests(adapter);
		resetCryptoStateForTests();
		resetAuthStateForTests();
		resetGoogleOidcStateForTests();
		setGoogleOidcDependenciesForTests({ keyResolver: googleKeySet });
	});

	afterEach(() => {
		resetGoogleOidcStateForTests();
		resetCloudDatabaseForTests();
		resetCryptoStateForTests();
		resetAuthStateForTests();
		vi.restoreAllMocks();
		for (const key of GOOGLE_ENV_KEYS) {
			const value = previousEnvironment[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	afterAll(() => {
		resetGoogleOidcStateForTests();
	});

	it('fails closed for partial, empty, whitespace, or implausible Google configuration', () => {
		delete process.env.CARDDUE_GOOGLE_CLIENT_SECRET;
		expect(() => getCloudRuntimeConfig()).toThrow(/not securely configured/);

		process.env.CARDDUE_GOOGLE_CLIENT_SECRET = '';
		expect(() => getCloudRuntimeConfig()).toThrow(/not securely configured/);
		process.env.CARDDUE_GOOGLE_CLIENT_ID = ' ';
		process.env.CARDDUE_GOOGLE_CLIENT_SECRET = ' ';
		expect(() => getCloudRuntimeConfig()).toThrow(/not securely configured/);
		process.env.CARDDUE_GOOGLE_CLIENT_ID = CLIENT_ID;
		process.env.CARDDUE_GOOGLE_CLIENT_SECRET = 'too-short';
		expect(() => getCloudRuntimeConfig()).toThrow(/not securely configured/);

		delete process.env.CARDDUE_GOOGLE_CLIENT_ID;
		delete process.env.CARDDUE_GOOGLE_CLIENT_SECRET;
		expect(getCloudRuntimeConfig().googleOidc).toBeNull();
	});

	it('does not query linked metadata for an anonymous session status request', async () => {
		const cookies = new TestCookies();
		const response = await sessionEndpoint({ cookies } as never);
		expect(await response.json()).toEqual({
			mode: 'cloud',
			authenticated: false,
			google: { configured: true, linked: null }
		});
		expect(adapter.observedParameters).toEqual([]);
	});

	it('reports the actual immutable link state only to an authenticated session', async () => {
		adapter.metadata.set(LINK_METADATA_KEY, linkedReference('google-subject-owner'));
		const sessionToken = await loginWithPassword(
			new Request('https://cards.example.test/api/auth/login'),
			'recovery password'
		);
		const cookies = new TestCookies();
		cookies.values.set(SESSION_COOKIE_NAME, sessionToken);
		const response = await sessionEndpoint({ cookies } as never);
		expect(await response.json()).toEqual({
			mode: 'cloud',
			authenticated: true,
			google: { configured: true, linked: true }
		});
	});

	it('protects link start and collapses every start failure to a fixed local redirect', async () => {
		const cookies = new TestCookies();
		const unauthorized = await callStart(cookies, startRequest('link'));
		expect(unauthorized.status).toBe(303);
		expect(unauthorized.headers.get('location')).toBe('/?google=error');
		expect(cookies.values.has(GOOGLE_TRANSACTION_COOKIE_NAME)).toBe(false);
		const unlinkedLogin = await callStart(cookies, startRequest('login'));
		expect(unlinkedLogin.headers.get('location')).toBe('/?google=error');
		expect(cookies.values.has(GOOGLE_TRANSACTION_COOKIE_NAME)).toBe(false);

		const sameSite = startRequest('login', { 'sec-fetch-site': 'same-site' });
		const rejectedOrigin = await callStart(cookies, sameSite);
		expect(rejectedOrigin.headers.get('location')).toBe('/?google=error');
		expect(cookies.deleteOptions.get(GOOGLE_TRANSACTION_COOKIE_NAME)).toMatchObject({
			path: '/',
			secure: true,
			httpOnly: true,
			sameSite: 'lax'
		});
	});

	it('links only from a live CardDue session with PKCE, nonce, and account selection', async () => {
		const cookies = new TestCookies();
		const sessionToken = await loginWithPassword(
			new Request('https://cards.example.test/api/auth/login'),
			'recovery password'
		);
		cookies.values.set(SESSION_COOKIE_NAME, sessionToken);

		const start = await callStart(cookies, startRequest('link'));
		expect(start.status).toBe(303);
		const providerUrl = new URL(start.headers.get('location')!);
		expect(providerUrl.origin + providerUrl.pathname).toBe(
			'https://accounts.google.com/o/oauth2/v2/auth'
		);
		expect(providerUrl.searchParams.get('scope')).toBe('openid');
		expect(providerUrl.searchParams.get('access_type')).toBe('online');
		expect(providerUrl.searchParams.get('prompt')).toBe('select_account');
		expect(providerUrl.searchParams.get('response_type')).toBe('code');
		expect(providerUrl.searchParams.get('code_challenge_method')).toBe('S256');
		expect(providerUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(providerUrl.searchParams.has('client_secret')).toBe(false);
		expect(providerUrl.searchParams.get('scope')).not.toContain('email');

		const transaction = readTransaction(cookies);
		expect(transaction.linkSessionToken).toBe(sessionToken);
		expect(cookies.setOptions.get(GOOGLE_TRANSACTION_COOKIE_NAME)).toMatchObject({
			path: '/',
			secure: true,
			httpOnly: true,
			sameSite: 'lax',
			maxAge: 600
		});

		const subject = 'google-subject-owner';
		const syntheticEmail = ['synthetic-owner', 'example.test'].join('@');
		const idToken = await signIdToken({
			nonce: transaction.nonce,
			subject,
			email: syntheticEmail
		});
		const fetchMock = installTokenResponse(idToken);
		const originalCookie = cookies.values.get(GOOGLE_TRANSACTION_COOKIE_NAME)!;
		const callback = callbackUrl(transaction);
		const completed = await callCallback(cookies, callback);
		expect(completed.status).toBe(303);
		expect(completed.headers.get('location')).toBe('/?google=linked');
		expect(adapter.metadata.get(LINK_METADATA_KEY)).toBe(linkedReference(subject));

		const durable = JSON.stringify(adapter.observedParameters);
		expect(durable).not.toContain(subject);
		expect(durable).not.toContain(syntheticEmail);
		expect(durable).not.toContain(idToken);
		expect(durable).not.toContain('discarded-token');

		cookies.values.set(GOOGLE_TRANSACTION_COOKIE_NAME, originalCookie);
		const replay = await callCallback(cookies, callback);
		expect(replay.headers.get('location')).toBe('/?google=error');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each(['revoked', 'expired', 'password-rotated'] as const)(
		'rejects a link if the initiating app session is %s before callback',
		async (invalidation) => {
			const cookies = new TestCookies();
			const sessionToken = await loginWithPassword(
				new Request('https://cards.example.test/api/auth/login'),
				'recovery password'
			);
			cookies.values.set(SESSION_COOKIE_NAME, sessionToken);
			expect((await callStart(cookies, startRequest('link'))).status).toBe(303);
			const transaction = readTransaction(cookies);
			if (invalidation === 'revoked') {
				await revokeSession(sessionToken);
			} else if (invalidation === 'expired') {
				const storedSession = [...adapter.sessions.values()][0];
				if (!storedSession) throw new Error('Expected a stored app session.');
				storedSession.expires_at = Date.now() - 1;
			} else {
				process.env.CARDDUE_OWNER_PASSWORD_HASH = passwordHash('replacement recovery password');
			}

			const idToken = await signIdToken({ nonce: transaction.nonce });
			const fetchMock = installTokenResponse(idToken);
			const response = await callCallback(cookies, callbackUrl(transaction));
			expect(response.headers.get('location')).toBe('/?google=error');
			expect(fetchMock).not.toHaveBeenCalled();
			expect(adapter.metadata.has(LINK_METADATA_KEY)).toBe(false);
		}
	);

	it('does not consume before exact state and response-issuer validation', async () => {
		const subject = 'google-subject-owner';
		adapter.metadata.set(LINK_METADATA_KEY, linkedReference(subject));
		const cookies = new TestCookies();
		await callStart(cookies, startRequest('login'));
		const originalCookie = cookies.values.get(GOOGLE_TRANSACTION_COOKIE_NAME)!;
		const transaction = readTransaction(cookies);
		const marker = privateFingerprint(transaction.transactionToken, TRANSACTION_REFERENCE_PURPOSE);
		const idToken = await signIdToken({ nonce: transaction.nonce, subject });
		const fetchMock = installTokenResponse(idToken);

		const wrongState = await callCallback(
			cookies,
			callbackUrl(transaction, { state: Buffer.alloc(32, 9).toString('base64url') })
		);
		expect(wrongState.headers.get('location')).toBe('/?google=error');
		expect(adapter.rates.has(marker)).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();

		cookies.values.set(GOOGLE_TRANSACTION_COOKIE_NAME, originalCookie);
		const wrongIssuer = await callCallback(
			cookies,
			callbackUrl(transaction, { issuer: 'https://example.invalid' })
		);
		expect(wrongIssuer.headers.get('location')).toBe('/?google=error');
		expect(adapter.rates.has(marker)).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();

		cookies.values.set(GOOGLE_TRANSACTION_COOKIE_NAME, originalCookie);
		const valid = await callCallback(cookies, callbackUrl(transaction));
		expect(valid.headers.get('location')).toBe('/?google=login');
		expect(adapter.rates.has(marker)).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('consumes provider errors once without contacting the token endpoint', async () => {
		adapter.metadata.set(LINK_METADATA_KEY, linkedReference('google-subject-owner'));
		const cookies = new TestCookies();
		await callStart(cookies, startRequest('login'));
		const transactionCookie = cookies.values.get(GOOGLE_TRANSACTION_COOKIE_NAME)!;
		const transaction = readTransaction(cookies);
		const fetchMock = installTokenResponse(
			await signIdToken({ nonce: transaction.nonce, subject: 'google-subject-owner' })
		);

		const denied = await callCallback(
			cookies,
			callbackUrl(transaction, { error: 'access_denied' })
		);
		expect(denied.headers.get('location')).toBe('/?google=error');
		expect(fetchMock).not.toHaveBeenCalled();
		cookies.values.set(GOOGLE_TRANSACTION_COOKIE_NAME, transactionCookie);
		const replay = await callCallback(cookies, callbackUrl(transaction));
		expect(replay.headers.get('location')).toBe('/?google=error');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects oversized token responses after single-use consumption', async () => {
		adapter.metadata.set(LINK_METADATA_KEY, linkedReference('google-subject-owner'));
		const cookies = new TestCookies();
		await callStart(cookies, startRequest('login'));
		const transaction = readTransaction(cookies);
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ id_token: 'x'.repeat(70_000) }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		);
		setGoogleOidcDependenciesForTests({ fetch: fetchMock });
		const response = await callCallback(cookies, callbackUrl(transaction));
		expect(response.headers.get('location')).toBe('/?google=error');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('creates an opaque app session only for the previously linked identity', async () => {
		const linkedSubject = 'linked-google-subject';
		adapter.metadata.set(LINK_METADATA_KEY, linkedReference(linkedSubject));
		const cookies = new TestCookies();
		const start = await callStart(cookies, startRequest('login'));
		expect(new URL(start.headers.get('location')!).searchParams.has('prompt')).toBe(false);
		const transaction = readTransaction(cookies);
		installTokenResponse(await signIdToken({ nonce: transaction.nonce, subject: linkedSubject }));

		const completed = await callCallback(cookies, callbackUrl(transaction));
		expect(completed.headers.get('location')).toBe('/?google=login');
		const sessionToken = cookies.values.get(SESSION_COOKIE_NAME);
		expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await authenticateSession(sessionToken)).toBe(true);

		const secondCookies = new TestCookies();
		await callStart(secondCookies, startRequest('login'));
		const secondTransaction = readTransaction(secondCookies);
		installTokenResponse(
			await signIdToken({ nonce: secondTransaction.nonce, subject: 'attacker-google-subject' })
		);
		const rejected = await callCallback(secondCookies, callbackUrl(secondTransaction));
		expect(rejected.headers.get('location')).toBe('/?google=error');
		expect(secondCookies.values.has(SESSION_COOKIE_NAME)).toBe(false);
	});

	it('never overwrites an existing link with a different Google identity', async () => {
		const original = linkedReference('original-google-subject');
		adapter.metadata.set(LINK_METADATA_KEY, original);
		const cookies = new TestCookies();
		const sessionToken = await loginWithPassword(
			new Request('https://cards.example.test/api/auth/login'),
			'recovery password'
		);
		cookies.values.set(SESSION_COOKIE_NAME, sessionToken);
		await callStart(cookies, startRequest('link'));
		const transaction = readTransaction(cookies);
		installTokenResponse(
			await signIdToken({ nonce: transaction.nonce, subject: 'different-google-subject' })
		);
		const response = await callCallback(cookies, callbackUrl(transaction));
		expect(response.headers.get('location')).toBe('/?google=error');
		expect(adapter.metadata.get(LINK_METADATA_KEY)).toBe(original);
	});

	it('validates signature, algorithm, issuer, audience, expiry, freshness, nonce, azp, and sub', async () => {
		const nonce = Buffer.alloc(32, 11).toString('base64url');
		const valid = await signIdToken({ nonce: nonce, subject: 'subject-123' });
		expect(await verifyGoogleIdToken(valid, CLIENT_ID, nonce)).toBe(linkedReference('subject-123'));
		const bareIssuer = await signIdToken({
			nonce,
			subject: 'subject-123',
			issuer: 'accounts.google.com'
		});
		expect(await verifyGoogleIdToken(bareIssuer, CLIENT_ID, nonce)).toBe(
			linkedReference('subject-123')
		);

		const invalidTokens = await Promise.all([
			signIdToken({ nonce: Buffer.alloc(32, 12).toString('base64url') }),
			signIdToken({ nonce, issuer: 'https://example.invalid' }),
			signIdToken({ nonce, audience: 'another-client.apps.googleusercontent.com' }),
			signIdToken({ nonce, expiresIn: -60 }),
			signIdToken({ nonce, issuedAtOffset: -20 * 60 }),
			signIdToken({ nonce, subject: 'invalid subject with spaces' }),
			signIdToken({
				nonce,
				audience: [CLIENT_ID, 'secondary-client.apps.googleusercontent.com']
			}),
			signIdToken({ nonce, authorizedParty: 'another-client.apps.googleusercontent.com' })
		]);
		for (const token of invalidTokens) {
			await expect(verifyGoogleIdToken(token, CLIENT_ID, nonce)).rejects.toBeDefined();
		}

		const otherKeys = await generateKeyPair('RS256');
		const badSignature = new SignJWT({ nonce, sub: 'subject-123' })
			.setProtectedHeader({ alg: 'RS256', kid: 'carddue-test-key' })
			.setIssuer(GOOGLE_ISSUER)
			.setAudience(CLIENT_ID)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(otherKeys.privateKey);
		await expect(verifyGoogleIdToken(await badSignature, CLIENT_ID, nonce)).rejects.toBeDefined();

		const ellipticKeys = await generateKeyPair('ES256');
		const wrongAlgorithm = await new SignJWT({ nonce, sub: 'subject-123' })
			.setProtectedHeader({ alg: 'ES256', kid: 'carddue-test-key' })
			.setIssuer(GOOGLE_ISSUER)
			.setAudience(CLIENT_ID)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(ellipticKeys.privateKey);
		await expect(verifyGoogleIdToken(wrongAlgorithm, CLIENT_ID, nonce)).rejects.toBeDefined();
	});

	it('isolates Google and password throttles and bounds anonymous marker growth', async () => {
		adapter.metadata.set(LINK_METADATA_KEY, linkedReference('google-subject-owner'));
		const cookies = new TestCookies();
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const response = await callStart(cookies, startRequest('login'));
			expect(response.headers.get('location')).toContain('accounts.google.com');
		}
		const blocked = await callStart(cookies, startRequest('login'));
		expect(blocked.headers.get('location')).toBe('/?google=error');

		const passwordSession = await loginWithPassword(
			new Request('https://cards.example.test/api/auth/login'),
			'recovery password'
		);
		expect(await authenticateSession(passwordSession)).toBe(true);
		cookies.values.set(SESSION_COOKIE_NAME, passwordSession);
		const linkStart = await callStart(cookies, startRequest('link'));
		expect(linkStart.headers.get('location')).toContain('accounts.google.com');

		resetAuthStateForTests();
		adapter.rates.clear();
		process.env.VERCEL = '1';
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const request = startRequest('login', {
				'x-forwarded-for': `198.51.100.${(attempt % 250) + 1}`,
				'x-forwarded-proto': 'https'
			});
			expect((await callStart(cookies, request)).headers.get('location')).toContain(
				'accounts.google.com'
			);
		}
		const thresholdRequest = startRequest('login', {
			'x-forwarded-for': '203.0.113.1',
			'x-forwarded-proto': 'https'
		});
		expect((await callStart(cookies, thresholdRequest)).headers.get('location')).toBe(
			'/?google=error'
		);
		const sizeAtBlock = adapter.rates.size;
		const afterBlockRequest = startRequest('login', {
			'x-forwarded-for': '203.0.113.2',
			'x-forwarded-proto': 'https'
		});
		expect((await callStart(cookies, afterBlockRequest)).headers.get('location')).toBe(
			'/?google=error'
		);
		expect(adapter.rates.size).toBe(sizeAtBlock);
	});
});
