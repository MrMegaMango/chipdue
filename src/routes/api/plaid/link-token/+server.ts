import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin } from '$lib/server/http';
import { createPlaidLinkToken } from '$lib/server/plaid';

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await createPlaidLinkToken());
	} catch (error) {
		return apiError(error);
	}
};
