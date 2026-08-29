import type { RequestHandler } from './$types';
import { listEtradeOpenOrders } from '$lib/server/etrade';
import { apiError, apiJson, parseId } from '$lib/server/http';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return apiJson(await listEtradeOpenOrders(parseId(params.id)));
	} catch (error) {
		return apiError(error);
	}
};
