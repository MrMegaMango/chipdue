import type { RequestHandler } from './$types';
import { createBonus, listBonuses } from '#lib/server/financial-records.ts';
import { apiError, apiJson, assertSameOrigin, readJson } from '#lib/server/http.ts';
import { createBonusSchema } from '#lib/server/schemas.ts';

export const GET: RequestHandler = async () => {
	try {
		return apiJson({ bonuses: await listBonuses() });
	} catch (error) {
		return apiError(error);
	}
};

export const POST: RequestHandler = async ({ request, url }) => {
	try {
		assertSameOrigin(request, url);
		const input = await readJson(request, createBonusSchema);
		return apiJson({ bonus: await createBonus(input) }, 201);
	} catch (error) {
		return apiError(error);
	}
};
