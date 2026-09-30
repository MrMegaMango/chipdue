import {
	DASHBOARD_ACTIVITY_LIMIT,
	type DashboardResponse,
	type DashboardResult
} from '$lib/dashboard';
import { cardsFromRows, cardTransactionsFromRow } from './cards';
import { asAppError } from './errors';
import { financialConnectionsStatus } from './financial-connections';
import { bonusesFromRows, financialAccountsFromRows } from './financial-records';
import { listRecordRows } from './record-rows';

async function section<T>(operation: () => T | Promise<T>): Promise<DashboardResult<T>> {
	try {
		return { ok: true, data: await operation() };
	} catch (error) {
		const safeError = asAppError(error);
		return { ok: false, error: { code: safeError.code, message: safeError.message } };
	}
}

export async function loadDashboard(
	options: { includeActivity?: boolean } = {}
): Promise<DashboardResponse> {
	// Share only this request's rows. Every refresh reads current tenant data again.
	const rows = await listRecordRows();
	const [cards, workspace] = await Promise.all([
		section(async () => {
			const cardViews = cardsFromRows(rows);
			const status = await financialConnectionsStatus();
			return {
				cards: cardViews,
				connections: {
					providers: status.providers,
					connected: status.connections.length,
					lastSyncedAt:
						status.connections
							.map((connection) => connection.lastSyncedAt)
							.filter((value): value is string => value !== null)
							.sort()
							.at(-1) ?? null
				}
			};
		}),
		section(() => ({
			// The dashboard uses balances/history, so it needs no external APY lookup.
			accounts: financialAccountsFromRows(rows),
			bonuses: bonusesFromRows(rows)
		}))
	]);
	const recentActivity: DashboardResponse['recentActivity'] = {};
	if (options.includeActivity && cards.ok) {
		const byId = new Map(rows.map((row) => [row.id, row]));
		await Promise.all(
			cards.data.cards
				.filter((card) => card.source === 'connected' && card.transactionHistoryEnabled)
				.map(async (card) => {
					recentActivity[card.id] = await section(() =>
						cardTransactionsFromRow(byId.get(card.id)!, DASHBOARD_ACTIVITY_LIMIT)
					);
				})
		);
	}
	return { cards, workspace, recentActivity };
}
