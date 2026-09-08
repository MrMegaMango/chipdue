import { z } from 'zod';
import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin, readJson } from '$lib/server/http';
import {
	resumeMethodCreditScoreOnboarding,
	startMethodCreditScoreOnboarding
} from '$lib/server/method-credit-score';
import { startMethodCreditScoreSchema } from '$lib/server/method-credit-score-schemas';

const requestSchema = z.discriminatedUnion('action', [
	startMethodCreditScoreSchema.extend({ action: z.literal('start') }),
	z.object({ action: z.literal('resume') })
]);

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		const input = await readJson(request, requestSchema);
		const session =
			input.action === 'start'
				? await startMethodCreditScoreOnboarding(input)
				: await resumeMethodCreditScoreOnboarding();
		return apiJson({ session });
	} catch (error) {
		return apiError(error);
	}
};
