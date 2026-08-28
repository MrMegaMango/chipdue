import type { RequestHandler } from './$types';
import { apiError, apiJson } from '$lib/server/http';
import { syncAllPlaidItems } from '$lib/server/plaid';
import {
	assertScheduledSyncRequest,
	claimScheduledSync,
	completeScheduledSync,
	failScheduledSync,
	scheduledSyncWindow,
	type ScheduledSyncWindow
} from '$lib/server/scheduled-sync';

export const GET: RequestHandler = async ({ request, params }) => {
	let window: ScheduledSyncWindow | null = null;
	try {
		assertScheduledSyncRequest(request);
		window = scheduledSyncWindow(params.candidate);
		if (!window) return apiJson({ ok: true, skipped: 'outside-pacific-window' });
		if (!(await claimScheduledSync(window))) {
			return apiJson({ ok: true, skipped: 'already-running-or-complete' });
		}

		const result = await syncAllPlaidItems();
		await completeScheduledSync(window);
		return apiJson({ ok: true, period: window.period, ...result });
	} catch (error) {
		if (window) {
			try {
				await failScheduledSync(window);
			} catch {
				// Preserve the original synchronization error.
			}
		}
		return apiError(error);
	}
};
