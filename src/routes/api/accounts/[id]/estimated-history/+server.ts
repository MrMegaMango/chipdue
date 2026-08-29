import type { RequestHandler } from './$types';
import { rebuildEtradeBrokerageHistory } from '$lib/server/etrade';
import { apiError, apiJson, assertSameOrigin, parseId } from '$lib/server/http';

export const POST: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await rebuildEtradeBrokerageHistory(parseId(params.id)));
	} catch (error) {
		return apiError(error);
	}
};
