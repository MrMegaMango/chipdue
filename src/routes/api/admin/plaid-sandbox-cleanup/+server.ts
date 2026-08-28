import { createHash } from 'node:crypto';
import type { RequestHandler } from './$types';
import { cloudQuery } from '$lib/server/cloud-database';
import { secretsEqual } from '$lib/server/crypto';
import { privateResponseHeaders } from '$lib/server/http';
import { assertSecureCloudRequest } from '$lib/server/request-security';

const CLEANUP_HASH_PATTERN = /^sha256\$[A-Za-z0-9_-]{43}$/;
const CLEANUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLEANUP_TOKEN_DOMAIN = 'chipdue:plaid-sandbox-cleanup:v1\0';

function cleanupHash(token: string): string {
	return `sha256$${createHash('sha256')
		.update(CLEANUP_TOKEN_DOMAIN, 'utf8')
		.update(token, 'ascii')
		.digest('base64url')}`;
}

export const POST: RequestHandler = async ({ request, url }) => {
	assertSecureCloudRequest(request, url);
	const expectedHash = process.env.CARDDUE_PLAID_CLEANUP_HASH;
	const authorization = request.headers.get('authorization') ?? '';
	const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
	if (
		!expectedHash ||
		!CLEANUP_HASH_PATTERN.test(expectedHash) ||
		!CLEANUP_TOKEN_PATTERN.test(token) ||
		!secretsEqual(cleanupHash(token), expectedHash)
	) {
		return new Response(null, { status: 404, headers: privateResponseHeaders });
	}

	await cloudQuery(`DELETE FROM public.carddue_plaid_items`);
	return new Response(null, { status: 204, headers: privateResponseHeaders });
};
