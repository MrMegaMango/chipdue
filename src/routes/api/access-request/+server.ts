import type { RequestHandler } from './$types';
import { adminAccessRequestLocation } from '$lib/server/access-request';
import { apiError, privateResponseHeaders } from '$lib/server/http';

export const GET: RequestHandler = () => {
	try {
		return new Response(null, {
			status: 303,
			headers: {
				...privateResponseHeaders,
				location: adminAccessRequestLocation()
			}
		});
	} catch (error) {
		return apiError(error);
	}
};
