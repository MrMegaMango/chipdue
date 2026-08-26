import type { RequestHandler } from './$types';
import { getInstallId } from '$lib/server/database';
import { apiError, apiJson } from '$lib/server/http';
import { isPlaidConfigured } from '$lib/server/plaid';

export const GET: RequestHandler = () => {
	try {
		getInstallId();
		return apiJson({ ok: true, storage: 'local-encrypted', plaidConfigured: isPlaidConfigured() });
	} catch (error) {
		return apiError(error);
	}
};
