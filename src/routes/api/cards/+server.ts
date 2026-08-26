import type { RequestHandler } from './$types';
import { createManualCard, listCards } from '$lib/server/cards';
import { apiError, apiJson, assertSameOrigin, readJson } from '$lib/server/http';
import { createManualCardSchema } from '$lib/server/schemas';
import { isPlaidConfigured } from '$lib/server/plaid';
import { listPlaidConnections } from '$lib/server/plaid-store';

export const GET: RequestHandler = () => {
	try {
		const connections = listPlaidConnections();
		const lastSyncedAt =
			connections
				.map((connection) => connection.lastSyncedAt)
				.filter((value): value is string => value !== null)
				.sort()
				.at(-1) ?? null;
		return apiJson({
			cards: listCards(),
			plaid: {
				configured: isPlaidConfigured(),
				connectedItems: connections.length,
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
		return apiJson({ card: createManualCard(input) }, 201);
	} catch (error) {
		return apiError(error);
	}
};
