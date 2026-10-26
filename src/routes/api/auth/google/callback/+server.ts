import type { RequestHandler } from './$types';
import { setSessionCookie } from '$lib/server/auth';
import { setEmergencySessionCookie } from '$lib/server/emergency-auth';
import { AppError } from '$lib/server/errors';
import {
	clearGoogleTransactionCookie,
	completeGoogleOidc,
	googleOidcReturnPath
} from '$lib/server/google-oidc';
import { privateResponseHeaders } from '$lib/server/http';

export const GET: RequestHandler = async ({ cookies, request, url }) => {
	const returnPath = googleOidcReturnPath(cookies);
	let location = `${returnPath}?google=error`;
	try {
		const result = await completeGoogleOidc(request, url, cookies);
		if (result.outcome === 'emergency') {
			setEmergencySessionCookie(cookies, result.sessionToken);
			location = '/emergency';
		} else {
			if (result.sessionToken) setSessionCookie(cookies, result.sessionToken);
			location = `/?google=${result.outcome}`;
		}
	} catch (error) {
		if (
			returnPath === '/emergency' &&
			error instanceof AppError &&
			error.code === 'EMERGENCY_SETUP_REQUIRED'
		) {
			location = '/emergency?google=setup-required';
		}
		console.error('Google OIDC callback failed', {
			code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
			location:
				error instanceof Error
					? error.stack?.split('\n').find((line) => line.trimStart().startsWith('at '))
					: undefined
		});
		// Provider and validation failures remain generic. Only a verified Google
		// identity without emergency access gets the fixed setup guidance above.
	} finally {
		clearGoogleTransactionCookie(cookies);
	}

	return new Response(null, {
		status: 303,
		headers: { ...privateResponseHeaders, location }
	});
};
