import type { RequestHandler } from './$types';
import { apiError, apiJson } from '$lib/server/http';
import { isPlaidConfigured } from '$lib/server/plaid';
import { listPlaidConnections } from '$lib/server/plaid-store';

export const GET: RequestHandler = () => {
	try {
		return apiJson({ configured: isPlaidConfigured(), connections: listPlaidConnections() });
	} catch (error) {
		return apiError(error);
	}
};
