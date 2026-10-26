import type { RequestHandler } from './$types';
import type { EmergencySession } from '$lib/emergency';
import { privateFingerprint } from '$lib/server/crypto';
import { EMERGENCY_SESSION_COOKIE_NAME, getEmergencyTenant } from '$lib/server/emergency-auth';
import { emergencyStorageConfigured } from '$lib/server/emergency-store';
import { apiError, apiJson } from '$lib/server/http';
import { getCloudRuntimeConfig, getRuntimeMode } from '$lib/server/runtime';

export const GET: RequestHandler = async ({ cookies }) => {
	try {
		const configured =
			getRuntimeMode() === 'cloud' &&
			emergencyStorageConfigured() &&
			Boolean(getCloudRuntimeConfig().googleOidc);
		const token = cookies.get(EMERGENCY_SESSION_COOKIE_NAME);
		const tenantId = configured ? await getEmergencyTenant(token) : null;
		return apiJson({
			configured,
			authenticated: tenantId !== null,
			sessionRef:
				tenantId && token ? privateFingerprint(token, 'emergency-browser-session-v1') : null
		} satisfies EmergencySession);
	} catch (error) {
		return apiError(error);
	}
};
