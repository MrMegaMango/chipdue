import type { RequestHandler } from './$types';
import { z } from 'zod';
import { configureEtrade, etradeStatus, forgetEtradeConfiguration } from '$lib/server/etrade';
import { apiError, apiJson, assertSameOrigin, readJson } from '$lib/server/http';

const etradeConfigurationSchema = z
	.object({
		consumerKey: z
			.string()
			.min(8)
			.max(256)
			.regex(/^[\x21-\x7e]+$/),
		consumerSecret: z
			.string()
			.min(8)
			.max(256)
			.regex(/^[\x21-\x7e]+$/)
	})
	.strict();

export const PUT: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		const input = await readJson(request, etradeConfigurationSchema, 1024);
		await configureEtrade(input.consumerKey, input.consumerSecret);
		return apiJson(await etradeStatus());
	} catch (error) {
		return apiError(error);
	}
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		await forgetEtradeConfiguration();
		return apiJson(await etradeStatus());
	} catch (error) {
		return apiError(error);
	}
};
