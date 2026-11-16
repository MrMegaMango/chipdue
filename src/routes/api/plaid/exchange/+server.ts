import type { RequestHandler } from './$types';
import { apiError, apiJson, assertSameOrigin, readJson } from '#lib/server/http.ts';
import { exchangePlaidPublicToken } from '#lib/server/plaid.ts';
import { exchangeTokenSchema } from '#lib/server/schemas.ts';

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		const input = await readJson(request, exchangeTokenSchema);
		return apiJson(
			await exchangePlaidPublicToken(input.publicToken, input.institutionName, {
				institutionId: input.institutionId,
				accounts: input.accounts
			}),
			201
		);
	} catch (error) {
		return apiError(error);
	}
};
