import type { RequestHandler } from './$types';
import type { BuyTimingRange, BuyTimingSchedule } from '$lib/buy-timing';
import { accountBuyTiming } from '$lib/server/buy-timing-service';
import { AppError } from '$lib/server/errors';
import { apiError, apiJson, parseId } from '$lib/server/http';

const RANGES = new Set<BuyTimingRange>(['1M', '3M', 'YTD', '1Y', 'ALL']);
const SCHEDULES = new Set<BuyTimingSchedule>(['monthly', 'weekly', 'biweekly']);

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const accountId = parseId(params.id);
		const range = (url.searchParams.get('range') ?? 'ALL') as BuyTimingRange;
		const schedule = (url.searchParams.get('schedule') ?? 'monthly') as BuyTimingSchedule;
		if (
			[...url.searchParams.keys()].some((key) => key !== 'range' && key !== 'schedule') ||
			url.searchParams.getAll('range').length > 1 ||
			url.searchParams.getAll('schedule').length > 1 ||
			!RANGES.has(range) ||
			!SCHEDULES.has(schedule)
		) {
			throw new AppError(
				'INVALID_REQUEST',
				'Choose a supported range and investment schedule.',
				400
			);
		}
		return apiJson(await accountBuyTiming(accountId, range, schedule));
	} catch (error) {
		return apiError(error);
	}
};
