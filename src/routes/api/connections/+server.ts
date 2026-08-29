import type { RequestHandler } from './$types';
import { financialConnectionsStatus } from '$lib/server/financial-connections';
import { apiError, apiJson } from '$lib/server/http';

export const GET: RequestHandler = async () => {
	try {
		return apiJson(await financialConnectionsStatus());
	} catch (error) {
		return apiError(error);
	}
};
