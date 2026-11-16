import type { RequestHandler } from './$types';
import { listEtradeOpenOrders } from '#lib/server/etrade.ts';
import { apiError, apiJson, parseId } from '#lib/server/http.ts';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return apiJson(await listEtradeOpenOrders(parseId(params.id)));
	} catch (error) {
		return apiError(error);
	}
};
