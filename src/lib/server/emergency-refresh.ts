import { waitUntil } from '@vercel/functions';
import { publishEmergencySnapshot } from './emergency-snapshot';
import { emergencyStorageConfigured } from './emergency-store';
import { listRecordRows, type PrivateRecordRow } from './record-rows';
import { currentTenantId } from './tenant';

interface SnapshotRefresh {
	rows?: PrivateRecordRow[];
	capturedAt: number;
}

interface RefreshWork {
	pending: SnapshotRefresh | undefined;
	work: Promise<void>;
}

const refreshes = new Map<string, RefreshWork>();

/** Backup failure must not turn a successful financial update into a failed request. */
export async function refreshEmergencySnapshot(
	rows?: PrivateRecordRow[],
	capturedAt = Date.now()
): Promise<void> {
	if (!emergencyStorageConfigured()) return;
	let tenantId: string;
	try {
		tenantId = currentTenantId();
	} catch {
		console.error('The emergency financial copy could not be refreshed.');
		return;
	}
	let refresh = refreshes.get(tenantId);
	if (refresh) {
		const pending = refresh.pending;
		if (!pending) refresh.pending = { rows, capturedAt };
		else if (!rows || !pending.rows) {
			// A mutation needs a fresh read even if a dashboard request also supplied rows.
			refresh.pending = { capturedAt: Math.max(capturedAt, pending.capturedAt) };
		} else if (capturedAt > pending.capturedAt) refresh.pending = { rows, capturedAt };
	} else {
		const queued: RefreshWork = {
			pending: { rows, capturedAt },
			work: Promise.resolve()
		};
		refreshes.set(tenantId, queued);
		// Share overlapping work within this instance; Blob's ETag check still guards
		// writes from other instances. Keep the final pending update rather than dropping it.
		queued.work = Promise.resolve().then(async () => {
			try {
				while (queued.pending) {
					const next = queued.pending;
					queued.pending = undefined;
					try {
						const readStartedAt = next.rows ? next.capturedAt : Date.now();
						await publishEmergencySnapshot(next.rows ?? (await listRecordRows()), readStartedAt);
					} catch {
						console.error('The emergency financial copy could not be refreshed.');
					}
				}
			} finally {
				refreshes.delete(tenantId);
			}
		});
		refresh = queued;
	}
	// Keep the response independent of Blob latency while Vercel retains the task.
	if (process.env.VERCEL === '1') waitUntil(refresh.work);
	else await refresh.work;
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
