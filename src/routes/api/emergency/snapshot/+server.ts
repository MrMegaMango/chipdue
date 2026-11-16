import type { RequestHandler } from './$types';
import { EMERGENCY_SESSION_COOKIE_NAME, getEmergencyTenant } from '#lib/server/emergency-auth.ts';
import { readEmergencySnapshot } from '#lib/server/emergency-snapshot.ts';
import { AppError } from '#lib/server/errors.ts';
import { apiError, apiJson } from '#lib/server/http.ts';

export const GET: RequestHandler = async ({ cookies }) => {
	try {
		const tenantId = await getEmergencyTenant(cookies.get(EMERGENCY_SESSION_COOKIE_NAME));
		if (!tenantId) throw new AppError('AUTH_REQUIRED', 'Authentication is required.', 401);
		return apiJson({ snapshot: await readEmergencySnapshot(tenantId) });
	} catch (error) {
		return apiError(error);
	}
};
