import type { RequestHandler } from './$types';
import { AppError } from '$lib/server/errors';
import { apiError, apiJson } from '$lib/server/http';
import { spyBenchmarkSeries } from '$lib/server/market-history';

export const GET: RequestHandler = async ({ url }) => {
	try {
		if (
			[...url.searchParams.keys()].some((key) => key !== 'start' && key !== 'end') ||
			url.searchParams.getAll('start').length !== 1 ||
			url.searchParams.getAll('end').length !== 1
		) {
			throw new AppError('INVALID_REQUEST', 'Only start and end dates are accepted.', 400);
		}
		return apiJson(
			await spyBenchmarkSeries(url.searchParams.get('start'), url.searchParams.get('end'))
		);
	} catch (error) {
		return apiError(error);
	}
};
