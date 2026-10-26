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
		(values[0] !== 'login' && values[0] !== 'link' && values[0] !== 'emergency') ||
		[...url.searchParams.keys()].some((name) => name !== 'intent')
	) {
		throw new AppError('INVALID_REQUEST', 'The request is invalid.', 400);
	}
	return values[0];
}

export const GET: RequestHandler = async ({ cookies, request, url }) => {
	let returnPath = '/';
	try {
		const intent = parseIntent(url);
		if (intent === 'emergency') returnPath = '/emergency';
		const location = await beginGoogleOidc(request, url, cookies, intent);
		return new Response(null, {
			status: 303,
			headers: { ...privateResponseHeaders, location }
		});
	} catch {
		clearGoogleTransactionCookie(cookies);
		return new Response(null, {
			status: 303,
			headers: { ...privateResponseHeaders, location: `${returnPath}?google=error` }
		});
	}
};
