import type { RequestHandler } from './$types';
import { privateResponseHeaders } from '$lib/server/http';
import {
	beginGoogleOidc,
	clearGoogleTransactionCookie,
	type GoogleOidcIntent
} from '$lib/server/google-oidc';
import { AppError } from '$lib/server/errors';

function parseIntent(url: URL): GoogleOidcIntent {
	const values = url.searchParams.getAll('intent');
	if (
		values.length !== 1 ||
		(values[0] !== 'login' && values[0] !== 'link') ||
		[...url.searchParams.keys()].some((name) => name !== 'intent')
	) {
		throw new AppError('INVALID_REQUEST', 'The request is invalid.', 400);
	}
	return values[0];
}

export const GET: RequestHandler = async ({ cookies, request, url }) => {
	try {
		const location = await beginGoogleOidc(request, url, cookies, parseIntent(url));
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
