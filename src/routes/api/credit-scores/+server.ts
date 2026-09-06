import type { RequestHandler } from './$types';
import { createCreditScoreSchema } from '$lib/server/credit-score-schemas';
import { createCreditScore, listCreditScores } from '$lib/server/credit-scores';
import { apiError, apiJson, assertSameOrigin, readJson } from '$lib/server/http';

export const GET: RequestHandler = async () => {
	try {
		return apiJson({ entries: await listCreditScores() });
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		const input = await readJson(request, createCreditScoreSchema);
		return apiJson({ entry: await createCreditScore(input) }, 201);
	} catch (error) {
		return apiError(error);
	}
};
