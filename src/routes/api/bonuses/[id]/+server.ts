import type { RequestHandler } from './$types';
import { deleteBonus, getBonus, updateBonus } from '$lib/server/financial-records';
import {
	apiError,
	apiJson,
	assertSameOrigin,
	noContent,
	parseId,
	readJson
} from '$lib/server/http';
import { updateBonusSchema } from '$lib/server/schemas';

export const GET: RequestHandler = async ({ params }) => {
	try {
		return apiJson({ bonus: await getBonus(parseId(params.id)) });
	} catch (error) {
		return apiError(error);
	}
};

export const PATCH: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		const changes = await readJson(request, updateBonusSchema);
		return apiJson({ bonus: await updateBonus(parseId(params.id), changes) });
	} catch (error) {
		return apiError(error);
	}
};

export const DELETE: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		await deleteBonus(parseId(params.id));
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
