import type { RequestHandler } from './$types';
import { refreshFinancialConnectionTransactions } from '#lib/server/financial-connections.ts';
import { apiError, apiJson, assertSameOrigin, parseId } from '#lib/server/http.ts';

export const POST: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await refreshFinancialConnectionTransactions(parseId(params.id)));
	} catch (error) {
		return apiError(error);
	}
};
