import type { RequestHandler } from './$types';
import { clearSessionCookie, revokeSession, SESSION_COOKIE_NAME } from '$lib/server/auth';
import {
	clearEmergencySessionCookie,
	EMERGENCY_SESSION_COOKIE_NAME,
	revokeEmergencySession
} from '$lib/server/emergency-auth';
import { apiError, assertSameOrigin, noContent } from '$lib/server/http';

export const POST: RequestHandler = async ({ cookies, request, url }) => {
	try {
		assertSameOrigin(request, url);
		const results = await Promise.allSettled([
			revokeSession(cookies.get(SESSION_COOKIE_NAME)),
			revokeEmergencySession(cookies.get(EMERGENCY_SESSION_COOKIE_NAME))
		]);
		clearSessionCookie(cookies);
		clearEmergencySessionCookie(cookies);
		const failed = results.find((result) => result.status === 'rejected');
		if (failed?.status === 'rejected') throw failed.reason;
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
