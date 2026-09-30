import type { RequestHandler } from './$types';
import { loadDashboard } from '$lib/server/dashboard';
import { apiError, apiJson } from '$lib/server/http';

export const GET: RequestHandler = async ({ url }) => {
	try {
		return apiJson(
			await loadDashboard({ includeActivity: url.searchParams.get('includeActivity') === '1' })
		);
	} catch (error) {
		return apiError(error);
	}
};
