import type { RequestHandler } from './$types';
import { z } from 'zod';
import { disconnectFinancialConnection } from '$lib/server/financial-connections';
import { setPlaidConnectionSyncPaused } from '$lib/server/plaid-store';
import {
	apiError,
	apiJson,
	assertSameOrigin,
	noContent,
	parseId,
	readJson
} from '$lib/server/http';

const syncPreferenceSchema = z.strictObject({ syncPaused: z.boolean() });

export const PATCH: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		const id = parseId(params.id);
		const { syncPaused } = await readJson(request, syncPreferenceSchema);
		return apiJson({ connection: await setPlaidConnectionSyncPaused(id, syncPaused) });
	} catch (error) {
		return apiError(error);
	}
};

export const DELETE: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		await disconnectFinancialConnection(parseId(params.id));
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
