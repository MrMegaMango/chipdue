import type { Handle, HandleServerError } from '@sveltejs/kit';
import { authenticateSession, SESSION_COOKIE_NAME } from '$lib/server/auth';
import { apiError, apiJson } from '$lib/server/http';
import { assertSecureCloudRequest, isLocalAuthority } from '$lib/server/request-security';
import { getRuntimeMode } from '$lib/server/runtime';

function secureHeaders(response: Response): Response {
	response.headers.set('cache-control', 'no-store, max-age=0');
	response.headers.set('cross-origin-opener-policy', 'same-origin-allow-popups');
	response.headers.set('cross-origin-resource-policy', 'same-origin');
	response.headers.set(
		'permissions-policy',
		'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
	);
	response.headers.set('referrer-policy', 'no-referrer');
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('x-frame-options', 'DENY');
	response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
	return response;
}

export const handle: Handle = async ({ event, resolve }) => {
	try {
		const mode = getRuntimeMode();
		if (mode === 'local') {
			if (
				process.env.CARDDUE_ALLOW_REMOTE !== '1' &&
				!isLocalAuthority(event.request.headers.get('host'))
			) {
				return secureHeaders(
					new Response('CardDue accepts local connections only.', {
						status: 403,
						headers: { 'content-type': 'text/plain; charset=utf-8' }
					})
				);
			}
		} else {
			assertSecureCloudRequest(event.request, event.url);
			const path = event.url.pathname.replace(/\/+$/, '') || '/';
			const matchedPath = event.route?.id?.replace(/\/+$/, '') || path;
			const publicApi =
				matchedPath === '/api/health' ||
				matchedPath === '/api/auth/session' ||
				matchedPath === '/api/auth/login' ||
				matchedPath === '/api/auth/logout' ||
				matchedPath === '/api/auth/google/start' ||
				matchedPath === '/api/auth/google/callback';
			if (matchedPath.startsWith('/api/') && !publicApi) {
				const authenticated = await authenticateSession(event.cookies.get(SESSION_COOKIE_NAME));
				if (!authenticated) {
					return secureHeaders(
						apiJson(
							{ error: { code: 'AUTH_REQUIRED', message: 'Authentication is required.' } },
							401
						)
					);
				}
			}
		}
	} catch (error) {
		return secureHeaders(apiError(error));
	}

	return secureHeaders(await resolve(event));
};

export const handleError: HandleServerError = ({ status }) => ({
	message: status >= 500 ? 'An unexpected error occurred.' : 'The request could not be completed.',
	code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'
});
