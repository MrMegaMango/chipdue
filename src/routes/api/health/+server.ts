import type { RequestHandler } from './$types';
import { apiError, apiJson } from '$lib/server/http';
import { isPlaidConfigured } from '$lib/server/plaid';
import { getRuntimeMode } from '$lib/server/runtime';

export const GET: RequestHandler = async () => {
	try {
		const mode = getRuntimeMode();
		return apiJson({
			ok: true,
			storage: mode === 'cloud' ? 'cloud-encrypted' : 'local-encrypted',
			plaidConfigured: isPlaidConfigured()
		});
	} catch (error) {
		return apiError(error);
	}
};
