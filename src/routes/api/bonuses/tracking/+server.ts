import type { RequestHandler } from './$types';
import { getBonusChurnToday } from '#lib/bonus-churn.ts';
import { listAutomaticBonusTracking } from '#lib/server/bonus-churn-tracking.ts';
import { privateFingerprint } from '#lib/server/crypto.ts';
import { apiError, apiJson, privateResponseHeaders } from '#lib/server/http.ts';
import { recordRowsRevision } from '#lib/server/record-rows.ts';

export const GET: RequestHandler = async ({ request }) => {
	try {
		// Read the revision first: a concurrent write may cause an extra refresh,
		// but can never label an older payload with the newer stored revision.
		const revision = await recordRowsRevision();
		const etag = `W/"${privateFingerprint(
			JSON.stringify([
				revision,
				getBonusChurnToday(),
				process.env.VERCEL_GIT_COMMIT_SHA ?? 'local'
			]),
			'bonus-tracking-v1'
		)}"`;
		const unchanged = request.headers
			.get('if-none-match')
			?.split(',')
			.some((value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.slice(2));
		if (unchanged) {
			return new Response(null, { status: 304, headers: { ...privateResponseHeaders, etag } });
		}
		const response = apiJson({ tracking: await listAutomaticBonusTracking() });
		response.headers.set('etag', etag);
		return response;
	} catch (error) {
		return apiError(error);
	}
};
