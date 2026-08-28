import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin, parseId } from '$lib/server/http';
import { syncPlaidItem } from '$lib/server/plaid';

export const POST: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(
			await syncPlaidItem(parseId(params.id), {
				enableTransactions: true
			})
		);
	} catch (error) {
		return apiError(error);
	}
};
