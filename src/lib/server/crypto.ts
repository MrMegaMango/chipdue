import {
	createCipheriv,
	createDecipheriv,
	createHmac,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { AppError } from './errors';
import { assertPrivateFilePath, ensurePrivateDataDirectory } from './paths';

const KEY_BYTES = 32;
const IV_BYTES = 12;
let cachedKey: { path: string; value: Buffer } | undefined;

function readAndValidateKey(path: string): Buffer {
	assertPrivateFilePath(path);
	const stat = lstatSync(path);

	if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
		chmodSync(path, 0o600);
	}

	const encoded = readFileSync(path, 'utf8').trim();
	const key = Buffer.from(encoded, 'base64url');
	if (key.length !== KEY_BYTES) {
		throw new AppError('INVALID_MASTER_KEY', 'The master key file is invalid.', 500);
	}
	return key;
}

export function getMasterKey(): Buffer {
	const { masterKey } = ensurePrivateDataDirectory();
	if (cachedKey?.path === masterKey) return cachedKey.value;

	try {
		writeFileSync(masterKey, `${randomBytes(KEY_BYTES).toString('base64url')}\n`, {
			flag: 'wx',
			mode: 0o600
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== 'EEXIST') {
			throw new AppError(
				'MASTER_KEY_UNAVAILABLE',
				'Private storage could not be initialized.',
				500
			);
		}
	}

	const value = readAndValidateKey(masterKey);
	cachedKey = { path: masterKey, value };
	return value;
}

export function encryptSecret(value: string, purpose: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', getMasterKey(), iv);
	cipher.setAAD(Buffer.from(`carddue:${purpose}`, 'utf8'));
	const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [
		'v1',
		iv.toString('base64url'),
		tag.toString('base64url'),
		ciphertext.toString('base64url')
	].join('.');
}

export function decryptSecret(envelope: string, purpose: string): string {
	try {
		const [version, ivPart, tagPart, ciphertextPart, extra] = envelope.split('.');
		if (
			version !== 'v1' ||
			!ivPart ||
			!tagPart ||
			ciphertextPart === undefined ||
			extra !== undefined
		) {
			throw new Error('invalid envelope');
		}

		const iv = Buffer.from(ivPart, 'base64url');
		const tag = Buffer.from(tagPart, 'base64url');
		if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error('invalid envelope');

		const decipher = createDecipheriv('aes-256-gcm', getMasterKey(), iv);
		decipher.setAAD(Buffer.from(`carddue:${purpose}`, 'utf8'));
		decipher.setAuthTag(tag);
		return Buffer.concat([
			decipher.update(Buffer.from(ciphertextPart, 'base64url')),
			decipher.final()
		]).toString('utf8');
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted local data could not be read.', 500);
	}
}

export function encryptJson(value: unknown, purpose: string): string {
	return encryptSecret(JSON.stringify(value), purpose);
}

export function decryptJson<T>(envelope: string, purpose: string): T {
	try {
		return JSON.parse(decryptSecret(envelope, purpose)) as T;
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted local data could not be read.', 500);
	}
}

export function privateFingerprint(value: string, purpose: string): string {
	return createHmac('sha256', getMasterKey())
		.update(`carddue:${purpose}:`)
		.update(value)
		.digest('base64url');
}

export function secretsEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function resetCryptoStateForTests(): void {
	cachedKey = undefined;
}
