import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin } from '$lib/server/http';
import {
	activateMethodCreditScoreConnection,
	methodCreditScoreStatus
} from '$lib/server/method-credit-score';

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		await activateMethodCreditScoreConnection();
		return apiJson({ connection: await methodCreditScoreStatus() });
	} catch (error) {
		return apiError(error);
	}
};
