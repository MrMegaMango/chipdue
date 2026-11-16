import type { RequestHandler } from './$types';
import { authenticatedTenantId, SESSION_COOKIE_NAME } from '#lib/server/auth.ts';
import { apiError, apiJson } from '#lib/server/http.ts';
import { getGoogleAuthStatus } from '#lib/server/google-oidc.ts';
import { recordRowsRevision } from '#lib/server/record-rows.ts';
import { getRuntimeAuthMode, getRuntimeMode } from '#lib/server/runtime.ts';
import { LEGACY_TENANT_ID, runAsTenant } from '#lib/server/tenant.ts';

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
			dataRevision: tenantId === null ? null : await runAsTenant(tenantId, recordRowsRevision),
			google: await getGoogleAuthStatus(authenticated, tenantId)
		});
	} catch (error) {
		return apiError(error);
	}
};
