import type { RequestHandler } from './$types';
import { setSessionCookie } from '$lib/server/auth';
import { clearGoogleTransactionCookie, completeGoogleOidc } from '$lib/server/google-oidc';
import { privateResponseHeaders } from '$lib/server/http';

export const GET: RequestHandler = async ({ cookies, request, url }) => {
	let marker: 'login' | 'linked' | 'error' = 'error';
	try {
		const result = await completeGoogleOidc(request, url, cookies);
		if (result.outcome === 'login') setSessionCookie(cookies, result.sessionToken);
		marker = result.outcome;
	} catch {
		// Provider and validation failures deliberately collapse to one fixed local redirect.
	} finally {
		clearGoogleTransactionCookie(cookies);
	}

	return new Response(null, {
		status: 303,
		headers: { ...privateResponseHeaders, location: `/?google=${marker}` }
	});
};
