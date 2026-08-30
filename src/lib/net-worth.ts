import type { AccountBalanceHistoryPoint, FinancialAccount } from '$lib/types';

export type NetWorthAccount = Pick<
	FinancialAccount,
	| 'id'
	| 'nickname'
	| 'accountType'
	| 'status'
	| 'hidden'
	| 'currency'
	| 'currentBalanceCents'
	| 'balanceHistory'
	| 'lastSyncedAt'
	| 'updatedAt'
>;

export type NetWorthAccountBreakdown = {
	accountId: string;
	nickname: string;
	accountType: FinancialAccount['accountType'];
	balanceCents: number;
	changeCents: number | null;
	estimated: boolean;
	backfilled: boolean;
	sourceRecordedAt: string;
};

export type NetWorthHistoryPoint = {
	recordedAt: string;
	netWorthCents: number;
	assetCents: number;
	changeCents: number | null;
	estimated: boolean;
	accounts: NetWorthAccountBreakdown[];
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

export type NetWorthHistoryRange = '1W' | '1M' | '3M' | '1Y' | 'ALL';

export type NetWorthDateAxisTick = {
	recordedAt: string;
	position: number;
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

export function netWorthPointsForRange(
	points: NetWorthHistoryPoint[],
	range: NetWorthHistoryRange
): NetWorthHistoryPoint[] {
	if (range === 'ALL' || points.length < 2) return points;
	const latest = new Date(points.at(-1)!.recordedAt).getTime();
	const days = range === '1W' ? 7 : range === '1M' ? 30 : range === '3M' ? 90 : 365;
	const cutoff = latest - days * 24 * 60 * 60 * 1_000;
	const filtered = points.filter((point) => new Date(point.recordedAt).getTime() >= cutoff);
	return filtered.length > 0 ? filtered : points.slice(-1);
}

export function netWorthDateAxisTicks(
	points: NetWorthHistoryPoint[],
	tickCount = 5
): NetWorthDateAxisTick[] {
	if (points.length === 0) return [];
	const firstTime = new Date(points[0].recordedAt).getTime();
	const lastTime = new Date(points.at(-1)!.recordedAt).getTime();
	if (points.length === 1 || firstTime === lastTime) {
		return [{ recordedAt: points.at(-1)!.recordedAt, position: 0.5 }];
	}
	const count = Math.max(2, Math.floor(tickCount));
	return Array.from({ length: count }, (_, index) => {
		const position = index / (count - 1);
		return {
			recordedAt: new Date(firstTime + (lastTime - firstTime) * position).toISOString(),
			position
		};
	});
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
	const previousBalances = new Map<string, number>();
	let previousNetWorthCents: number | null = null;

	const points = days.map<NetWorthHistoryPoint>((day) => {
		let estimated = false;
		const accountBalances = accountSnapshots.map(({ account, snapshots }) => {
			const knownSnapshot = snapshots.findLast((snapshot) => snapshot.day <= day);
			const snapshot = knownSnapshot ?? snapshots[0];
			const accountEstimated = !knownSnapshot || snapshot.source === 'estimated';
			if (accountEstimated) estimated = true;
			const previousBalance = previousBalances.get(account.id);
			const balance: NetWorthAccountBreakdown = {
				accountId: account.id,
				nickname: account.nickname,
				accountType: account.accountType,
				balanceCents: snapshot.balanceCents,
				changeCents: previousBalance === undefined ? null : snapshot.balanceCents - previousBalance,
				estimated: accountEstimated,
				backfilled: !knownSnapshot,
				sourceRecordedAt: snapshot.recordedAt
			};
			previousBalances.set(account.id, snapshot.balanceCents);
			return balance;
		});
		const assetCents = accountBalances.reduce((total, account) => total + account.balanceCents, 0);
		const netWorthCents = assetCents - cardBalanceCents;
		const point: NetWorthHistoryPoint = {
			recordedAt: `${day}T12:00:00.000Z`,
			netWorthCents,
			assetCents,
			changeCents: previousNetWorthCents === null ? null : netWorthCents - previousNetWorthCents,
			estimated,
			accounts: accountBalances
		};
		previousNetWorthCents = netWorthCents;
		return point;
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
