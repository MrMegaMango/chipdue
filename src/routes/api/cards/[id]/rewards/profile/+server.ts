import type { RequestHandler } from './$types';
import { applyAutomaticCardRewardProfile } from '#lib/server/cards.ts';
import { apiError, apiJson, assertSameOrigin, parseId, readJson } from '#lib/server/http.ts';
import { applyCardRewardProfileSchema } from '#lib/server/schemas.ts';

export const PUT: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		const id = parseId(params.id);
		const { profileId } = await readJson(request, applyCardRewardProfileSchema);
		return apiJson({ card: await applyAutomaticCardRewardProfile(id, profileId) });
	} catch (error) {
		return apiError(error);
	}
};
