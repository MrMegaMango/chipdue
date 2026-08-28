import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Cookies } from '@sveltejs/kit';
import { cloudQuery, cloudTransaction } from './cloud-database';
import { privateFingerprint } from './crypto';
import { AppError } from './errors';
import { parseScryptPasswordHash } from './password-hash';
import { getCloudRuntimeConfig, getRuntimeMode } from './runtime';

export const SESSION_COOKIE_NAME = '__Host-carddue_session';
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_BLOCK_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 5;
const RATE_RETENTION_MS = 24 * 60 * 60 * 1000;
const RATE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const GOOGLE_RATE_WINDOW_MS = 15 * 60 * 1000;
const GOOGLE_RATE_BLOCK_MS = 15 * 60 * 1000;
const GOOGLE_SOURCE_MAX_ATTEMPTS = 5;
const GOOGLE_GLOBAL_MAX_ATTEMPTS = 100;
const GOOGLE_BOOTSTRAP_SOURCE_MAX_ATTEMPTS = 3;
const GOOGLE_BOOTSTRAP_GLOBAL_MAX_ATTEMPTS = 25;
const MAX_PASSWORD_BYTES = 1024;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
let lastRateLimitPruneAt = 0;

interface SessionRow extends Record<string, unknown> {
	password_config_ref: string;
	expires_at: string | number;
	last_seen_at: string | number;
}

interface RateLimitRow extends Record<string, unknown> {
	attempts: number;
	blocked_until: string | number;
}

async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
	if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return false;
	const config = parseScryptPasswordHash(encodedHash);
	const maxmem = Math.max(32 * 1024 * 1024, 128 * config.N * config.r + 8 * 1024 * 1024);
	const actual = await new Promise<Buffer>((resolve, reject) => {
		scrypt(
			password,
			config.salt,
			config.expected.length,
			{ N: config.N, r: config.r, p: config.p, maxmem },
			(error, derivedKey) => (error ? reject(error) : resolve(derivedKey as Buffer))
		);
	});
	return actual.length === config.expected.length && timingSafeEqual(actual, config.expected);
}

function sessionTokenHash(token: string): string {
	return privateFingerprint(token, 'auth-session-token-v1');
}

function authConfigReference(): string {
	const config = getCloudRuntimeConfig();
	if (config.authMode === 'password') {
		if (!config.ownerPasswordHash) {
			throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode is not securely configured.', 503);
		}
		return privateFingerprint(config.ownerPasswordHash, 'auth-password-config-v1');
	}
	if (!config.googleOidc) {
		throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode is not securely configured.', 503);
	}
	return privateFingerprint(`google\0${config.googleOidc.clientId}`, 'auth-google-config-v1');
}

function rateLimitInput(request: Request): string {
	if (process.env.VERCEL !== '1') return 'global';
	const forwarded = request.headers.get('x-forwarded-for');
	if (!forwarded || forwarded !== forwarded.trim() || forwarded.includes(',')) return 'global';
	return isIP(forwarded) ? `ip:${forwarded}` : 'global';
}

function rateLimitReference(request: Request, purpose = 'auth-rate-limit-v1'): string {
	return privateFingerprint(rateLimitInput(request), purpose);
}

