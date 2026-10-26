import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Cookies } from '@sveltejs/kit';
import { z } from 'zod';
import { privateFingerprint, secretsEqual } from './crypto';
import {
	deleteEmergencyObject,
	emergencyStorageConfigured,
	readEmergencyObject,
	writeEmergencyObject
} from './emergency-store';
import { AppError } from './errors';
import { getCloudRuntimeConfig, getRuntimeMode } from './runtime';
import { isTenantId } from './tenant';

export const EMERGENCY_SESSION_COOKIE_NAME = '__Host-carddue_emergency_session';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_TTL_SECONDS = 60 * 60;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const CAS_ATTEMPTS = 8;
const referenceSchema = z.string().regex(TOKEN_PATTERN);
const tenantSchema = z.string().refine(isTenantId);
const identitySchema = z
	.object({ version: z.literal(1), tenantId: tenantSchema, configRef: referenceSchema })
	.strict();
const sessionSchema = identitySchema
	.extend({ createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive() })
	.strict();
const transactionSchema = z
	.object({
		version: z.literal(1),
		configRef: referenceSchema,
		expiresAt: z.number().int().positive(),
		consumed: z.boolean()
	})
	.strict();
const rateSchema = z
	.object({
		version: z.literal(1),
		windowStartedAt: z.number().int().nonnegative(),
		attempts: z.number().int().nonnegative(),
		blockedUntil: z.number().int().nonnegative()
	})
	.strict();

function unavailable(): AppError {
	return new AppError('EMERGENCY_UNAVAILABLE', 'Emergency access is temporarily unavailable.', 503);
}

function configReference(): string {
	if (getRuntimeMode() !== 'cloud' || !emergencyStorageConfigured()) throw unavailable();
	const config = getCloudRuntimeConfig();
	if (!config.googleOidc) throw unavailable();
	return privateFingerprint(
		`${config.authMode}\0${config.googleOidc.clientId}\0${config.ownerPasswordHash ?? ''}`,
		'emergency-auth-config-v1'
	);
}

function parseStored<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw unavailable();
	return parsed.data;
}

function conflict(error: unknown): boolean {
	return error instanceof AppError && error.code === 'EMERGENCY_CONFLICT';
}

function sessionKey(token: string): string {
	return `auth/session/${privateFingerprint(token, 'emergency-session-token-v1')}`;
}

function transactionKey(token: string): string {
	return `auth/transaction/${privateFingerprint(token, 'emergency-transaction-token-v1')}`;
}

/** Only a successfully completed normal sign-in may establish this immutable tenant binding. */
export async function saveEmergencyGoogleIdentity(
	subjectReference: string,
	tenantId: string
): Promise<void> {
	if (!emergencyStorageConfigured()) return;
	try {
		if (!TOKEN_PATTERN.test(subjectReference) || !isTenantId(tenantId)) throw unavailable();
		const key = `auth/identity/${subjectReference}`;
		const configRef = configReference();
		for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
			const stored = await readEmergencyObject<unknown>(key);
			if (stored) {
				const identity = parseStored(identitySchema, stored.value);
				if (identity.tenantId !== tenantId) throw unavailable();
				if (secretsEqual(identity.configRef, configRef)) return;
			}
			try {
				await writeEmergencyObject(key, { version: 1, tenantId, configRef }, stored?.etag);
				return;
			} catch (error) {
				if (!conflict(error)) throw error;
			}
		}
		throw unavailable();
	} catch {
		// Backup failures must not block normal login or expose identity data in logs.
		console.error('Emergency sign-in binding could not be saved.');
	}
}

async function consumeRateBucket(key: string, maxAttempts: number, now: number): Promise<void> {
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
		const stored = await readEmergencyObject<unknown>(key);
		const current = stored ? parseStored(rateSchema, stored.value) : null;
		if (current && current.blockedUntil > now) {
			throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.', 429);
		}
		const reset = !current || current.windowStartedAt <= now - RATE_WINDOW_MS;
		const attempts = reset ? 1 : current.attempts + 1;
		const next = {
			version: 1,
			windowStartedAt: reset ? now : current.windowStartedAt,
			attempts,
			blockedUntil: attempts > maxAttempts ? now + RATE_WINDOW_MS : 0
		};
		try {
			await writeEmergencyObject(key, next, stored?.etag);
			if (next.blockedUntil > now) {
				throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.', 429);
			}
			return;
		} catch (error) {
			if (!conflict(error)) throw error;
		}
	}
	throw unavailable();
}

