import type { RequestHandler } from './$types';
import { etradeStatus } from '#lib/server/etrade.ts';
import { apiError, apiJson } from '#lib/server/http.ts';

export const GET: RequestHandler = async () => {
	try {
		return apiJson(await etradeStatus());
	} catch (error) {
		return apiError(error);
	}
};
