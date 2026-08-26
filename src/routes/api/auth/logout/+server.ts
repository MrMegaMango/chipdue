import type { RequestHandler } from './$types';
import { clearSessionCookie, revokeSession, SESSION_COOKIE_NAME } from '$lib/server/auth';
import { apiError, assertSameOrigin, noContent } from '$lib/server/http';

export const POST: RequestHandler = async ({ cookies, request, url }) => {
	try {
		assertSameOrigin(request, url);
		await revokeSession(cookies.get(SESSION_COOKIE_NAME));
		clearSessionCookie(cookies);
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
