import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin } from '#lib/server/http.ts';
import {
	activateMethodCreditScoreConnection,
	methodCreditScoreStatus
} from '#lib/server/method-credit-score.ts';

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		await activateMethodCreditScoreConnection();
		return apiJson({ connection: await methodCreditScoreStatus() });
	} catch (error) {
		return apiError(error);
	}
};
