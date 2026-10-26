import { BlobError, BlobPreconditionFailedError } from '@vercel/blob';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decryptJson } from './crypto';
import {
	deleteEmergencyObject,
	emergencyStorageConfigured,
	readEmergencyObject,
	writeEmergencyObject
} from './emergency-store';

const blob = vi.hoisted(() => ({
	objects: new Map<string, { body: string; etag: string }>(),
	revision: 0,
	get: vi.fn(),
	put: vi.fn(),
	del: vi.fn()
}));

vi.mock('@vercel/blob', async (importOriginal) => ({
	...(await importOriginal<typeof import('@vercel/blob')>()),
	get: blob.get,
	put: blob.put,
	del: blob.del
}));

const FIRST_KEY = `snapshots/${Buffer.alloc(32, 1).toString('base64url')}`;
const SECOND_KEY = `snapshots/${Buffer.alloc(32, 2).toString('base64url')}`;

function response(body: string, etag = 'etag-1', advertisedSize = Buffer.byteLength(body)) {
	return {
		statusCode: 200,
		blob: { etag, size: advertisedSize },
		stream: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(Buffer.from(body));
				controller.close();
			}
		})
	};
}

describe.sequential('encrypted independent object storage', () => {
	beforeEach(() => {
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
		vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'synthetic-blob-token');
		vi.stubEnv('BLOB_STORE_ID', undefined);
		vi.stubEnv('VERCEL_OIDC_TOKEN', undefined);
		blob.objects.clear();
		blob.revision = 0;
		blob.get.mockReset().mockImplementation(async (path: string) => {
			const object = blob.objects.get(path);
			return object ? response(object.body, object.etag) : null;
		});
		blob.put
			.mockReset()
			.mockImplementation(
				async (
					path: string,
					body: string,
					options: { allowOverwrite: boolean; ifMatch?: string }
				) => {
					const current = blob.objects.get(path);
					if (current && !options.allowOverwrite) throw new BlobError('This blob already exists');
					if (options.ifMatch !== undefined && current?.etag !== options.ifMatch)
						throw new BlobPreconditionFailedError();
					const etag = `etag-${++blob.revision}`;
					blob.objects.set(path, { body, etag });
					return { etag };
				}
			);
		blob.del.mockReset().mockImplementation(async (path: string) => {
			blob.objects.delete(path);
		});
	});

	afterEach(() => vi.unstubAllEnvs());

	it('encrypts before upload and fetches private records directly from origin', async () => {
		const value = {
			tenantId: 'synthetic-tenant',
			amountCents: 12345,
			accountName: 'Private checking'
		};
		const etag = await writeEmergencyObject(FIRST_KEY, value);
		const [path, envelope, options] = blob.put.mock.calls[0];
		expect(path).toBe(`emergency/v1/${FIRST_KEY}.enc`);
		expect(envelope).not.toContain('Private checking');
		expect(decryptJson(envelope, `emergency-object:${FIRST_KEY}`)).toEqual(value);
		expect(options).toMatchObject({
			access: 'private',
			addRandomSuffix: false,
			allowOverwrite: false,
			contentType: 'text/plain',
			abortSignal: expect.any(AbortSignal)
		});
		expect(options).not.toHaveProperty('ifMatch');
		expect(await readEmergencyObject(FIRST_KEY)).toEqual({ value, etag });
		expect(blob.get).toHaveBeenCalledWith(
			path,
			expect.objectContaining({
				access: 'private',
				useCache: false,
				abortSignal: expect.any(AbortSignal)
			})
		);
	});

	it('binds ciphertext to its original tenant object key', async () => {
		await writeEmergencyObject(FIRST_KEY, { balance: 'synthetic-private-balance' });
		const saved = blob.objects.get(`emergency/v1/${FIRST_KEY}.enc`)!;
		blob.objects.set(`emergency/v1/${SECOND_KEY}.enc`, saved);
		await expect(readEmergencyObject(SECOND_KEY)).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE',
			message: 'Saved finances are temporarily unavailable.',
			status: 503
		});
		expect(await readEmergencyObject(FIRST_KEY)).toMatchObject({
			value: { balance: 'synthetic-private-balance' }
		});
	});

	it('requires create-only or a matching ETag and preserves the object after a conflict', async () => {
		const originalEtag = await writeEmergencyObject(FIRST_KEY, { balance: 1 });
		await expect(writeEmergencyObject(FIRST_KEY, { balance: 2 })).rejects.toMatchObject({
			code: 'EMERGENCY_CONFLICT',
			status: 409
		});
		const nextEtag = await writeEmergencyObject(FIRST_KEY, { balance: 3 }, originalEtag);
		expect(blob.put.mock.calls[2][2]).toMatchObject({
			allowOverwrite: true,
			ifMatch: originalEtag
		});
		await expect(
			writeEmergencyObject(FIRST_KEY, { balance: 4 }, originalEtag)
		).rejects.toMatchObject({ code: 'EMERGENCY_CONFLICT', status: 409 });
		expect(await readEmergencyObject(FIRST_KEY)).toEqual({ value: { balance: 3 }, etag: nextEtag });
	});

	it('returns null for a missing object and supports deleting the same private key', async () => {
		expect(await readEmergencyObject(FIRST_KEY)).toBeNull();
		await writeEmergencyObject(FIRST_KEY, { value: 1 });
		await deleteEmergencyObject(FIRST_KEY);
		expect(await readEmergencyObject(FIRST_KEY)).toBeNull();
		expect(blob.del).toHaveBeenCalledWith(
			`emergency/v1/${FIRST_KEY}.enc`,
			expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
		);
	});

	it('hides provider and decryption failure details', async () => {
		const privateError = new Error('https://private.example.test/object?token=synthetic-secret');
		blob.get.mockRejectedValueOnce(privateError);
		await expect(readEmergencyObject(FIRST_KEY)).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE',
			message: 'Saved finances are temporarily unavailable.'
		});
		blob.put.mockRejectedValueOnce(privateError);
		await expect(writeEmergencyObject(FIRST_KEY, { value: 1 })).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE',
			message: 'Saved finances are temporarily unavailable.'
		});
		blob.del.mockRejectedValueOnce(privateError);
		await expect(deleteEmergencyObject(FIRST_KEY)).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE',
			message: 'Saved finances are temporarily unavailable.'
		});
		blob.get.mockResolvedValueOnce(response('invalid-private-envelope'));
		await expect(readEmergencyObject(FIRST_KEY)).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE',
			message: 'Saved finances are temporarily unavailable.'
		});
	});

	it('bounds UTF-8 plaintext before upload', async () => {
		await expect(
			writeEmergencyObject(FIRST_KEY, { notes: '💸'.repeat(800_000) })
		).rejects.toMatchObject({ code: 'EMERGENCY_TOO_LARGE', status: 503 });
		expect(blob.put).not.toHaveBeenCalled();
	});

	it('rejects oversized advertised envelopes and stops streams that exceed their advertised size', async () => {
		const cancel = vi.fn();
		blob.get.mockResolvedValueOnce({
			statusCode: 200,
			blob: { etag: 'etag', size: 5_000_000 },
			stream: new ReadableStream({ cancel })
		});
		await expect(readEmergencyObject(FIRST_KEY)).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE'
		});
		expect(cancel).toHaveBeenCalledOnce();
		const cancelChunks = vi.fn();
		blob.get.mockResolvedValueOnce({
			statusCode: 200,
			blob: { etag: 'etag', size: 1 },
			stream: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(5_000_000));
				},
				cancel: cancelChunks
			})
		});
		await expect(readEmergencyObject(FIRST_KEY)).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE'
		});
		expect(cancelChunks).toHaveBeenCalledOnce();
	});

	it('rejects missing ETags and non-content responses', async () => {
		blob.get.mockResolvedValueOnce(response('unused', ''));
		await expect(readEmergencyObject(FIRST_KEY)).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE'
		});
		blob.get.mockResolvedValueOnce({
			statusCode: 304,
			blob: { etag: 'etag', size: null },
			stream: null
		});
		await expect(readEmergencyObject(FIRST_KEY)).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE'
		});
		blob.put.mockResolvedValueOnce({});
		await expect(writeEmergencyObject(FIRST_KEY, {})).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE'
		});
	});

	it('only accepts opaque keys in the emergency namespace', async () => {
		await expect(readEmergencyObject('../private/key')).rejects.toMatchObject({
			code: 'EMERGENCY_INVALID_KEY'
		});
		await expect(writeEmergencyObject(`snapshots/${'x'.repeat(42)}`, {})).rejects.toMatchObject({
			code: 'EMERGENCY_INVALID_KEY'
		});
		await expect(
			deleteEmergencyObject('https://private.example.test/object')
		).rejects.toMatchObject({ code: 'EMERGENCY_INVALID_KEY' });
		expect(blob.get).not.toHaveBeenCalled();
		expect(blob.put).not.toHaveBeenCalled();
		expect(blob.del).not.toHaveBeenCalled();
	});

	it('requires cloud mode and either a read-write token or an OIDC store binding', async () => {
		expect(emergencyStorageConfigured()).toBe(true);
		vi.stubEnv('BLOB_READ_WRITE_TOKEN', undefined);
		expect(emergencyStorageConfigured()).toBe(false);
		await expect(readEmergencyObject(FIRST_KEY)).rejects.toMatchObject({
			code: 'EMERGENCY_UNAVAILABLE'
		});
		vi.stubEnv('BLOB_STORE_ID', 'synthetic-store');
		expect(emergencyStorageConfigured()).toBe(false);
		vi.stubEnv('VERCEL_OIDC_TOKEN', 'synthetic-oidc-token');
		expect(emergencyStorageConfigured()).toBe(true);
		vi.stubEnv('CARDDUE_MODE', 'local');
		vi.stubEnv('DATABASE_URL', undefined);
		vi.stubEnv('VERCEL', undefined);
		expect(emergencyStorageConfigured()).toBe(false);
		expect(blob.get).not.toHaveBeenCalled();
	});
});
