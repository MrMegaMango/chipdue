import type { Handle, HandleServerError } from '@sveltejs/kit';
import { authenticatedTenantId, SESSION_COOKIE_NAME } from '$lib/server/auth';
import { apiError, apiJson } from '$lib/server/http';
import { assertSecureCloudRequest, isLocalAuthority } from '$lib/server/request-security';
import { getRuntimeAuthMode, getRuntimeMode } from '$lib/server/runtime';
import { LEGACY_TENANT_ID, runAsTenant } from '$lib/server/tenant';

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

export function isPublicCloudApiPath(path: string): boolean {
	return (
		path === '/api/health' ||
		path === '/api/access-request' ||
		path === '/api/auth/session' ||
		path === '/api/auth/login' ||
		path === '/api/auth/logout' ||
		path === '/api/auth/google/start' ||
		path === '/api/auth/google/callback' ||
		path === '/api/auth/google/bootstrap' ||
		path === '/api/auth/google/bootstrap/continue' ||
		path === '/api/cron/plaid-sync/[candidate]'
	);
}

export const handle: Handle = async ({ event, resolve }) => {
	let tenantId: string | null = null;
	try {
		const mode = getRuntimeMode();
		if (mode === 'local') {
			tenantId = LEGACY_TENANT_ID;
			if (
				process.env.CARDDUE_ALLOW_REMOTE !== '1' &&
				!isLocalAuthority(event.request.headers.get('host'))
			) {
				return secureHeaders(
					new Response('ChipDue accepts local connections only.', {
						status: 403,
						headers: { 'content-type': 'text/plain; charset=utf-8' }
					})
				);
			}
		} else {
			assertSecureCloudRequest(event.request, event.url);
			const path = event.url.pathname.replace(/\/+$/, '') || '/';
			const matchedPath = event.route?.id?.replace(/\/+$/, '') || path;
			if (matchedPath === '/api/auth/login' && getRuntimeAuthMode() === 'google') {
				return secureHeaders(
					apiJson(
						{
							error: {
								code: 'NOT_FOUND',
								message: 'The requested endpoint is unavailable.'
							}
						},
						404
					)
				);
			}
			const publicApi = isPublicCloudApiPath(matchedPath);
			if (matchedPath.startsWith('/api/') && !publicApi) {
				tenantId = await authenticatedTenantId(event.cookies.get(SESSION_COOKIE_NAME));
				if (!tenantId) {
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

	if (tenantId) {
		if (event.locals) event.locals.tenantId = tenantId;
		return secureHeaders(await runAsTenant(tenantId, () => resolve(event)));
	}
	return secureHeaders(await resolve(event));
};

export const handleError: HandleServerError = ({ status }) => ({
	message: status >= 500 ? 'An unexpected error occurred.' : 'The request could not be completed.',
	code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'
});
