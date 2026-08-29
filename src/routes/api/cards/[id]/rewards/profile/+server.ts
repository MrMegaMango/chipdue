import type { RequestHandler } from './$types';
import { applyAutomaticCardRewardProfile } from '$lib/server/cards';
import { apiError, apiJson, assertSameOrigin, parseId, readJson } from '$lib/server/http';
import { applyCardRewardProfileSchema } from '$lib/server/schemas';

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
