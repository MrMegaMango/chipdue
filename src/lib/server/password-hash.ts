import { AppError } from './errors';

export interface ScryptPasswordHash {
	N: number;
	r: number;
	p: number;
	salt: Buffer;
	expected: Buffer;
}

export function parseScryptPasswordHash(encoded: string): ScryptPasswordHash {
	const [algorithm, nPart, rPart, pPart, saltPart, hashPart, extra] = encoded.split('$');
	const N = Number(nPart);
	const r = Number(rPart);
	const p = Number(pPart);
	if (
		algorithm !== 'scrypt' ||
		extra !== undefined ||
		!Number.isInteger(N) ||
		(N & (N - 1)) !== 0 ||
		N < 16_384 ||
		N > 65_536 ||
		!Number.isInteger(r) ||
		r < 1 ||
		r > 16 ||
		!Number.isInteger(p) ||
		p < 1 ||
		p > 4 ||
		!saltPart ||
		!hashPart ||
		!/^[A-Za-z0-9_-]+$/.test(saltPart) ||
		!/^[A-Za-z0-9_-]+$/.test(hashPart)
	) {
		throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode is not securely configured.', 503);
	}
	const salt = Buffer.from(saltPart, 'base64url');
	const expected = Buffer.from(hashPart, 'base64url');
	if (salt.length < 16 || salt.length > 64 || expected.length < 32 || expected.length > 64) {
		throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode is not securely configured.', 503);
	}
	return { N, r, p, salt, expected };
}
