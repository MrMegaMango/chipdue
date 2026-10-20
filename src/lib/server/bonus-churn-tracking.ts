import {
	resolveAutomaticBonusChurn,
	type BonusChurnActivity,
	type BonusChurnAutomationResult
} from '$lib/bonus-churn-automatic';
import { cardsFromRows, cardTransactionsFromRow } from './cards';
import {
	bonusesFromRows,
	financialAccountsFromRows,
	financialAccountTransactionsFromRow
} from './financial-records';
import { listRecordRows } from './record-rows';

// Read the stored history, not the paginated activity preview. Provider syncs already
// maintain this data; viewing or polling tracking must not request a bank refresh.
const HISTORY_LIMIT = 10_000;

export async function listAutomaticBonusTracking(): Promise<
	Record<string, BonusChurnAutomationResult>
> {
	const rows = await listRecordRows();
	const bonuses = bonusesFromRows(rows);
	const accounts = financialAccountsFromRows(rows);
	const cards = cardsFromRows(rows);
	const rowsById = new Map(rows.map((row) => [row.id, row]));
	const accountsById = new Map(accounts.map((account) => [account.id, account]));
	const cardsById = new Map(cards.map((card) => [card.id, card]));
	type History = Pick<BonusChurnActivity, 'transactions' | 'activityState' | 'lastSyncedAt'>;
	const histories = new Map<string, Promise<History>>();

	const resolved = await Promise.all(
		bonuses.map(async (bonus) => {
			// Only follow links present in the current tenant's inventory.
			const account = accountsById.get(bonus.accountId ?? '') ?? null;
			const card = cardsById.get(bonus.cardId ?? '') ?? null;
			const linked = account ?? card;
			let history: History = {
				transactions: [],
				activityState: linked?.source === 'connected' ? 'unavailable' : 'not_connected',
				lastSyncedAt: null
			};
			if (linked?.source === 'connected' && linked.transactionHistoryEnabled) {
				const key = `${account ? 'account' : 'card'}:${linked.id}`;
				let pending = histories.get(key);
				if (!pending) {
					pending = (async (): Promise<History> => {
						try {
							const row = rowsById.get(linked.id)!;
							const result = account
								? financialAccountTransactionsFromRow(row, HISTORY_LIMIT)
								: cardTransactionsFromRow(row, HISTORY_LIMIT);
							return {
								transactions: result.transactions,
								activityState:
									result.status === 'current' || result.status === 'historical_complete'
										? 'available'
										: 'unavailable',
								lastSyncedAt: result.lastSyncedAt
							};
						} catch {
							return { transactions: [], activityState: 'unavailable', lastSyncedAt: null };
						}
					})();
					histories.set(key, pending);
				}
				history = await pending;
			}
			const activity: BonusChurnActivity = { account, card, ...history };
			const result = resolveAutomaticBonusChurn(bonus, activity);
			// Reserve a uniquely matching credit for an explicitly saved payout too,
			// so it cannot become a second offer's inferred payment.
			const savedPayment =
				result.dateSources.paidDate === 'saved'
					? resolveAutomaticBonusChurn(
							{ ...bonus, paidDate: null },
							{
								...activity,
								transactions: activity.transactions.filter(
									(transaction) => transaction.date === result.paidDate
								)
							}
						)
					: null;
			const claimedTransactionId = result.payoutTransactionId ?? savedPayment?.payoutTransactionId;
			return { bonus, activity, result, claimedTransactionId };
		})
	);
	// A single posted credit cannot establish payment for two different saved offers.
	const claimed = new Map<string, number>();
	for (const { claimedTransactionId } of resolved) {
		if (claimedTransactionId) {
			claimed.set(claimedTransactionId, (claimed.get(claimedTransactionId) ?? 0) + 1);
		}
	}
	return Object.fromEntries(
		resolved.map(({ bonus, activity, result }) => [
			bonus.id,
			result.payoutTransactionId && (claimed.get(result.payoutTransactionId) ?? 0) > 1
				? resolveAutomaticBonusChurn(bonus, { ...activity, payoutAmbiguous: true })
				: result
		])
	);
}
