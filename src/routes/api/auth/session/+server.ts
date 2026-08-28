import type { RequestHandler } from './$types';
import { authenticateSession, SESSION_COOKIE_NAME } from '$lib/server/auth';
import { apiError, apiJson } from '$lib/server/http';
import { getGoogleAuthStatus } from '$lib/server/google-oidc';
import { getRuntimeAuthMode, getRuntimeMode } from '$lib/server/runtime';

export const GET: RequestHandler = async ({ cookies }) => {
	try {
		const mode = getRuntimeMode();
		const authenticated =
			mode === 'local' || (await authenticateSession(cookies.get(SESSION_COOKIE_NAME)));
		return apiJson({
			mode,
			authMode: getRuntimeAuthMode(),
			authenticated,
			google: await getGoogleAuthStatus(authenticated)
		});
	} catch (error) {
		return apiError(error);
	}
};
