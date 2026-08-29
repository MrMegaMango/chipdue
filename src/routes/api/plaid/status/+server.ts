import type { RequestHandler } from './$types';
import { apiError, apiJson } from '$lib/server/http';
import { plaidConfigurationStatus } from '$lib/server/plaid';
import { listPlaidConnections } from '$lib/server/plaid-store';

export const GET: RequestHandler = async () => {
	try {
		const configuration = await plaidConfigurationStatus();
		return apiJson({
			...configuration,
			connections: await listPlaidConnections()
		});
	} catch (error) {
		return apiError(error);
	}
};
