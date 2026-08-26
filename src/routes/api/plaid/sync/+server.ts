import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin } from '$lib/server/http';
import { syncAllPlaidItems } from '$lib/server/plaid';

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await syncAllPlaidItems());
	} catch (error) {
		return apiError(error);
	}
};
