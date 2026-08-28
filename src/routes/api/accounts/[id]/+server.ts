import type { RequestHandler } from './$types';
import {
	deleteFinancialAccount,
	getFinancialAccount,
	updateFinancialAccount
} from '$lib/server/financial-records';
import {
	apiError,
	apiJson,
	assertSameOrigin,
	noContent,
	parseId,
	readJson
} from '$lib/server/http';
import { updateFinancialAccountSchema } from '$lib/server/schemas';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return apiJson({ account: await getFinancialAccount(parseId(params.id)) });
	} catch (error) {
		return apiError(error);
	}
};

export const PATCH: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		const changes = await readJson(request, updateFinancialAccountSchema);
		return apiJson({ account: await updateFinancialAccount(parseId(params.id), changes) });
	} catch (error) {
		return apiError(error);
	}
};

export const DELETE: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		await deleteFinancialAccount(parseId(params.id));
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
