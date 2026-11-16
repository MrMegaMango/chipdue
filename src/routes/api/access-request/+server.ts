import type { RequestHandler } from './$types';
import { adminAccessRequestLocation } from '#lib/server/access-request.ts';
import { apiError, privateResponseHeaders } from '#lib/server/http.ts';

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
