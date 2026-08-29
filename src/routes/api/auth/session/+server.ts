import type { RequestHandler } from './$types';
import { authenticatedTenantId, SESSION_COOKIE_NAME } from '$lib/server/auth';
import { apiError, apiJson } from '$lib/server/http';
import { getGoogleAuthStatus } from '$lib/server/google-oidc';
import { getRuntimeAuthMode, getRuntimeMode } from '$lib/server/runtime';
import { LEGACY_TENANT_ID } from '$lib/server/tenant';

export const GET: RequestHandler = async ({ cookies }) => {
	try {
		const mode = getRuntimeMode();
		const tenantId =
			mode === 'local'
				? LEGACY_TENANT_ID
				: await authenticatedTenantId(cookies.get(SESSION_COOKIE_NAME));
		const authenticated = tenantId !== null;
		return apiJson({
			mode,
			authMode: getRuntimeAuthMode(),
			authenticated,
			google: await getGoogleAuthStatus(authenticated, tenantId)
		});
	} catch (error) {
		return apiError(error);
	}
};
