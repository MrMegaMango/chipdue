import type { RequestHandler } from './$types';
import {
	clearEmergencySessionCookie,
	EMERGENCY_SESSION_COOKIE_NAME,
	revokeEmergencySession
} from '$lib/server/emergency-auth';
import { apiError, assertSameOrigin, noContent } from '$lib/server/http';

export const POST: RequestHandler = async ({ cookies, request, url }) => {
	try {
		assertSameOrigin(request, url);
		try {
			await revokeEmergencySession(cookies.get(EMERGENCY_SESSION_COOKIE_NAME));
		} finally {
			clearEmergencySessionCookie(cookies);
		}
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
