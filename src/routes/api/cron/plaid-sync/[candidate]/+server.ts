import type { RequestHandler } from './$types';
import { syncAllTenantFinancialConnections } from '#lib/server/financial-connections.ts';
import { apiError, apiJson } from '#lib/server/http.ts';
import { syncAllTenantMethodCreditScores } from '#lib/server/method-credit-score.ts';
import {
	assertScheduledSyncRequest,
	claimScheduledSync,
	completeScheduledSync,
	failScheduledSync,
	scheduledSyncWindow,
	type ScheduledSyncWindow
} from '#lib/server/scheduled-sync.ts';

export const GET: RequestHandler = async ({ request, params }) => {
	let window: ScheduledSyncWindow | null = null;
	try {
		assertScheduledSyncRequest(request);
		window = scheduledSyncWindow(params.candidate);
		if (!window) return apiJson({ ok: true, skipped: 'outside-pacific-window' });
		if (!(await claimScheduledSync(window))) {
			return apiJson({ ok: true, skipped: 'already-running-or-complete' });
		}

		const [result, creditScores] = await Promise.all([
			syncAllTenantFinancialConnections(),
			syncAllTenantMethodCreditScores()
		]);
		await completeScheduledSync(window);
		return apiJson({ ok: true, period: window.period, ...result, creditScores });
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
