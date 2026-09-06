import type { RequestHandler } from './$types';
import { deleteCreditScore, getCreditScore, updateCreditScore } from '$lib/server/credit-scores';
import {
	apiError,
	apiJson,
	assertSameOrigin,
	noContent,
	parseId,
	readJson
} from '$lib/server/http';
import { updateCreditScoreSchema } from '$lib/server/credit-score-schemas';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return apiJson({ entry: await getCreditScore(parseId(params.id)) });
	} catch (error) {
		return apiError(error);
	}
};

export const PATCH: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		const changes = await readJson(request, updateCreditScoreSchema);
		return apiJson({ entry: await updateCreditScore(parseId(params.id), changes) });
	} catch (error) {
		return apiError(error);
	}
};

export const DELETE: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		await deleteCreditScore(parseId(params.id));
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
