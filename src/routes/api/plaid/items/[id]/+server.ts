import type { RequestHandler } from './$types';
import { apiError, assertSameOrigin, noContent, parseId } from '$lib/server/http';
import { disconnectPlaidItem } from '$lib/server/plaid';

export const DELETE: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		await disconnectPlaidItem(parseId(params.id));
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
