import type { RequestHandler } from './$types';
import { syncCurrentTenantFinancialConnections } from '$lib/server/financial-connections';
import { apiError, apiJson, assertSameOrigin } from '$lib/server/http';

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await syncCurrentTenantFinancialConnections());
	} catch (error) {
		return apiError(error);
	}
};
