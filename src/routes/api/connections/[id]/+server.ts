import type { RequestHandler } from './$types';
import { disconnectFinancialConnection } from '$lib/server/financial-connections';
import { apiError, assertSameOrigin, noContent, parseId } from '$lib/server/http';

export const DELETE: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		await disconnectFinancialConnection(parseId(params.id));
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
