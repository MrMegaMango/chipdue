import type { RequestHandler } from './$types';
import { financialConnectionsStatus } from '#lib/server/financial-connections.ts';
import { apiError, apiJson } from '#lib/server/http.ts';

export const GET: RequestHandler = async () => {
	try {
		return apiJson(await financialConnectionsStatus());
	} catch (error) {
		return apiError(error);
	}
};
