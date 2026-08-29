import type { RequestHandler } from './$types';
import { installationFinancialConnectionsStatus } from '$lib/server/financial-connections';
import { apiError, apiJson } from '$lib/server/http';
import { getRuntimeMode } from '$lib/server/runtime';

export const GET: RequestHandler = async () => {
	try {
		const mode = getRuntimeMode();
		return apiJson({
			ok: true,
			storage: mode === 'cloud' ? 'cloud-encrypted' : 'local-encrypted',
			financialConnections: installationFinancialConnectionsStatus()
		});
	} catch (error) {
		return apiError(error);
	}
};
