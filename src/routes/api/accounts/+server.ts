import type { RequestHandler } from './$types';
import { createFinancialAccount, listFinancialAccounts } from '$lib/server/financial-records';
import { addPublishedAccountApys } from '$lib/server/published-apy';
import { apiError, apiJson, assertSameOrigin, readJson } from '$lib/server/http';
import { createFinancialAccountSchema } from '$lib/server/schemas';

export const GET: RequestHandler = async () => {
	try {
		return apiJson({ accounts: await addPublishedAccountApys(await listFinancialAccounts()) });
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		const input = await readJson(request, createFinancialAccountSchema);
		return apiJson({ account: await createFinancialAccount(input) }, 201);
	} catch (error) {
		return apiError(error);
	}
};
