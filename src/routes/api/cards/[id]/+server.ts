import type { RequestHandler } from './$types';
import { deleteManualCard, getCard, updateManualCard } from '$lib/server/cards';
import {
	apiError,
	apiJson,
	assertSameOrigin,
	noContent,
	parseId,
	readJson
} from '$lib/server/http';
import { updateManualCardSchema } from '$lib/server/schemas';

export const GET: RequestHandler = ({ params }) => {
	try {
		return apiJson({ card: getCard(parseId(params.id)) });
	} catch (error) {
		return apiError(error);
	}
};

export const PATCH: RequestHandler = async ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		const id = parseId(params.id);
		const changes = await readJson(request, updateManualCardSchema);
		return apiJson({ card: updateManualCard(id, changes) });
	} catch (error) {
		return apiError(error);
	}
};

export const DELETE: RequestHandler = ({ params, request, url }) => {
	try {
		assertSameOrigin(request, url);
		deleteManualCard(parseId(params.id));
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
