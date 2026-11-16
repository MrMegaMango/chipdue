import type { RequestHandler } from './$types';
import { updateCardRewards } from '#lib/server/cards.ts';
import { apiError, apiJson, assertSameOrigin, parseId, readJson } from '#lib/server/http.ts';
import { updateCardRewardsSchema } from '#lib/server/schemas.ts';

export const PATCH: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		const id = parseId(params.id);
		const changes = await readJson(request, updateCardRewardsSchema);
		return apiJson({ card: await updateCardRewards(id, changes) });
	} catch (error) {
		return apiError(error);
	}
};
