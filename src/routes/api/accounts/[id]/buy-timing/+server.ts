import type { RequestHandler } from './$types';
import type { BuyTimingRange, BuyTimingSchedule, BuyTimingWindow } from '$lib/buy-timing';
import { accountBuyTiming } from '$lib/server/buy-timing-service';
import { AppError } from '$lib/server/errors';
import { apiError, apiJson, parseId } from '$lib/server/http';

const RANGES = new Set<BuyTimingRange>(['1M', '3M', 'YTD', '1Y', 'ALL']);
const WINDOWS = new Set(['2', '3', '6']);
const SCHEDULES = new Set<BuyTimingSchedule>(['monthly', 'weekly', 'biweekly']);

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const accountId = parseId(params.id);
		const range = (url.searchParams.get('range') ?? 'ALL') as BuyTimingRange;
		const schedule = (url.searchParams.get('schedule') ?? 'biweekly') as BuyTimingSchedule;
		const window = url.searchParams.get('window') ?? '3';
		if (
			[...url.searchParams.keys()].some(
				(key) => key !== 'range' && key !== 'schedule' && key !== 'window'
			) ||
			url.searchParams.getAll('range').length > 1 ||
			url.searchParams.getAll('schedule').length > 1 ||
			url.searchParams.getAll('window').length > 1 ||
			!WINDOWS.has(window) ||
			!RANGES.has(range) ||
			!SCHEDULES.has(schedule)
		) {
			throw new AppError(
				'INVALID_REQUEST',
				'Choose a supported range, investment schedule, and comparison window.',
				400
			);
		}
		return apiJson(
			await accountBuyTiming(accountId, range, schedule, Number(window) as BuyTimingWindow)
		);
	} catch (error) {
		return apiError(error);
	}
};
