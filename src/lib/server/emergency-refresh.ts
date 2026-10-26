import { waitUntil } from '@vercel/functions';
import { publishEmergencySnapshot } from './emergency-snapshot';
import { emergencyStorageConfigured } from './emergency-store';
import { listRecordRows, type PrivateRecordRow } from './record-rows';

/** Backup failure must not turn a successful financial update into a failed request. */
export async function refreshEmergencySnapshot(
	rows?: PrivateRecordRow[],
	capturedAt = Date.now()
): Promise<void> {
	if (!emergencyStorageConfigured()) return;
	const work = (async () => {
		try {
			await publishEmergencySnapshot(rows ?? (await listRecordRows()), capturedAt);
		} catch {
			console.error('The emergency financial copy could not be refreshed.');
		}
	})();
	// Keep the response independent of Blob latency while Vercel retains the task.
	if (process.env.VERCEL === '1') waitUntil(work);
	else await work;
}

export function changesSavedFinances(method: string, route: string): boolean {
	if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
	if (route === '/api/connections/[id]' && method === 'PATCH') return false;
	if (/^\/api\/plaid\/items\/[^/]+\/(?:transactions\/)?update$/.test(route)) return false;
	return (
		/^\/api\/(?:cards|accounts|bonuses|connections)(?:\/|$)/.test(route) ||
		/^\/api\/plaid\/(?:exchange|sync|items)(?:\/|$)/.test(route)
	);
}
