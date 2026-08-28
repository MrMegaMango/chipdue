import { createHash } from 'node:crypto';
import type { RequestHandler } from './$types';
import { cloudQuery } from '$lib/server/cloud-database';
import { secretsEqual } from '$lib/server/crypto';
import { privateResponseHeaders } from '$lib/server/http';
import { assertSecureCloudRequest } from '$lib/server/request-security';

const RESET_HASH_PATTERN = /^sha256\$[A-Za-z0-9_-]{43}$/;
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RESET_TOKEN_DOMAIN = 'chipdue:google-owner-reset:v1\0';

function resetHash(token: string): string {
	return `sha256$${createHash('sha256')
		.update(RESET_TOKEN_DOMAIN, 'utf8')
		.update(token, 'ascii')
		.digest('base64url')}`;
}

export const POST: RequestHandler = async ({ request, url }) => {
	assertSecureCloudRequest(request, url);
	const expectedHash = process.env.CARDDUE_GOOGLE_OWNER_RESET_HASH;
	const authorization = request.headers.get('authorization') ?? '';
	const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
	if (
		!expectedHash ||
		!RESET_HASH_PATTERN.test(expectedHash) ||
		!RESET_TOKEN_PATTERN.test(token) ||
		!secretsEqual(resetHash(token), expectedHash)
	) {
		return new Response(null, { status: 404, headers: privateResponseHeaders });
	}

	const backupPrefix = `recovery_${createHash('sha256').update(token, 'ascii').digest('hex').slice(0, 16)}_`;
	await cloudQuery(
		`UPDATE public.carddue_metadata
		 SET key = $1 || key
		 WHERE key IN ('google_oidc_subject_ref_v1', 'google_oidc_bootstrap_claim_ref_v1')`,
		[backupPrefix]
	);
	return new Response(null, { status: 204, headers: privateResponseHeaders });
};