export async function consumeEmergencyGoogleStartRateLimit(request: Request): Promise<void> {
	configReference();
	const forwarded = process.env.VERCEL === '1' ? request.headers.get('x-forwarded-for') : null;
	const source =
		forwarded && forwarded === forwarded.trim() && isIP(forwarded) ? `ip:${forwarded}` : 'global';
	const now = Date.now();
	const globalKey = `auth/rate/${privateFingerprint('global', 'emergency-login-global-rate-v1')}`;
	const global = await readEmergencyObject<unknown>(globalKey);
	if (global && parseStored(rateSchema, global.value).blockedUntil > now) {
		throw new AppError('RATE_LIMITED', 'Too many attempts. Try again later.', 429);
	}
	await consumeRateBucket(
		`auth/rate/${privateFingerprint(source, 'emergency-login-source-rate-v1')}`,
		5,
		now
	);
	await consumeRateBucket(globalKey, 100, now);
}

export async function saveEmergencyTransaction(token: string, expiresAt: number): Promise<void> {
	const configRef = configReference();
	const now = Date.now();
	if (
		!TOKEN_PATTERN.test(token) ||
		!Number.isSafeInteger(expiresAt) ||
		expiresAt <= now ||
		expiresAt > now + 10 * 60 * 1000
	) {
		throw unavailable();
	}
	await writeEmergencyObject(transactionKey(token), {
		version: 1,
		configRef,
		expiresAt,
		consumed: false
	});
}

export async function consumeEmergencyTransaction(token: string): Promise<void> {
	const configRef = configReference();
	if (!TOKEN_PATTERN.test(token)) throw unavailable();
	const key = transactionKey(token);
	const stored = await readEmergencyObject<unknown>(key);
	const transaction = stored ? parseStored(transactionSchema, stored.value) : null;
	if (
		!stored ||
		!transaction ||
		transaction.consumed ||
		transaction.expiresAt <= Date.now() ||
		!secretsEqual(transaction.configRef, configRef)
	) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
	try {
		// A concurrent or failed callback cannot reuse this transaction.
		await writeEmergencyObject(key, { ...transaction, consumed: true }, stored.etag);
	} catch (error) {
		if (conflict(error)) {
			throw new AppError(
				'GOOGLE_AUTH_FAILED',
				'Google authentication could not be completed.',
				401
			);
		}
		throw error;
	}
}

export async function issueEmergencySessionForGoogle(subjectReference: string): Promise<string> {
	const configRef = configReference();
	if (!TOKEN_PATTERN.test(subjectReference)) throw unavailable();
	const stored = await readEmergencyObject<unknown>(`auth/identity/${subjectReference}`);
	const identity = stored ? parseStored(identitySchema, stored.value) : null;
	if (!identity || !secretsEqual(identity.configRef, configRef)) {
		throw new AppError(
			'EMERGENCY_SETUP_REQUIRED',
			'Sign in to the live dashboard to set up saved-finances access.',
			401
		);
	}
	const token = randomBytes(32).toString('base64url');
	const now = Date.now();
	await writeEmergencyObject(sessionKey(token), {
		version: 1,
		tenantId: identity.tenantId,
		configRef,
		createdAt: now,
		expiresAt: now + Math.min(SESSION_TTL_SECONDS, getCloudRuntimeConfig().sessionTtlSeconds) * 1000
	});
	return token;
}

export async function getEmergencyTenant(token: string | undefined): Promise<string | null> {
	if (!token || !TOKEN_PATTERN.test(token) || !emergencyStorageConfigured()) return null;
	const configRef = configReference();
	const stored = await readEmergencyObject<unknown>(sessionKey(token));
	if (!stored) return null;
	const session = parseStored(sessionSchema, stored.value);
	if (
		!secretsEqual(session.configRef, configRef) ||
		session.expiresAt <= Date.now() ||
		session.createdAt > Date.now() ||
		session.expiresAt - session.createdAt > SESSION_TTL_SECONDS * 1000
	) {
		return null;
	}
	return session.tenantId;
}

export async function revokeEmergencySession(token: string | undefined): Promise<void> {
	if (!token || !TOKEN_PATTERN.test(token)) return;
	configReference();
	await deleteEmergencyObject(sessionKey(token));
}

export function setEmergencySessionCookie(cookies: Cookies, token: string): void {
	cookies.set(EMERGENCY_SESSION_COOKIE_NAME, token, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'strict',
		maxAge: Math.min(SESSION_TTL_SECONDS, getCloudRuntimeConfig().sessionTtlSeconds)
	});
}

export function clearEmergencySessionCookie(cookies: Cookies): void {
	cookies.delete(EMERGENCY_SESSION_COOKIE_NAME, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'strict'
	});
}
