import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin, parseId } from '#lib/server/http.ts';
import { createPlaidUpdateToken } from '#lib/server/plaid.ts';

export const POST: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await createPlaidUpdateToken(parseId(params.id)));
	} catch (error) {
		return apiError(error);
	}
};
