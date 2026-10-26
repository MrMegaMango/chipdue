import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearEmergencySessionCookie,
	consumeEmergencyGoogleStartRateLimit,
	consumeEmergencyTransaction,
	EMERGENCY_SESSION_COOKIE_NAME,
	getEmergencyTenant,
	issueEmergencySessionForGoogle,
	revokeEmergencySession,
	saveEmergencyGoogleIdentity,
	saveEmergencyTransaction,
	setEmergencySessionCookie
} from './emergency-auth';
import { AppError } from './errors';

const store = vi.hoisted(() => ({
	configured: true,
	revision: 0,
	objects: new Map<string, { value: unknown; etag: string }>(),
	read: vi.fn(),
	write: vi.fn(),
	remove: vi.fn()
}));

vi.mock('./emergency-store', () => ({
	emergencyStorageConfigured: () => store.configured,
	readEmergencyObject: store.read,
	writeEmergencyObject: store.write,
	deleteEmergencyObject: store.remove
}));

const FIRST_TENANT = '10000000-0000-4000-8000-000000000001';
const SECOND_TENANT = '20000000-0000-4000-8000-000000000002';
const FIRST_SUBJECT = Buffer.alloc(32, 11).toString('base64url');
const SECOND_SUBJECT = Buffer.alloc(32, 12).toString('base64url');
const TRANSACTION_TOKEN = Buffer.alloc(32, 13).toString('base64url');
const START = new Date('2026-10-25T18:00:00.000Z');

function startRequest(ip = '192.0.2.10'): Request {
	return new Request('https://cards.example.test/api/auth/google/start?intent=login', {
		headers: { host: 'cards.example.test', 'x-forwarded-for': ip }
	});
}

async function knownSession(subject = FIRST_SUBJECT, tenant = FIRST_TENANT): Promise<string> {
	await saveEmergencyGoogleIdentity(subject, tenant);
	return issueEmergencySessionForGoogle(subject);
}