async function consumeRateLimit(
	bucketRef: string,
	now: number,
	options: {
		windowMs: number;
		maxAttempts: number;
		blockMs: number;
	} = {
		windowMs: RATE_WINDOW_MS,
		maxAttempts: RATE_MAX_ATTEMPTS,
		blockMs: RATE_BLOCK_MS
	}
): Promise<void> {
	const rows = await cloudQuery<RateLimitRow>(
		`INSERT INTO public.carddue_auth_rate_limits AS current_rate
		 (bucket_ref, window_started_at, attempts, blocked_until, updated_at)
		 VALUES ($1, $2, 1, 0, $2)
		 ON CONFLICT (bucket_ref) DO UPDATE SET
		 window_started_at = CASE
		   WHEN current_rate.blocked_until > $2
		     THEN current_rate.window_started_at
		   WHEN current_rate.window_started_at <= $2 - $3 THEN $2
		   ELSE current_rate.window_started_at
		 END,
		 attempts = CASE
		   WHEN current_rate.blocked_until > $2
		     THEN current_rate.attempts
		   WHEN current_rate.window_started_at <= $2 - $3 THEN 1
		   ELSE current_rate.attempts + 1
		 END,
		 blocked_until = CASE
		   WHEN current_rate.blocked_until > $2
		     THEN current_rate.blocked_until
		   WHEN current_rate.window_started_at <= $2 - $3 THEN 0
		   WHEN current_rate.attempts + 1 > $4 THEN $2 + $5
		   ELSE current_rate.blocked_until
		 END,
		 updated_at = $2
		 RETURNING attempts, blocked_until`,
		[bucketRef, now, options.windowMs, options.maxAttempts, options.blockMs]
	);
	const row = rows[0];
	if (!row || Number(row.blocked_until) > now) {
		throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.', 429);
	}
}

async function pruneStaleRateLimits(now: number): Promise<void> {
	if (lastRateLimitPruneAt > now - RATE_PRUNE_INTERVAL_MS) return;
	await cloudQuery(`DELETE FROM public.carddue_auth_rate_limits WHERE updated_at < $1`, [
		now - RATE_RETENTION_MS
	]);
	lastRateLimitPruneAt = now;
}

async function assertRateLimitNotBlocked(bucketRef: string, now: number): Promise<void> {
	const rows = await cloudQuery<Pick<RateLimitRow, 'blocked_until'>>(
		`SELECT blocked_until FROM public.carddue_auth_rate_limits WHERE bucket_ref = $1`,
		[bucketRef]
	);
	if (rows[0] && Number(rows[0].blocked_until) > now) {
		throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.', 429);
	}
}

async function issueSession(bucketRef: string | undefined, now: number): Promise<string> {
	const config = getCloudRuntimeConfig();
	const token = randomBytes(32).toString('base64url');
	const tokenHash = sessionTokenHash(token);
	const passwordRef = authConfigReference();
	const expiresAt = now + config.sessionTtlSeconds * 1000;
	const statements = [
		{
			text: `DELETE FROM public.carddue_auth_sessions
			       WHERE expires_at <= $1 OR password_config_ref <> $2`,
			params: [now, passwordRef]
		},
		{
			text: `INSERT INTO public.carddue_auth_sessions
			       (token_hash, password_config_ref, created_at, expires_at, last_seen_at)
			       VALUES ($1, $2, $3, $4, $3)`,
			params: [tokenHash, passwordRef, now, expiresAt]
		}
	];
	if (bucketRef) {
		statements.unshift({
			text: `DELETE FROM public.carddue_auth_rate_limits WHERE bucket_ref = $1`,
			params: [bucketRef]
		});
	}
	await cloudTransaction(statements);
	return token;
}

export async function consumeGoogleOidcStartRateLimit(
	request: Request,
	intent: 'login' | 'link'
): Promise<void> {
	const now = Date.now();
	await pruneStaleRateLimits(now);
	const options = {
		windowMs: GOOGLE_RATE_WINDOW_MS,
		maxAttempts: GOOGLE_GLOBAL_MAX_ATTEMPTS,
		blockMs: GOOGLE_RATE_BLOCK_MS
	};
	if (intent === 'link') {
		await consumeRateLimit(rateLimitReference(request, 'google-oidc-link-rate-limit-v1'), now, {
			...options,
			maxAttempts: GOOGLE_SOURCE_MAX_ATTEMPTS
		});
		return;
	}
	const globalBucket = privateFingerprint('global', 'google-oidc-global-rate-limit-v1');
	await assertRateLimitNotBlocked(globalBucket, now);
	await consumeRateLimit(rateLimitReference(request, 'google-oidc-login-rate-limit-v1'), now, {
		...options,
		maxAttempts: GOOGLE_SOURCE_MAX_ATTEMPTS
	});
	await consumeRateLimit(globalBucket, now, options);
}

