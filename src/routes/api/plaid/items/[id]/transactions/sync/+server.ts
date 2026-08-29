import type { RequestHandler } from './$types';
import { syncFinancialConnection } from '$lib/server/financial-connections';
import { apiError, apiJson, assertSameOrigin, parseId } from '$lib/server/http';

export const POST: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(
			await syncFinancialConnection(parseId(params.id), {
				enableTransactions: true
			})
		);
	} catch (error) {
		return apiError(error);
	}
};
