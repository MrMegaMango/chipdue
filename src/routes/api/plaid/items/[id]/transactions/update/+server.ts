import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin, parseId } from '$lib/server/http';
import { createPlaidTransactionsUpdateToken } from '$lib/server/plaid';

export const POST: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await createPlaidTransactionsUpdateToken(parseId(params.id)));
	} catch (error) {
		return apiError(error);
	}
};
