import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin, parseId } from '#lib/server/http.ts';
import { refreshPlaidInvestments } from '#lib/server/plaid.ts';

export const POST: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await refreshPlaidInvestments(parseId(params.id)));
	} catch (error) {
		return apiError(error);
	}
};