export async function consumeGoogleOidcBootstrapRateLimit(request: Request): Promise<void> {
	const now = Date.now();
	await pruneStaleRateLimits(now);
	const globalBucket = privateFingerprint('global', 'google-oidc-bootstrap-global-rate-limit-v1');
	await assertRateLimitNotBlocked(globalBucket, now);
	await consumeRateLimit(
		rateLimitReference(request, 'google-oidc-bootstrap-source-rate-limit-v1'),
		now,
		{
			windowMs: GOOGLE_RATE_WINDOW_MS,
			maxAttempts: GOOGLE_BOOTSTRAP_SOURCE_MAX_ATTEMPTS,
			blockMs: GOOGLE_RATE_BLOCK_MS
		}
	);
	await consumeRateLimit(globalBucket, now, {
		windowMs: GOOGLE_RATE_WINDOW_MS,
		maxAttempts: GOOGLE_BOOTSTRAP_GLOBAL_MAX_ATTEMPTS,
		blockMs: GOOGLE_RATE_BLOCK_MS
	});
}

export async function issueGoogleOidcSession(): Promise<string> {
	return issueSession(undefined, Date.now());
}

export async function loginWithPassword(request: Request, password: string): Promise<string> {
	if (getRuntimeMode() !== 'cloud') {
		throw new AppError(
			'AUTH_NOT_AVAILABLE',
			'Password login is only available in cloud mode.',
			409
		);
	}
	const config = getCloudRuntimeConfig();
	if (config.authMode !== 'password' || !config.ownerPasswordHash) {
		throw new AppError('NOT_FOUND', 'The requested endpoint is unavailable.', 404);
	}
	const now = Date.now();
	const bucketRef = rateLimitReference(request);
	await pruneStaleRateLimits(now);
	await consumeRateLimit(bucketRef, now);

	let valid: boolean;
	try {
		valid = await verifyPassword(password, config.ownerPasswordHash);
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError('AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable.', 503);
	}
	if (!valid) throw new AppError('AUTH_FAILED', 'Invalid password.', 401);
	return issueSession(bucketRef, now);
}

export async function authenticateSession(token: string | undefined): Promise<boolean> {
	if (getRuntimeMode() === 'local') return true;
	if (!token || !SESSION_TOKEN_PATTERN.test(token)) return false;
	const tokenHash = sessionTokenHash(token);
	const rows = await cloudQuery<SessionRow>(
		`SELECT password_config_ref, expires_at, last_seen_at
		 FROM public.carddue_auth_sessions WHERE token_hash = $1`,
		[tokenHash]
	);
	const row = rows[0];
	if (!row) return false;
	const now = Date.now();
	const passwordRef = authConfigReference();
	const referenceMatches =
		row.password_config_ref.length === passwordRef.length &&
		timingSafeEqual(Buffer.from(row.password_config_ref), Buffer.from(passwordRef));
	if (!referenceMatches || Number(row.expires_at) <= now) {
		await cloudQuery(`DELETE FROM public.carddue_auth_sessions WHERE token_hash = $1`, [tokenHash]);
		return false;
	}
	if (Number(row.last_seen_at) < now - 15 * 60 * 1000) {
		await cloudQuery(
			`UPDATE public.carddue_auth_sessions SET last_seen_at = $1 WHERE token_hash = $2`,
			[now, tokenHash]
		);
	}
	return true;
}

export async function revokeSession(token: string | undefined): Promise<void> {
	if (getRuntimeMode() !== 'cloud' || !token || !SESSION_TOKEN_PATTERN.test(token)) return;
	await cloudQuery(`DELETE FROM public.carddue_auth_sessions WHERE token_hash = $1`, [
		sessionTokenHash(token)
	]);
}

export function setSessionCookie(cookies: Cookies, token: string): void {
	cookies.set(SESSION_COOKIE_NAME, token, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'strict',
		maxAge: getCloudRuntimeConfig().sessionTtlSeconds
	});
}

export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE_NAME, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'strict'
	});
}

export function resetAuthStateForTests(): void {
	lastRateLimitPruneAt = 0;
}
