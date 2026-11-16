import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin } from '#lib/server/http.ts';
import { createPlaidLinkToken } from '#lib/server/plaid.ts';

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await createPlaidLinkToken());
	} catch (error) {
		return apiError(error);
	}
};
