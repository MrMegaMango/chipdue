import type { RequestHandler } from './$types';
import { syncCurrentTenantFinancialConnections } from '#lib/server/financial-connections.ts';
import { apiError, apiJson, assertSameOrigin } from '#lib/server/http.ts';

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await syncCurrentTenantFinancialConnections());
	} catch (error) {
		return apiError(error);
	}
};
