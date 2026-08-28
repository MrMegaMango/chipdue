import type { RequestHandler } from './$types';
import { listCards } from '$lib/server/cards';
import { apiError, privateResponseHeaders } from '$lib/server/http';
import { createCalendar } from '$lib/server/ics';

export const GET: RequestHandler = async ({ url }) => {
	try {
		const includeAmounts = url.searchParams.get('amounts') === '1';
		return new Response(createCalendar(await listCards(), new Date(), includeAmounts), {
			headers: {
				...privateResponseHeaders,
				'content-type': 'text/calendar; charset=utf-8',
				'content-disposition': 'attachment; filename="chipdue-payments.ics"'
			}
		});
	} catch (error) {
		return apiError(error);
	}
};
