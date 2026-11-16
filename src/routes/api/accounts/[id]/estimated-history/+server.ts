import type { RequestHandler } from './$types';
import { rebuildBrokerageHistory } from '#lib/server/brokerage-history-service.ts';
import { apiError, apiJson, assertSameOrigin, parseId } from '#lib/server/http.ts';

export const POST: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await rebuildBrokerageHistory(parseId(params.id)));
	} catch (error) {
		return apiError(error);
	}
};
