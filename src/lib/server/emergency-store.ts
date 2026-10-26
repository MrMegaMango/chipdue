import { BlobError, BlobPreconditionFailedError, del, get, put } from '@vercel/blob';
import { decryptJson, encryptJson } from './crypto';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';

const MAX_PLAINTEXT_BYTES = 3 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = (MAX_PLAINTEXT_BYTES * 4) / 3 + 128;
const TIMEOUT_MS = 8000;

export function emergencyStorageConfigured(): boolean {
	return (
		getRuntimeMode() === 'cloud' &&
		Boolean(
			process.env.BLOB_READ_WRITE_TOKEN?.trim() ||
			(process.env.BLOB_STORE_ID?.trim() && process.env.VERCEL_OIDC_TOKEN?.trim())
		)
	);
}

function pathname(key: string): string {
	if (!/^(?:snapshots|auth\/(?:identity|session|transaction|rate))\/[A-Za-z0-9_-]{43}$/.test(key)) {
		throw new AppError('EMERGENCY_INVALID_KEY', 'The saved record is invalid.', 500);
	}
	if (!emergencyStorageConfigured()) throw unavailable();
	return `emergency/v1/${key}.enc`;
}

function unavailable(): AppError {
	return new AppError('EMERGENCY_UNAVAILABLE', 'Saved finances are temporarily unavailable.', 503);
}

function storeError(error: unknown): AppError {
	if (
		error instanceof BlobPreconditionFailedError ||
		(error instanceof BlobError && /already exists/i.test(error.message))
	) {
		return new AppError('EMERGENCY_CONFLICT', 'The saved record changed. Try again.', 409);
	}
	return unavailable();
}

export async function readEmergencyObject<T>(
	key: string
): Promise<{ value: T; etag: string } | null> {
	const path = pathname(key);
	try {
		const result = await get(path, {
			access: 'private',
			useCache: false,
			abortSignal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!result) return null;
		if (result.statusCode !== 200 || !result.blob.etag || result.blob.size > MAX_ENVELOPE_BYTES) {
			await result.stream?.cancel();
			throw unavailable();
		}
		const reader = result.stream.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.byteLength;
				if (size > MAX_ENVELOPE_BYTES) {
					await reader.cancel();
					throw unavailable();
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		return {
			value: decryptJson<T>(Buffer.concat(chunks).toString('utf8'), `emergency-object:${key}`),
			etag: result.blob.etag
		};
	} catch (error) {
		throw storeError(error);
	}
}

/** Undefined ETag creates a new object; an existing object requires a matching ETag. */
export async function writeEmergencyObject(
	key: string,
	value: unknown,
	previousEtag?: string
): Promise<string> {
	const path = pathname(key);
	if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PLAINTEXT_BYTES) {
		throw new AppError('EMERGENCY_TOO_LARGE', 'The saved copy is too large.', 503);
	}
	try {
		const result = await put(path, encryptJson(value, `emergency-object:${key}`), {
			access: 'private',
			addRandomSuffix: false,
			allowOverwrite: previousEtag !== undefined,
			...(previousEtag === undefined ? {} : { ifMatch: previousEtag }),
			contentType: 'text/plain',
			cacheControlMaxAge: 60,
			abortSignal: AbortSignal.timeout(TIMEOUT_MS)
		});
		if (!result.etag) throw unavailable();
		return result.etag;
	} catch (error) {
		throw storeError(error);
	}
}

export async function deleteEmergencyObject(key: string): Promise<void> {
	const path = pathname(key);
	try {
		await del(path, { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
	} catch (error) {
		throw storeError(error);
	}
}
