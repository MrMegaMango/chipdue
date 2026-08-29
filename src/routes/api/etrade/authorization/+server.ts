import type { RequestHandler } from './$types';
import { z } from 'zod';
import {
	beginEtradeAuthorization,
	completeEtradeAuthorization,
	disconnectEtrade,
	etradeStatus
} from '$lib/server/etrade';
import { apiError, apiJson, assertSameOrigin, readJson } from '$lib/server/http';

const verifierSchema = z
	.object({
		verifier: z
			.string()
			.trim()
			.min(4)
			.max(64)
			.regex(/^[A-Za-z0-9]+$/)
	})
	.strict();

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		return apiJson(await beginEtradeAuthorization());
	} catch (error) {
		return apiError(error);
	}
};

export const PUT: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		const input = await readJson(request, verifierSchema, 512);
		return apiJson(await completeEtradeAuthorization(input.verifier));
	} catch (error) {
		return apiError(error);
	}
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		const result = await disconnectEtrade();
		return apiJson({ ...result, status: await etradeStatus() });
	} catch (error) {
		return apiError(error);
	}
};
