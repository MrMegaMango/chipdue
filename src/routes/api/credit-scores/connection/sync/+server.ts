import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin } from '#lib/server/http.ts';
import {
	methodCreditScoreStatus,
	syncMethodCreditScores
} from '#lib/server/method-credit-score.ts';

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		const result = await syncMethodCreditScores();
		return apiJson({ ...result, connection: await methodCreditScoreStatus() });
	} catch (error) {
		return apiError(error);
	}
};
