import type { RequestHandler } from './$types';
import { listCardTransactions } from '$lib/server/cards';
import { AppError } from '$lib/server/errors';
import { apiError, apiJson, parseId } from '$lib/server/http';

function transactionLimit(url: URL): number {
	if ([...url.searchParams.keys()].some((name) => name !== 'limit')) {
		throw new AppError('INVALID_REQUEST', 'The request is invalid.', 400);
	}
	const values = url.searchParams.getAll('limit');
	if (values.length === 0) return 500;
	if (values.length !== 1 || !/^\d+$/.test(values[0])) {
		throw new AppError('INVALID_REQUEST', 'The request is invalid.', 400);
	}
	const limit = Number(values[0]);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
		throw new AppError('INVALID_REQUEST', 'The request is invalid.', 400);
	}
	return limit;
}

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		return apiJson(await listCardTransactions(parseId(params.id), transactionLimit(url)));
	} catch (error) {
		return apiError(error);
	}
};
