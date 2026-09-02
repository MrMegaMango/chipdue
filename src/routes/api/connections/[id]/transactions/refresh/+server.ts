import type { RequestHandler } from './$types';
import { refreshFinancialConnectionTransactions } from '$lib/server/financial-connections';
import { apiError, apiJson, assertSameOrigin, parseId } from '$lib/server/http';

export const POST: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await refreshFinancialConnectionTransactions(parseId(params.id)));
	} catch (error) {
		return apiError(error);
	}
};
