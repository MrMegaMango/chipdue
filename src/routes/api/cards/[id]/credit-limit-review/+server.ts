import type { RequestHandler } from './$types';
import { updateCardCreditLimitReview } from '$lib/server/cards';
import { apiError, apiJson, assertSameOrigin, parseId, readJson } from '$lib/server/http';
import { updateCardCreditLimitReviewSchema } from '$lib/server/schemas';

export const PATCH: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		const id = parseId(params.id);
		const changes = await readJson(request, updateCardCreditLimitReviewSchema);
		return apiJson({ card: await updateCardCreditLimitReview(id, changes) });
	} catch (error) {
		return apiError(error);
	}
};
