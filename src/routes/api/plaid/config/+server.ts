import type { RequestHandler } from './$types';
import { z } from 'zod';
import { apiError, apiJson, assertSameOrigin, readJson } from '$lib/server/http';
import { configurePersonalPlaid } from '$lib/server/plaid';

const plaidConfigurationSchema = z
	.object({
		clientId: z
			.string()
			.trim()
			.min(8)
			.max(128)
			.regex(/^[A-Za-z0-9_-]+$/),
		secret: z
			.string()
			.trim()
			.min(8)
			.max(256)
			.regex(/^[A-Za-z0-9_-]+$/)
	})
	.strict();

export const PUT: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		const input = await readJson(request, plaidConfigurationSchema, 1024);
		return apiJson(await configurePersonalPlaid(input.clientId, input.secret));
	} catch (error) {
		return apiError(error);
	}
};
