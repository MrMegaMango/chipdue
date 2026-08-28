import type { RequestHandler } from './$types';
import { privateResponseHeaders } from '$lib/server/http';
import { clearGoogleTransactionCookie, continueGoogleOidcBootstrap } from '$lib/server/google-oidc';

export const GET: RequestHandler = async ({ cookies, request, url }) => {
	try {
		const location = await continueGoogleOidcBootstrap(request, url, cookies);
		return new Response(null, {
			status: 303,
			headers: { ...privateResponseHeaders, location }
		});
	} catch {
		clearGoogleTransactionCookie(cookies);
		return new Response(null, {
			status: 303,
			headers: { ...privateResponseHeaders, location: '/?google=error' }
		});
	}
};
