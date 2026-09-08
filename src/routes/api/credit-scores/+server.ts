import type { RequestHandler } from './$types';
import { createCreditScoreSchema } from '$lib/server/credit-score-schemas';
import { createCreditScore, listCreditScores } from '$lib/server/credit-scores';
import { apiError, apiJson, assertSameOrigin, readJson } from '$lib/server/http';
import { methodCreditScoreStatus } from '$lib/server/method-credit-score';

export const GET: RequestHandler = async () => {
	try {
		const [entries, connection] = await Promise.all([
			listCreditScores(),
			methodCreditScoreStatus()
		]);
		return apiJson({ entries, connection });
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
