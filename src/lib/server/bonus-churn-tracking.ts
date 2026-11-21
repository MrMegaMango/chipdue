import {
	resolveAutomaticBonusChurn,
	type BonusChurnActivity,
	type BonusChurnAutomationResult
} from '#lib/bonus-churn-automatic.ts';
import { getBonusChurnToday } from '#lib/bonus-churn.ts';
import { buildBonusOfferDraft, resolveBonusOffer } from '#lib/bonus-offers.ts';
import { calculateEtradeFunding } from '#lib/etrade-funding.ts';
import type { AccountBonus, FinancialAccount } from '#lib/types.ts';
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

type History = Pick<BonusChurnActivity, 'transactions' | 'activityState' | 'lastSyncedAt'> & {
	coverageStartDate?: string | null;
	historySyncedAt?: string | null;
};

function fundingFor(
	bonus: AccountBonus,
	account: FinancialAccount | null,
	history: History,
	today: string
) {
	const offer = resolveBonusOffer(bonus, account);
	if (offer?.activityMode !== 'funding' || !account || !bonus.openedDate) return {};
	const start = bonus.openedDate;
	const deadline =
		bonus.requirementDeadline ?? buildBonusOfferDraft(offer, start)?.requirementDeadline;
	const asOf = history.historySyncedAt ?? null;
	const syncedDay = asOf ? getBonusChurnToday(new Date(asOf)) : null;
	const incomplete =
		history.activityState !== 'available' ||
		!history.coverageStartDate ||
		history.coverageStartDate > start;
	if (
		incomplete ||
		!deadline ||
		!syncedDay ||
		syncedDay < start ||
		today < start ||
		account.currency !== bonus.currency
	) {
		return { funding: null, fundingSyncedAt: asOf };
	}
	const through = [today, syncedDay, deadline].sort()[0];
	return {
		funding: calculateEtradeFunding(history.transactions, start, through, bonus.currency),
		fundingSyncedAt: asOf
	};
}

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
	const histories = new Map<string, Promise<History>>();
	const today = getBonusChurnToday();

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
								...result,
								activityState:
									result.status === 'current' || result.status === 'historical_complete'
										? 'available'
										: 'unavailable'
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
			return {
				bonus,
				activity,
				result,
				claimedTransactionId,
				funding: fundingFor(bonus, account, history, today)
			};
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
		resolved.map(({ bonus, activity, result, funding }) => [
			bonus.id,
			{
				...(result.payoutTransactionId && (claimed.get(result.payoutTransactionId) ?? 0) > 1
					? resolveAutomaticBonusChurn(bonus, { ...activity, payoutAmbiguous: true })
					: result),
				...funding
			}
		])
	);
}
