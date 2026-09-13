import type { RequestHandler } from './$types';
import { listAutomaticBonusTracking } from '$lib/server/bonus-churn-tracking';
import { apiError, apiJson } from '$lib/server/http';

export const GET: RequestHandler = async () => {
	try {
		return apiJson({ tracking: await listAutomaticBonusTracking() });
	} catch (error) {
		return apiError(error);
	}
};
