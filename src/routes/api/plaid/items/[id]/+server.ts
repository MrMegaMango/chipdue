import type { RequestHandler } from './$types';
import { disconnectFinancialConnection } from '#lib/server/financial-connections.ts';
import { apiError, assertSameOrigin, noContent, parseId } from '#lib/server/http.ts';

export const DELETE: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		await disconnectFinancialConnection(parseId(params.id));
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
