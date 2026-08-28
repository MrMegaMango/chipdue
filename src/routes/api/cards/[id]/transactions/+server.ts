import type { RequestHandler } from './$types';
import { listCardTransactions } from '$lib/server/cards';
import { apiError, apiJson, parseId } from '$lib/server/http';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return apiJson(await listCardTransactions(parseId(params.id)));
	} catch (error) {
		return apiError(error);
	}
};
