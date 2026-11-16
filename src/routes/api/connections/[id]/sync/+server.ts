import type { RequestHandler } from './$types';
import { syncFinancialConnection } from '#lib/server/financial-connections.ts';
import { apiError, apiJson, assertSameOrigin, parseId } from '#lib/server/http.ts';

export const POST: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(
			await syncFinancialConnection(parseId(params.id), {
				afterLink: url.searchParams.get('afterLink') === 'true'
			})
		);
	} catch (error) {
		return apiError(error);
	}
};