describe.sequential('emergency Google authentication', () => {
	beforeEach(() => {
		vi.useFakeTimers();
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
		store.configured = true;
		vi.spyOn(console, 'error').mockImplementation(() => {});
		store.revision = 0;
		store.objects.clear();
		store.read.mockReset().mockImplementation(async (key: string) => {
			const entry = store.objects.get(key);
			return entry ? structuredClone(entry) : null;
		});
		store.write
			.mockReset()
			.mockImplementation(async (key: string, value: unknown, etag?: string) => {
				const current = store.objects.get(key);
				if (etag === undefined ? current !== undefined : current?.etag !== etag) {
					throw new AppError('EMERGENCY_CONFLICT', 'The emergency record changed.', 409);
				}
				const nextEtag = `"synthetic-etag-${++store.revision}"`;
				store.objects.set(key, { value: structuredClone(value), etag: nextEtag });
				return nextEtag;
			});
		store.remove.mockReset().mockImplementation(async (key: string) => {
			store.objects.delete(key);
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('refuses to issue a session for an identity that was never learned', async () => {
		await expect(issueEmergencySessionForGoogle(FIRST_SUBJECT)).rejects.toMatchObject({
			code: 'EMERGENCY_SETUP_REQUIRED',
			status: 401
		});
		expect(store.write).not.toHaveBeenCalled();
	});

	it('keeps sessions for different Google identities in their own tenants', async () => {
		const first = await knownSession();
		const second = await knownSession(SECOND_SUBJECT, SECOND_TENANT);
		expect(first).not.toBe(second);
		await expect(getEmergencyTenant(first)).resolves.toBe(FIRST_TENANT);
		await expect(getEmergencyTenant(second)).resolves.toBe(SECOND_TENANT);
	});

	it('never rebinds a learned Google identity to a different tenant', async () => {
		await saveEmergencyGoogleIdentity(FIRST_SUBJECT, FIRST_TENANT);
		await saveEmergencyGoogleIdentity(FIRST_SUBJECT, SECOND_TENANT);
		const token = await issueEmergencySessionForGoogle(FIRST_SUBJECT);
		await expect(getEmergencyTenant(token)).resolves.toBe(FIRST_TENANT);
	});

	it('keeps the winning identity binding when concurrent learning races', async () => {
		await Promise.all([
			saveEmergencyGoogleIdentity(FIRST_SUBJECT, FIRST_TENANT),
			saveEmergencyGoogleIdentity(FIRST_SUBJECT, SECOND_TENANT)
		]);
		const token = await issueEmergencySessionForGoogle(FIRST_SUBJECT);
		const tenant = await getEmergencyTenant(token);
		expect([FIRST_TENANT, SECOND_TENANT]).toContain(tenant);
		await saveEmergencyGoogleIdentity(
			FIRST_SUBJECT,
			tenant === FIRST_TENANT ? SECOND_TENANT : FIRST_TENANT
		);
		const subsequent = await issueEmergencySessionForGoogle(FIRST_SUBJECT);
		await expect(getEmergencyTenant(subsequent)).resolves.toBe(tenant);
	});

	it('does not retain a plaintext bearer token in persisted session records', async () => {
		const token = await knownSession();
		expect(JSON.stringify([...store.objects])).not.toContain(token);
	});

	it('rejects unknown or altered bearer tokens', async () => {
		const token = await knownSession();
		const altered = `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`;
		await expect(getEmergencyTenant(altered)).resolves.toBeNull();
		await expect(getEmergencyTenant('invalid-token')).resolves.toBeNull();
	});

	it('does not authenticate or create sessions when emergency storage is disabled', async () => {
		const token = await knownSession();
		store.configured = false;
		await expect(getEmergencyTenant(token)).resolves.toBeNull();
		await expect(issueEmergencySessionForGoogle(FIRST_SUBJECT)).rejects.toThrow();
	});

	it('expires a session at its configured lifetime', async () => {
		const token = await knownSession();
		vi.setSystemTime(START.getTime() + 60 * 60 * 1000);
		await expect(getEmergencyTenant(token)).resolves.toBeNull();
	});

	it('caps emergency access at one hour even when normal sessions last longer', async () => {
		vi.stubEnv('CARDDUE_SESSION_TTL_HOURS', '24');
		const token = await knownSession();
		vi.setSystemTime(START.getTime() + 60 * 60 * 1000);
		await expect(getEmergencyTenant(token)).resolves.toBeNull();
	});

	it('sets and clears a host-only secure cookie with the emergency lifetime', () => {
		const cookies = { set: vi.fn(), delete: vi.fn() };
		setEmergencySessionCookie(cookies as never, TRANSACTION_TOKEN);
		expect(EMERGENCY_SESSION_COOKIE_NAME).toBe('__Host-carddue_emergency_session');
		expect(cookies.set).toHaveBeenCalledWith(EMERGENCY_SESSION_COOKIE_NAME, TRANSACTION_TOKEN, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'strict',
			maxAge: 60 * 60
		});
		clearEmergencySessionCookie(cookies as never);
		expect(cookies.delete).toHaveBeenCalledWith(EMERGENCY_SESSION_COOKIE_NAME, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'strict'
		});
	});

	it('persists revocation so the bearer token cannot be reused after a new module load', async () => {
		const token = await knownSession();
		await revokeEmergencySession(token);
		vi.resetModules();
		const fresh = await import('./emergency-auth');
		await expect(fresh.getEmergencyTenant(token)).resolves.toBeNull();
	});

	it('invalidates sessions when the configured Google client changes', async () => {
		const token = await knownSession();
		vi.stubEnv('CARDDUE_GOOGLE_CLIENT_ID', 'synthetic-replacement.apps.googleusercontent.com');
		await expect(getEmergencyTenant(token)).resolves.toBeNull();
		await expect(issueEmergencySessionForGoogle(FIRST_SUBJECT)).rejects.toMatchObject({
			code: 'EMERGENCY_SETUP_REQUIRED',
			status: 401
		});
	});

	it('does not classify a corrupt identity binding as missing setup', async () => {
		await saveEmergencyGoogleIdentity(FIRST_SUBJECT, FIRST_TENANT);
		const stored = store.objects.get(`auth/identity/${FIRST_SUBJECT}`)!;
		stored.value = { ...(stored.value as Record<string, unknown>), tenantId: 'invalid-tenant' };
		store.write.mockClear();
		await expect(issueEmergencySessionForGoogle(FIRST_SUBJECT)).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE',
			status: 503
		});
		expect(store.write).not.toHaveBeenCalled();
	});

	it('consumes a transaction exactly once and rejects replay', async () => {
		await saveEmergencyTransaction(TRANSACTION_TOKEN, Date.now() + 10 * 60 * 1000);
		await expect(consumeEmergencyTransaction(TRANSACTION_TOKEN)).resolves.toBeUndefined();
		await expect(consumeEmergencyTransaction(TRANSACTION_TOKEN)).rejects.toThrow();
	});

	it('allows only one callback to consume a transaction during a CAS race', async () => {
		await saveEmergencyTransaction(TRANSACTION_TOKEN, Date.now() + 10 * 60 * 1000);
		const results = await Promise.allSettled([
			consumeEmergencyTransaction(TRANSACTION_TOKEN),
			consumeEmergencyTransaction(TRANSACTION_TOKEN)
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
	});

	it('rejects expired and never-created transactions', async () => {
		await expect(consumeEmergencyTransaction(TRANSACTION_TOKEN)).rejects.toThrow();
		await saveEmergencyTransaction(TRANSACTION_TOKEN, Date.now() + 1000);
		vi.setSystemTime(START.getTime() + 1000);
		await expect(consumeEmergencyTransaction(TRANSACTION_TOKEN)).rejects.toThrow();
	});

	it('does not consume a transaction when its one-use marker cannot be persisted', async () => {
		await saveEmergencyTransaction(TRANSACTION_TOKEN, Date.now() + 10 * 60 * 1000);
		store.write.mockRejectedValue(
			new AppError('EMERGENCY_UNAVAILABLE', 'Storage unavailable.', 503)
		);
		await expect(consumeEmergencyTransaction(TRANSACTION_TOKEN)).rejects.toThrow();
	});

	it('persists the Google start rate limit across module loads', async () => {
		const request = startRequest();
		for (let attempt = 0; attempt < 5; attempt++) {
			await consumeEmergencyGoogleStartRateLimit(request);
		}
		vi.resetModules();
		const fresh = await import('./emergency-auth');
		await expect(fresh.consumeEmergencyGoogleStartRateLimit(request)).rejects.toMatchObject({
			status: 429
		});
	});

	it('limits the total number of starts even when every request has a different source', async () => {
		for (let attempt = 1; attempt <= 100; attempt++) {
			await consumeEmergencyGoogleStartRateLimit(startRequest(`192.0.2.${attempt}`));
		}
		await expect(
			consumeEmergencyGoogleStartRateLimit(startRequest('192.0.2.101'))
		).rejects.toMatchObject({ status: 429 });
		const storedCount = store.objects.size;
		await expect(
			consumeEmergencyGoogleStartRateLimit(startRequest('192.0.2.102'))
		).rejects.toMatchObject({ status: 429 });
		expect(store.objects.size).toBe(storedCount);
	});

	it('allows a new start once the persisted block has expired', async () => {
		const request = startRequest();
		for (let attempt = 0; attempt < 5; attempt++) {
			await consumeEmergencyGoogleStartRateLimit(request);
		}
		await expect(consumeEmergencyGoogleStartRateLimit(request)).rejects.toMatchObject({
			status: 429
		});
		vi.setSystemTime(START.getTime() + 15 * 60 * 1000 + 1);
		await expect(consumeEmergencyGoogleStartRateLimit(request)).resolves.toBeUndefined();
	});

	it('fails closed when the rate-limit store cannot be read', async () => {
		store.read.mockRejectedValue(
			new AppError('EMERGENCY_UNAVAILABLE', 'Storage unavailable.', 503)
		);
		await expect(consumeEmergencyGoogleStartRateLimit(startRequest())).rejects.toThrow();
	});

	it('fails closed when the rate-limit increment cannot be persisted', async () => {
		store.write.mockRejectedValue(
			new AppError('EMERGENCY_UNAVAILABLE', 'Storage unavailable.', 503)
		);
		await expect(consumeEmergencyGoogleStartRateLimit(startRequest())).rejects.toThrow();
	});

	it.each(['read', 'write'] as const)(
		'does not classify an unavailable identity/session store %s as missing setup',
		async (operation) => {
			await saveEmergencyGoogleIdentity(FIRST_SUBJECT, FIRST_TENANT);
			store[operation].mockRejectedValue(
				new AppError('EMERGENCY_UNAVAILABLE', 'Storage unavailable.', 503)
			);
			await expect(issueEmergencySessionForGoogle(FIRST_SUBJECT)).rejects.toMatchObject({
				code: 'EMERGENCY_UNAVAILABLE',
				status: 503
			});
			expect([...store.objects.keys()].some((key) => key.startsWith('auth/session/'))).toBe(false);
		}
	);

	it('does not reuse an authenticated tenant when the session store becomes unavailable', async () => {
		const token = await knownSession();
		await expect(getEmergencyTenant(token)).resolves.toBe(FIRST_TENANT);
		store.read.mockRejectedValue(
			new AppError('EMERGENCY_UNAVAILABLE', 'Storage unavailable.', 503)
		);
		await expect(getEmergencyTenant(token)).rejects.toThrow();
	});

	it('reports failed revocation instead of claiming the session was revoked', async () => {
		const token = await knownSession();
		const unavailable = new AppError('EMERGENCY_UNAVAILABLE', 'Storage unavailable.', 503);
		store.write.mockRejectedValue(unavailable);
		store.remove.mockRejectedValue(unavailable);
		await expect(revokeEmergencySession(token)).rejects.toThrow();
	});

	it('keeps identity learning best-effort when the store is unavailable', async () => {
		store.read.mockRejectedValue(
			new AppError('EMERGENCY_UNAVAILABLE', 'Storage unavailable.', 503)
		);
		store.write.mockRejectedValue(
			new AppError('EMERGENCY_UNAVAILABLE', 'Storage unavailable.', 503)
		);
		await expect(saveEmergencyGoogleIdentity(FIRST_SUBJECT, FIRST_TENANT)).resolves.toBeUndefined();
		expect(store.objects.size).toBe(0);
		const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
		expect(logged).not.toContain(FIRST_SUBJECT);
		expect(logged).not.toContain(FIRST_TENANT);
	});
});
