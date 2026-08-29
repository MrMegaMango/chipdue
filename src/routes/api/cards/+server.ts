import type { RequestHandler } from './$types';
import { createManualCard, listCards } from '$lib/server/cards';
import { financialConnectionsStatus } from '$lib/server/financial-connections';
import { apiError, apiJson, assertSameOrigin, readJson } from '$lib/server/http';
import { createManualCardSchema } from '$lib/server/schemas';

export const GET: RequestHandler = async () => {
	try {
		const [cards, status] = await Promise.all([listCards(), financialConnectionsStatus()]);
		const lastSyncedAt =
			status.connections
				.map((connection) => connection.lastSyncedAt)
				.filter((value): value is string => value !== null)
				.sort()
				.at(-1) ?? null;
		return apiJson({
			cards,
			connections: {
				providers: status.providers,
				connected: status.connections.length,
				lastSyncedAt
			}
		});
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		const input = await readJson(request, createManualCardSchema);
		return apiJson({ card: await createManualCard(input) }, 201);
	} catch (error) {
		return apiError(error);
	}
};
