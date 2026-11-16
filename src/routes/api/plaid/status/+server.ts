import type { RequestHandler } from './$types';
import { apiError, apiJson } from '#lib/server/http.ts';
import { plaidConfigurationStatus } from '#lib/server/plaid.ts';
import { listPlaidConnections } from '#lib/server/plaid-store.ts';

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
