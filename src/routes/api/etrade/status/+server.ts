import type { RequestHandler } from './$types';
import { etradeStatus } from '$lib/server/etrade';
import { apiError, apiJson } from '$lib/server/http';

export const GET: RequestHandler = async () => {
	try {
		return apiJson(await etradeStatus());
	} catch (error) {
		return apiError(error);
	}
};
