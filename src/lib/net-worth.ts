import type { AccountBalanceHistoryPoint, FinancialAccount } from '$lib/types';

export type NetWorthAccount = Pick<
	FinancialAccount,
	| 'id'
	| 'status'
	| 'hidden'
	| 'currency'
	| 'currentBalanceCents'
	| 'balanceHistory'
	| 'lastSyncedAt'
	| 'updatedAt'
>;

export type NetWorthHistoryPoint = {
	recordedAt: string;
	netWorthCents: number;
	estimated: boolean;
};

export type NetWorthHistory = {
	points: NetWorthHistoryPoint[];
	currentNetWorthCents: number | null;
	currentAssetCents: number | null;
	cardBalanceCents: number;
	accountCount: number;
	excludedCurrencyCount: number;
	includesEstimates: boolean;
};

type DailySnapshot = AccountBalanceHistoryPoint & { day: string };

function validTimestamp(value: string | null): value is string {
	return value !== null && Number.isFinite(Date.parse(value));
}

function dayFor(value: string): string {
	return new Date(value).toISOString().slice(0, 10);
}

function dailySnapshots(account: NetWorthAccount): DailySnapshot[] {
	if (account.currentBalanceCents === null) return [];
	const snapshots = account.balanceHistory
		.filter((point) => Number.isSafeInteger(point.balanceCents) && validTimestamp(point.recordedAt))
		.map((point) => ({ ...point, day: dayFor(point.recordedAt) }));
	const currentRecordedAt = validTimestamp(account.lastSyncedAt)
		? account.lastSyncedAt
		: validTimestamp(account.updatedAt)
			? account.updatedAt
			: new Date().toISOString();
	snapshots.push({
		recordedAt: currentRecordedAt,
		day: dayFor(currentRecordedAt),
		balanceCents: account.currentBalanceCents,
		netContributionsCents: null,
		source: 'observed'
	});

	const byDay = new Map<string, DailySnapshot>();
	for (const snapshot of snapshots.sort((left, right) =>
		left.recordedAt.localeCompare(right.recordedAt)
	)) {
		byDay.set(snapshot.day, snapshot);
	}
	return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day));
}

export function buildNetWorthHistory(
	accounts: NetWorthAccount[],
	cardBalanceCents = 0
): NetWorthHistory {
	const visibleAccounts = accounts.filter(
		(account) =>
			account.status === 'active' && !account.hidden && account.currentBalanceCents !== null
	);
	const supportedAccounts = visibleAccounts.filter((account) => account.currency === 'USD');
	const accountSnapshots = supportedAccounts
		.map((account) => ({ account, snapshots: dailySnapshots(account) }))
		.filter(({ snapshots }) => snapshots.length > 0);
	const days = [
		...new Set(accountSnapshots.flatMap(({ snapshots }) => snapshots.map((point) => point.day)))
	].sort();

	const points = days.map<NetWorthHistoryPoint>((day) => {
		let estimated = false;
		let assetCents = 0;
		for (const { snapshots } of accountSnapshots) {
			const knownSnapshot = snapshots.findLast((snapshot) => snapshot.day <= day);
			const snapshot = knownSnapshot ?? snapshots[0];
			if (!knownSnapshot || snapshot.source === 'estimated') estimated = true;
			assetCents += snapshot.balanceCents;
		}
		return {
			recordedAt: `${day}T12:00:00.000Z`,
			netWorthCents: assetCents - cardBalanceCents,
			estimated
		};
	});
	const currentAssetCents =
		supportedAccounts.length > 0
			? supportedAccounts.reduce((total, account) => total + (account.currentBalanceCents ?? 0), 0)
			: null;

	return {
		points,
		currentNetWorthCents: currentAssetCents === null ? null : currentAssetCents - cardBalanceCents,
		currentAssetCents,
		cardBalanceCents,
		accountCount: supportedAccounts.length,
		excludedCurrencyCount: visibleAccounts.length - supportedAccounts.length,
		includesEstimates: points.some((point) => point.estimated)
	};
}
