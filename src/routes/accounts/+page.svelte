<script lang="ts">
	import { asset, resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { getCompatibleBonusOffers } from '$lib/bonus-offers';
	import BalanceHistoryChart from '$lib/components/BalanceHistoryChart.svelte';
	import WorkspaceHeader from '$lib/components/WorkspaceHeader.svelte';
	import { financialProviderName } from '$lib/financial-data';
	import { cashSweepAction, isCashSweepSecurity } from '$lib/investment-display';
	import type {
		BrokerageOrder,
		BrokerageHistoryEstimateResponse,
		BrokerageOrdersResponse,
		FinancialConnection,
		FinancialAccount,
		FinancialAccountOwner,
		FinancialAccountStatus,
		FinancialAccountTransaction,
		FinancialAccountType,
		FinancialProviderStatus,
		InvestmentHolding
	} from '$lib/types';
	import '$lib/finance-pages.css';

	type RuntimeMode = 'local' | 'cloud';
	type SessionResponse = { mode: RuntimeMode; authenticated: boolean };
	type ConnectionsStatusResponse = {
		providers: FinancialProviderStatus[];
		connections: FinancialConnection[];
	};
	type AccountActivityResponse = {
		transactions: FinancialAccountTransaction[];
		status: FinancialAccount['transactionHistoryStatus'];
		lastSyncedAt: string | null;
	};
	type AccountForm = {
		nickname: string;
		institution: string;
		accountType: FinancialAccountType;
		ownerType: FinancialAccountOwner;
		status: FinancialAccountStatus;
		last4: string;
		currentBalance: number | undefined;
		apyPercent: number | undefined;
		costBasis: number | undefined;
		netContributions: number | undefined;
		openedDate: string;
		notes: string;
	};
	type AccountOwnershipGroup = {
		id: FinancialAccountOwner | 'all';
		title: string | null;
		accounts: FinancialAccount[];
	};

	const money = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: 2
	});
	const fullDate = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
	const dateTime = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
	const quantity = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
	const RECENT_ACTIVITY_LIMIT = 100;
	const COLLAPSED_ACTIVITY_COUNT = 5;

	let mode = $state<RuntimeMode | null>(null);
	let accounts = $state<FinancialAccount[]>([]);
	let loading = $state(true);
	let pageError = $state('');
	let dialogOpen = $state(false);
	let editingId = $state<string | null>(null);
	let form = $state<AccountForm>(blankForm());
	let formError = $state('');
	let busy = $state(false);
	let deletingId = $state<string | null>(null);
	let visibilityId = $state<string | null>(null);
	let showHidden = $state(false);
	let loggingOut = $state(false);
	let plaidConfigured = $state(false);
	let connections = $state<FinancialConnection[]>([]);
	let trackedBonusAccountIds = $state<string[]>([]);
	let activityByAccount = $state<Record<string, AccountActivityResponse>>({});
	let activityLoadingByAccount = $state<Record<string, boolean>>({});
	let activityErrorByAccount = $state<Record<string, boolean>>({});
	let expandedActivityAccountIds = $state<string[]>([]);
	let ordersByAccount = $state<Record<string, BrokerageOrdersResponse>>({});
	let ordersLoadingByAccount = $state<Record<string, boolean>>({});
	let ordersErrorByAccount = $state<Record<string, boolean>>({});
	let historyEstimateLoadingByAccount = $state<Record<string, boolean>>({});
	let historyEstimateErrorByAccount = $state<Record<string, string>>({});
	let historyEstimateNoteByAccount = $state<Record<string, string>>({});
	let syncing = $state(false);
	let toast = $state('');
	let toastError = $state(false);
	let undoHiddenAccountId = $state<string | null>(null);
	let supplementalRequestedAccountIds = $state<string[]>([]);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	const visibleAccounts = $derived(accounts.filter((account) => !account.hidden));
	const hiddenAccounts = $derived(accounts.filter((account) => account.hidden));
	const activeAccounts = $derived(visibleAccounts.filter((account) => account.status === 'active'));
	const syncedAccountCount = $derived(
		activeAccounts.filter((account) => account.source === 'connected').length
	);
	const accountGroups = $derived([
		{
			id: 'cash',
			title: 'Cash accounts',
			description: 'Checking, savings, and cash management.',
			separateByOwner: true,
			accounts: visibleAccounts.filter((account) => account.accountType !== 'brokerage')
		},
		{
			id: 'brokerage',
			title: 'Brokerage accounts',
			description: 'Investments, positions, and performance.',
			separateByOwner: false,
			accounts: visibleAccounts.filter((account) => account.accountType === 'brokerage')
		},
		...(showHidden
			? [
					{
						id: 'hidden',
						title: 'Hidden accounts',
						description: 'Excluded from your account map and summary totals.',
						separateByOwner: true,
						accounts: hiddenAccounts
					}
				]
			: [])
	]);
	const dialogAccount = $derived(
		editingId ? accounts.find((account) => account.id === editingId) : undefined
	);
	const knownBalances = $derived(
		activeAccounts.filter((account) => account.currentBalanceCents !== null)
	);
	const trackedBalanceCents = $derived(
		knownBalances.reduce((total, account) => total + (account.currentBalanceCents ?? 0), 0)
	);
	const brokerageReturnCents = $derived(
		activeAccounts
			.filter(
				(account) =>
					account.accountType === 'brokerage' &&
					account.currentBalanceCents !== null &&
					effectiveNetContributions(account) !== null
			)
			.reduce(
				(total, account) =>
					total + (account.currentBalanceCents ?? 0) - (effectiveNetContributions(account) ?? 0),
				0
			)
	);
	const brokeragePerformanceCount = $derived(
		activeAccounts.filter(
			(account) =>
				account.accountType === 'brokerage' &&
				account.currentBalanceCents !== null &&
				effectiveNetContributions(account) !== null
		).length
	);

	onMount(() => {
		void initialize();
	});

	function blankForm(): AccountForm {
		return {
			nickname: '',
			institution: '',
			accountType: 'checking',
			ownerType: 'personal',
			status: 'active',
			last4: '',
			currentBalance: undefined,
			apyPercent: undefined,
			costBasis: undefined,
			netContributions: undefined,
			openedDate: '',
			notes: ''
		};
	}

	function splitAccountsByOwner(
		groupAccounts: FinancialAccount[],
		separateByOwner: boolean
	): AccountOwnershipGroup[] {
		if (!separateByOwner) {
			return [{ id: 'all', title: null, accounts: sortAccountsByValue(groupAccounts) }];
		}
		return [
			{
				id: 'personal',
				title: 'Personal',
				accounts: sortAccountsByValue(
					groupAccounts.filter((account) => account.ownerType === 'personal')
				)
			},
			{
				id: 'business',
				title: 'Business',
				accounts: sortAccountsByValue(
					groupAccounts.filter((account) => account.ownerType === 'business')
				)
			}
		];
	}

	function sortAccountsByValue(groupAccounts: FinancialAccount[]): FinancialAccount[] {
		return [...groupAccounts].sort((left, right) => {
			if (left.currentBalanceCents === null) return right.currentBalanceCents === null ? 0 : 1;
			if (right.currentBalanceCents === null) return -1;
			return right.currentBalanceCents - left.currentBalanceCents;
		});
	}

	function institutionLogoUrl(account: FinancialAccount): string | null {
		if (account.institutionLogoUrl) return account.institutionLogoUrl;
		if (/\bvenmo\b/i.test(account.institution ?? '')) return asset('/brands/venmo.svg');
		if (/\bwells\s+fargo\b/i.test(account.institution ?? '')) {
			return asset('/brands/wells-fargo.svg');
		}
		if (/\bchase\b/i.test(account.institution ?? '')) return asset('/brands/chase.svg');
		return null;
	}

	async function initialize(): Promise<void> {
		loading = true;
		pageError = '';
		try {
			const session = await requestJson<SessionResponse>(resolve('/api/auth/session'));
			mode = session.mode;
			if (!session.authenticated) {
				window.location.assign(resolve('/'));
				return;
			}
			const [accountResponse, connectionsResponse, bonusResponse] = await Promise.all([
				requestJson<{ accounts: FinancialAccount[] }>(resolve('/api/accounts')),
				requestJson<ConnectionsStatusResponse>(resolve('/api/connections')),
				requestJson<{ bonuses: Array<{ accountId: string | null }> }>(resolve('/api/bonuses'))
			]);
			accounts = accountResponse.accounts;
			plaidConfigured =
				connectionsResponse.providers.find((status) => status.provider === 'plaid')?.configured ??
				false;
			connections = connectionsResponse.connections;
			trackedBonusAccountIds = bonusResponse.bonuses
				.map((bonus) => bonus.accountId)
				.filter((accountId): accountId is string => Boolean(accountId));
			loading = false;
			// Activity, open orders, and estimated history can involve provider calls. Render the
			// account inventory first, then let those details fill in without blocking the page.
			void loadSupplementalAccountData(
				accountResponse.accounts.filter((account) => !account.hidden)
			);
		} catch (error) {
			pageError = readableError(error, 'Your accounts could not be loaded.');
		} finally {
			loading = false;
		}
	}

	async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
		const response = await fetch(url, {
			...init,
			headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers
		});
		if (response.status === 401) {
			window.location.assign(resolve('/'));
			throw new Error('Your private session has ended.');
		}
		if (!response.ok) {
			const payload = (await response.json().catch(() => null)) as {
				error?: { message?: string };
			} | null;
			throw new Error(payload?.error?.message || 'The request could not be completed.');
		}
		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	}

	function readableError(error: unknown, fallback: string): string {
		return error instanceof Error && error.message ? error.message : fallback;
	}

	function cents(value: number | undefined): number | null {
		return value === undefined || !Number.isFinite(value) ? null : Math.round(value * 100);
	}

	function basisPoints(value: number | undefined): number | null {
		return value === undefined || !Number.isFinite(value) ? null : Math.round(value * 100);
	}

	function formatMoney(value: number | null): string {
		return value === null ? 'Not entered' : money.format(value / 100);
	}

	function formatApy(value: number): string {
		return `${(value / 100).toFixed(2)}%`;
	}

	function formatHoldingMoney(value: number, currency: string, maximumFractionDigits = 2): string {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency,
			minimumFractionDigits: 2,
			maximumFractionDigits
		}).format(value);
	}

	function formatPrice(holding: InvestmentHolding): string {
		const value = holding.priceMicros / 1_000_000;
		return formatHoldingMoney(value, holding.currency, Math.abs(value) < 1 ? 4 : 2);
	}

	function formatHoldingValue(holding: InvestmentHolding): string {
		return holding.valueCents === null
			? '—'
			: formatHoldingMoney(holding.valueCents / 100, holding.currency);
	}

	function formatQuantity(value: number): string {
		return quantity.format(value);
	}

	function isCashSweepHolding(holding: InvestmentHolding): boolean {
		return isCashSweepSecurity(holding.tickerSymbol, holding.name);
	}

	function isCashSweepTransaction(transaction: FinancialAccountTransaction): boolean {
		return isCashSweepSecurity(
			transaction.investmentDetails?.tickerSymbol,
			transaction.investmentDetails?.securityName
		);
	}

	function cashSweepTransactionAction(transaction: FinancialAccountTransaction) {
		const investment = transaction.investmentDetails;
		return investment ? cashSweepAction(investment.type, investment.subtype) : 'moved';
	}

	function formatAccountTransactionAmount(transaction: FinancialAccountTransaction): string {
		const amount = formatHoldingMoney(
			Math.abs(transaction.amountCents) / 100,
			transaction.currency
		);
		if (isCashSweepTransaction(transaction)) {
			return `${amount} ${cashSweepTransactionAction(transaction)}`;
		}
		return transaction.amountCents < 0 ? `+${amount}` : `−${amount}`;
	}

	function activityTitle(transaction: FinancialAccountTransaction): string {
		if (isCashSweepTransaction(transaction)) {
			const action = cashSweepTransactionAction(transaction);
			return action === 'used' ? 'Cash used' : action === 'added' ? 'Cash added' : 'Cash moved';
		}
		return (
			transaction.investmentDetails?.tickerSymbol ??
			transaction.investmentDetails?.securityName ??
			transaction.merchantName ??
			transaction.name
		);
	}

	function titleCase(value: string): string {
		return value
			.toLowerCase()
			.split(/[_: ]+/)
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}

	function orderActionLabel(order: BrokerageOrder): string {
		const action = titleCase(order.action);
		return `${action} ${formatQuantity(order.quantity)}`;
	}

	function orderPriceLabel(order: BrokerageOrder): string {
		const limit = order.limitPriceMicros
			? formatHoldingMoney(order.limitPriceMicros / 1_000_000, 'USD', 4)
			: null;
		const stop = order.stopPriceMicros
			? formatHoldingMoney(order.stopPriceMicros / 1_000_000, 'USD', 4)
			: null;
		if (limit && stop) return `${stop} stop · ${limit} limit`;
		if (limit) return `${limit} limit`;
		if (stop) return `${stop} stop`;
		return titleCase(order.priceType);
	}

	function orderDetailLabel(order: BrokerageOrder): string {
		const parts = [titleCase(order.term), titleCase(order.marketSession)];
		if (order.filledQuantity > 0) {
			parts.unshift(`${formatQuantity(order.filledQuantity)} filled`);
		}
		return parts.join(' · ');
	}

	function activityDetail(transaction: FinancialAccountTransaction): string {
		const investment = transaction.investmentDetails;
		if (investment) {
			if (isCashSweepTransaction(transaction)) {
				const action = cashSweepTransactionAction(transaction);
				return action === 'used'
					? 'Paid from QACDS for a purchase or withdrawal'
					: action === 'added'
						? 'Uninvested cash moved into the Chase cash sweep'
						: 'Automatic movement in the Chase cash sweep';
			}
			const parts = [titleCase(investment.subtype || investment.type)];
			if (investment.quantity !== 0) {
				parts.push(
					`${formatQuantity(Math.abs(investment.quantity))} shares @ ${formatHoldingMoney(
						investment.priceMicros / 1_000_000,
						transaction.currency,
						Math.abs(investment.priceMicros) < 1_000_000 ? 4 : 2
					)}`
				);
			}
			if (investment.feesCents) {
				parts.push(`${formatHoldingMoney(investment.feesCents / 100, transaction.currency)} fees`);
			}
			return parts.join(' · ');
		}
		if (transaction.merchantName && transaction.merchantName !== transaction.name) {
			return transaction.name;
		}
		return transaction.categoryDetailed
			? titleCase(transaction.categoryDetailed)
			: transaction.pending
				? 'Pending'
				: 'Posted';
	}

	function visibleAccountTransactions(accountId: string): FinancialAccountTransaction[] {
		const transactions = activityByAccount[accountId]?.transactions ?? [];
		return expandedActivityAccountIds.includes(accountId)
			? transactions
			: transactions.slice(0, COLLAPSED_ACTIVITY_COUNT);
	}

	function hasCashSweepActivity(accountId: string): boolean {
		return (activityByAccount[accountId]?.transactions ?? []).some(isCashSweepTransaction);
	}

	function toggleAccountActivity(accountId: string): void {
		expandedActivityAccountIds = expandedActivityAccountIds.includes(accountId)
			? expandedActivityAccountIds.filter((id) => id !== accountId)
			: [...expandedActivityAccountIds, accountId];
	}

	function formatDate(value: string | null): string {
		return value ? fullDate.format(new Date(`${value}T12:00:00`)) : 'Not entered';
	}

	function formatShortDate(value: string): string {
		return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
			new Date(`${value}T12:00:00`)
		);
	}

	function formatSyncTime(value: string | null): string {
		if (!value) return 'Waiting for first sync';
		const parsed = new Date(value);
		return Number.isFinite(parsed.getTime())
			? `Synced ${dateTime.format(parsed)}`
			: 'Sync time unavailable';
	}

	function typeLabel(type: FinancialAccountType): string {
		return {
			checking: 'Checking',
			savings: 'Savings',
			brokerage: 'Brokerage',
			cash_management: 'Cash management',
			other: 'Other'
		}[type];
	}

	function effectiveNetContributions(account: FinancialAccount): number | null {
		if (account.netContributionsCents !== null) return account.netContributionsCents;
		return (
			account.balanceHistory
				.slice()
				.reverse()
				.find((point) => point.netContributionsCents !== null)?.netContributionsCents ?? null
		);
	}

	function investmentReturn(account: FinancialAccount): number | null {
		const contributions = effectiveNetContributions(account);
		if (
			account.accountType !== 'brokerage' ||
			account.currentBalanceCents === null ||
			contributions === null
		) {
			return null;
		}
		return account.currentBalanceCents - contributions;
	}

	function investmentReturnLabel(account: FinancialAccount): string {
		const gain = investmentReturn(account);
		const contributions = effectiveNetContributions(account);
		if (gain === null || contributions === null) {
			return account.source === 'connected'
				? 'Sync activity to calculate contributions and return'
				: 'Add net contributions to separate deposits from returns';
		}
		const periodLabel = account.netContributionsCents === null ? ' · since history began' : '';
		if (contributions === 0) {
			return `${gain >= 0 ? '+' : ''}${money.format(gain / 100)}${periodLabel}`;
		}
		const percent = (gain / Math.abs(contributions)) * 100;
		return `${gain >= 0 ? '+' : ''}${money.format(gain / 100)} · ${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%${periodLabel}`;
	}

	function availableBonusOffers(account: FinancialAccount) {
		if (trackedBonusAccountIds.includes(account.id)) return [];
		return getCompatibleBonusOffers(account, account.openedDate);
	}

	function bonusSetupHref(account: FinancialAccount): string {
		return `${resolve('/bonuses')}?accountId=${encodeURIComponent(account.id)}`;
	}

	function openAdd(): void {
		editingId = null;
		form = blankForm();
		formError = '';
		dialogOpen = true;
	}

	function openEdit(account: FinancialAccount): void {
		editingId = account.id;
		form = {
			nickname: account.nickname,
			institution: account.institution ?? '',
			accountType: account.accountType,
			ownerType: account.ownerType,
			status: account.status,
			last4: account.last4 ?? '',
			currentBalance:
				account.currentBalanceCents === null ? undefined : account.currentBalanceCents / 100,
			apyPercent: account.apyBasisPoints === null ? undefined : account.apyBasisPoints / 100,
			costBasis: account.costBasisCents === null ? undefined : account.costBasisCents / 100,
			netContributions:
				account.netContributionsCents === null ? undefined : account.netContributionsCents / 100,
			openedDate: account.openedDate ?? '',
			notes: account.notes ?? ''
		};
		formError = '';
		dialogOpen = true;
	}

	function closeDialog(): void {
		if (busy) return;
		dialogOpen = false;
	}

	async function saveAccount(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!form.nickname.trim()) {
			formError = 'Give this account a name.';
			return;
		}
		busy = true;
		formError = '';
		const editingAccount = editingId
			? accounts.find((account) => account.id === editingId)
			: undefined;
		const annotations = {
			nickname: form.nickname.trim(),
			ownerType: form.ownerType,
			apyBasisPoints: basisPoints(form.apyPercent),
			costBasisCents: form.accountType === 'brokerage' ? cents(form.costBasis) : null,
			netContributionsCents: form.accountType === 'brokerage' ? cents(form.netContributions) : null,
			openedDate: form.openedDate || null,
			notes: form.notes.trim() || null
		};
		const payload =
			editingAccount?.source === 'connected'
				? annotations
				: {
						...annotations,
						institution: form.institution.trim() || null,
						accountType: form.accountType,
						status: form.status,
						last4: form.last4.trim() || null,
						currency: 'USD',
						currentBalanceCents: cents(form.currentBalance)
					};
		try {
			let savedAccount: FinancialAccount;
			if (editingId) {
				const response = await requestJson<{ account: FinancialAccount }>(
					resolve('/api/accounts/[id]', { id: editingId }),
					{
						method: 'PATCH',
						body: JSON.stringify(payload)
					}
				);
				savedAccount = response.account;
			} else {
				const response = await requestJson<{ account: FinancialAccount }>(
					resolve('/api/accounts'),
					{
						method: 'POST',
						body: JSON.stringify(payload)
					}
				);
				savedAccount = response.account;
			}
			dialogOpen = false;
			if (
				!editingId &&
				getCompatibleBonusOffers(savedAccount, savedAccount.openedDate).length > 0
			) {
				window.location.assign(bonusSetupHref(savedAccount));
				return;
			}
			await reloadAccounts();
			if (
				editingAccount?.source === 'connected' &&
				editingAccount.accountType === 'brokerage' &&
				editingAccount.netContributionsCents !== savedAccount.netContributionsCents
			) {
				const refreshedAccount = accounts.find((account) => account.id === savedAccount.id);
				if (refreshedAccount) await buildEstimatedHistory(refreshedAccount, true);
			}
			showToast(editingId ? 'Account updated.' : 'Account added.');
		} catch (error) {
			formError = readableError(error, 'The account could not be saved.');
		} finally {
			busy = false;
		}
	}

	async function loadAccountActivities(
		loadedAccounts: FinancialAccount[],
		preserveExisting = false
	): Promise<void> {
		const eligibleAccounts = loadedAccounts.filter(
			(account) => account.source === 'connected' && account.transactionHistoryEnabled
		);
		const eligibleAccountIds = new Set(eligibleAccounts.map((account) => account.id));
		activityByAccount = preserveExisting ? activityByAccount : {};
		activityErrorByAccount = preserveExisting
			? Object.fromEntries(
					Object.entries(activityErrorByAccount).filter(
						([accountId]) => !eligibleAccountIds.has(accountId)
					)
				)
			: {};
		activityLoadingByAccount = {
			...(preserveExisting ? activityLoadingByAccount : {}),
			...Object.fromEntries(eligibleAccounts.map((account) => [account.id, true]))
		};
		await Promise.all(
			eligibleAccounts.map(async (account) => {
				try {
					const endpoint = `${resolve('/api/accounts/[id]/transactions', {
						id: account.id
					})}?limit=${RECENT_ACTIVITY_LIMIT}`;
					const activity = await requestJson<AccountActivityResponse>(endpoint);
					activityByAccount = { ...activityByAccount, [account.id]: activity };
				} catch {
					activityErrorByAccount = { ...activityErrorByAccount, [account.id]: true };
				} finally {
					activityLoadingByAccount = { ...activityLoadingByAccount, [account.id]: false };
				}
			})
		);
	}

	function isEtradeBrokerage(account: FinancialAccount): boolean {
		return (
			account.accountType === 'brokerage' &&
			/(?:^|\b)e\s*\*?\s*trade(?:\b|$)/i.test(account.institution ?? '')
		);
	}

	function needsEstimatedContributionHistory(account: FinancialAccount): boolean {
		const estimatedPoints = account.balanceHistory.filter((point) => point.source === 'estimated');
		return (
			estimatedPoints.length === 0 ||
			estimatedPoints.every((point) => point.netContributionsCents === null)
		);
	}

	async function loadBrokerageOrders(
		loadedAccounts: FinancialAccount[],
		preserveExisting = false
	): Promise<void> {
		const eligibleAccounts = loadedAccounts.filter(
			(account) => account.source === 'connected' && isEtradeBrokerage(account)
		);
		const eligibleAccountIds = new Set(eligibleAccounts.map((account) => account.id));
		ordersByAccount = preserveExisting ? ordersByAccount : {};
		ordersErrorByAccount = preserveExisting
			? Object.fromEntries(
					Object.entries(ordersErrorByAccount).filter(
						([accountId]) => !eligibleAccountIds.has(accountId)
					)
				)
			: {};
		ordersLoadingByAccount = {
			...(preserveExisting ? ordersLoadingByAccount : {}),
			...Object.fromEntries(eligibleAccounts.map((account) => [account.id, true]))
		};
		await Promise.all(
			eligibleAccounts.map(async (account) => {
				try {
					const response = await requestJson<BrokerageOrdersResponse>(
						resolve('/api/accounts/[id]/orders', { id: account.id })
					);
					ordersByAccount = { ...ordersByAccount, [account.id]: response };
					if (response.availability === 'available' && needsEstimatedContributionHistory(account)) {
						await buildEstimatedHistory(account, true);
					}
				} catch {
					ordersErrorByAccount = { ...ordersErrorByAccount, [account.id]: true };
				} finally {
					ordersLoadingByAccount = { ...ordersLoadingByAccount, [account.id]: false };
				}
			})
		);
	}

	async function loadPlaidEstimatedHistories(
		loadedAccounts: FinancialAccount[],
		refreshExisting = false
	): Promise<void> {
		const eligibleAccounts = loadedAccounts.filter(
			(account) =>
				account.source === 'connected' &&
				account.connectionProvider === 'plaid' &&
				account.accountType === 'brokerage' &&
				!isEtradeBrokerage(account) &&
				account.transactionHistoryEnabled &&
				(refreshExisting || needsEstimatedContributionHistory(account))
		);
		await Promise.all(eligibleAccounts.map((account) => buildEstimatedHistory(account, true)));
	}

	async function buildEstimatedHistory(account: FinancialAccount, silent = false): Promise<void> {
		if (historyEstimateLoadingByAccount[account.id]) return;
		historyEstimateLoadingByAccount = { ...historyEstimateLoadingByAccount, [account.id]: true };
		historyEstimateErrorByAccount = { ...historyEstimateErrorByAccount, [account.id]: '' };
		historyEstimateNoteByAccount = { ...historyEstimateNoteByAccount, [account.id]: '' };
		try {
			const providerName = isEtradeBrokerage(account)
				? 'E*TRADE'
				: financialProviderName(account.connectionProvider);
			const response = await requestJson<BrokerageHistoryEstimateResponse>(
				resolve('/api/accounts/[id]/estimated-history', { id: account.id }),
				{ method: 'POST' }
			);
			if (response.availability !== 'available' || !response.account) {
				throw new Error(
					response.availability === 'authorization_required'
						? 'Reconnect E*TRADE for today before building history.'
						: response.availability === 'activity_required'
							? `Sync ${providerName} investment activity before building history.`
							: `${providerName} history is not available for this account.`
				);
			}
			accounts = accounts.map((item) => (item.id === account.id ? response.account! : item));
			if (response.unpricedSymbols.length > 0) {
				historyEstimateNoteByAccount = {
					...historyEstimateNoteByAccount,
					[account.id]: `No historical price was available for ${response.unpricedSymbols.join(', ')}; that portion remains anchored to its current value.`
				};
			}
			if (!silent) {
				showToast(
					`Built ${response.estimatedPointCount} estimated daily portfolio values${response.account.netContributionsCents === null ? ' and calculated net contributions' : ''} from ${providerName} activity.`
				);
			}
		} catch (error) {
			const message = readableError(error, 'Estimated history could not be built.');
			historyEstimateErrorByAccount = { ...historyEstimateErrorByAccount, [account.id]: message };
			if (!silent) showToast(message, { error: true });
		} finally {
			historyEstimateLoadingByAccount = {
				...historyEstimateLoadingByAccount,
				[account.id]: false
			};
		}
	}

	async function loadSupplementalAccountData(
		loadedAccounts: FinancialAccount[],
		refreshPlaidEstimates = false,
		preserveExisting = false
	): Promise<void> {
		const requestedAccountIds = loadedAccounts.map((account) => account.id);
		supplementalRequestedAccountIds = preserveExisting
			? [...new Set([...supplementalRequestedAccountIds, ...requestedAccountIds])]
			: requestedAccountIds;
		await Promise.all([
			loadAccountActivities(loadedAccounts, preserveExisting),
			loadBrokerageOrders(loadedAccounts, preserveExisting),
			loadPlaidEstimatedHistories(loadedAccounts, refreshPlaidEstimates)
		]);
	}

	function toggleHiddenAccounts(): void {
		showHidden = !showHidden;
		if (!showHidden) return;
		const unloadedHiddenAccounts = hiddenAccounts.filter(
			(account) => !supplementalRequestedAccountIds.includes(account.id)
		);
		if (unloadedHiddenAccounts.length > 0) {
			void loadSupplementalAccountData(unloadedHiddenAccounts, false, true);
		}
	}

	async function reloadAccounts(refreshPlaidEstimates = false): Promise<void> {
		const response = await requestJson<{ accounts: FinancialAccount[] }>(resolve('/api/accounts'));
		accounts = response.accounts;
		await loadSupplementalAccountData(
			response.accounts.filter((account) => showHidden || !account.hidden),
			refreshPlaidEstimates
		);
	}

	async function syncConnectedAccounts(): Promise<void> {
		if (syncing || connections.length === 0) return;
		syncing = true;
		pageError = '';
		try {
			await Promise.all(
				connections.map((connection) =>
					requestJson(resolve('/api/connections/[id]/transactions/sync', { id: connection.id }), {
						method: 'POST'
					})
				)
			);
			await reloadAccounts(true);
			showToast('Connected balances, holdings, and activity are up to date.');
		} catch (error) {
			pageError = readableError(error, 'Connected accounts could not be synced.');
		} finally {
			syncing = false;
		}
	}

	async function deleteAccount(account: FinancialAccount): Promise<void> {
		if (account.source === 'connected') return;
		if (
			!window.confirm(`Delete “${account.nickname}”? Linked bonuses will remain in your tracker.`)
		) {
			return;
		}
		deletingId = account.id;
		try {
			await requestJson(resolve('/api/accounts/[id]', { id: account.id }), { method: 'DELETE' });
			await reloadAccounts();
			showToast('Account deleted.');
		} catch (error) {
			pageError = readableError(error, 'The account could not be deleted.');
		} finally {
			deletingId = null;
		}
	}

	async function setAccountHidden(account: FinancialAccount, hidden: boolean): Promise<void> {
		if (visibilityId) return;
		visibilityId = account.id;
		try {
			const response = await requestJson<{ account: FinancialAccount }>(
				resolve('/api/accounts/[id]', { id: account.id }),
				{
					method: 'PATCH',
					body: JSON.stringify({ hidden })
				}
			);
			accounts = accounts.map((candidate) =>
				candidate.id === response.account.id ? response.account : candidate
			);
			if (!hidden && !supplementalRequestedAccountIds.includes(response.account.id)) {
				void loadSupplementalAccountData([response.account], false, true);
			}
			showToast(hidden ? `${account.nickname} hidden.` : `${account.nickname} restored.`, {
				undoAccountId: hidden ? account.id : null
			});
		} catch (error) {
			showToast(readableError(error, 'The account visibility could not be changed.'), {
				error: true
			});
		} finally {
			visibilityId = null;
		}
	}

	async function undoHiddenAccount(): Promise<void> {
		const account = accounts.find((candidate) => candidate.id === undoHiddenAccountId);
		if (!account) return;
		await setAccountHidden(account, false);
	}

	function showToast(
		message: string,
		options: { error?: boolean; undoAccountId?: string | null } = {}
	): void {
		toast = message;
		toastError = options.error ?? false;
		undoHiddenAccountId = options.undoAccountId ?? null;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(
			() => {
				toast = '';
				undoHiddenAccountId = null;
			},
			undoHiddenAccountId ? 6_000 : 3_000
		);
	}

	async function logout(): Promise<void> {
		loggingOut = true;
		try {
			await requestJson(resolve('/api/auth/logout'), { method: 'POST' });
			window.location.assign(resolve('/'));
		} catch (error) {
			pageError = readableError(error, 'Could not log out.');
			loggingOut = false;
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && dialogOpen) closeDialog();
	}
</script>

<svelte:head>
	<title>Accounts — ChipDue</title>
	<meta
		name="description"
		content="A private workspace for bank, business, cash-management, and brokerage accounts."
	/>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<a class="skip-link" href="#accounts-main">Skip to accounts</a>

<div class="finance-shell">
	<WorkspaceHeader current="accounts" {mode} {loggingOut} onlogout={logout} />

	<main id="accounts-main" class="finance-main">
		<section class="finance-toolbar" aria-labelledby="accounts-title">
			<div>
				<p class="finance-kicker">Financial workspace</p>
				<h1 id="accounts-title">Accounts</h1>
				<p>
					Connect once to keep checking, savings, cash-management, and brokerage balances current.
					Use manual accounts only when a connected provider cannot cover an institution.
				</p>
			</div>
			<div class="account-toolbar-actions">
				<button class="finance-button secondary" type="button" onclick={openAdd}>
					<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"></path></svg>
					Add manually
				</button>
				{#if plaidConfigured}
					<a
						class="finance-button"
						class:secondary={connections.length > 0}
						href={resolve('/settings#plaid-connections')}
					>
						<svg aria-hidden="true" viewBox="0 0 20 20">
							<path d="M3 8.5 10 5l7 3.5L10 12 3 8.5Z"></path>
							<path d="M5 11v3.5M8.3 12.5V16m3.4-3.5V16m3.3-5v3.5M3 17h14"></path>
						</svg>
						{connections.length > 0 ? 'Manage connections' : 'Connect a provider'}
					</a>
				{/if}
				{#if connections.length > 0}
					<button
						class="finance-button"
						type="button"
						onclick={syncConnectedAccounts}
						disabled={syncing}
					>
						<svg class:spinning={syncing} aria-hidden="true" viewBox="0 0 20 20">
							<path d="M16 7a6.5 6.5 0 1 0 .2 5.5M16 3v4h-4"></path>
						</svg>
						{syncing ? 'Syncing…' : 'Sync accounts'}
					</button>
				{/if}
			</div>
		</section>

		<section class="finance-summary" aria-label="Account summary">
			<article>
				<span>Active accounts</span>
				<strong>{loading ? '—' : activeAccounts.length}</strong>
			</article>
			<article>
				<span>Tracked balances</span>
				<strong
					>{loading ? '—' : formatMoney(knownBalances.length ? trackedBalanceCents : null)}</strong
				>
			</article>
			<article>
				<span>Provider-synced</span>
				<strong>{loading ? '—' : syncedAccountCount}</strong>
			</article>
			<article>
				<span>Investment return</span>
				<strong
					>{loading
						? '—'
						: formatMoney(brokeragePerformanceCount ? brokerageReturnCents : null)}</strong
				>
			</article>
		</section>

		{#if loading}
			<div class="finance-loading" aria-busy="true">Loading your private account inventory…</div>
		{:else if pageError}
			<div class="finance-error" role="alert">
				<h2>Accounts are unavailable</h2>
				<p>{pageError}</p>
				<button class="finance-button secondary" type="button" onclick={initialize}
					>Try again</button
				>
			</div>
		{:else if accounts.length === 0}
			<div class="finance-empty">
				<h2>Connect your financial picture</h2>
				<p>
					Connected providers can pull eligible bank and brokerage balances into this account map.
					You can still add an unsupported account and maintain it manually.
				</p>
				<div class="empty-account-actions">
					{#if plaidConfigured}
						<a class="finance-button" href={resolve('/settings#plaid-connections')}
							>Connect a provider</a
						>
					{/if}
					<button class="finance-button secondary" type="button" onclick={openAdd}
						>Add manually</button
					>
				</div>
			</div>
		{:else}
			<section aria-labelledby="account-list-title">
				<div class="finance-section-heading">
					<div>
						<h2 id="account-list-title">Your account map</h2>
						<p>Credit cards have their own Cards tab with payment details and activity.</p>
					</div>
					{#if hiddenAccounts.length > 0}
						<button
							class="hidden-accounts-toggle"
							type="button"
							aria-expanded={showHidden}
							onclick={toggleHiddenAccounts}
						>
							{showHidden ? 'Hide hidden accounts' : `Show hidden (${hiddenAccounts.length})`}
						</button>
					{/if}
				</div>
				{#if visibleAccounts.length === 0 && !showHidden}
					<div class="all-accounts-hidden">
						<p>All accounts are hidden. Show hidden accounts to restore one.</p>
					</div>
				{/if}
				<div class="account-groups">
					{#each accountGroups as accountGroup (accountGroup.id)}
						{#if accountGroup.accounts.length > 0}
							<section
								class="account-group"
								aria-labelledby={`${accountGroup.id}-account-list-title`}
							>
								<div class="account-group-heading">
									<h3 id={`${accountGroup.id}-account-list-title`}>{accountGroup.title}</h3>
									<p>{accountGroup.description}</p>
								</div>
								{#each splitAccountsByOwner(accountGroup.accounts, accountGroup.separateByOwner) as ownershipGroup (ownershipGroup.id)}
									{#if ownershipGroup.accounts.length > 0}
										<div
											class="account-ownership-group"
											role={ownershipGroup.title ? 'region' : undefined}
											aria-labelledby={ownershipGroup.title
												? `${accountGroup.id}-${ownershipGroup.id}-account-list-title`
												: undefined}
										>
											{#if ownershipGroup.title}
												<div
													class:business={ownershipGroup.id === 'business'}
													class="account-ownership-heading"
												>
													<h4 id={`${accountGroup.id}-${ownershipGroup.id}-account-list-title`}>
														{ownershipGroup.title}
													</h4>
													<span
														>{ownershipGroup.accounts.length}
														{ownershipGroup.accounts.length === 1 ? 'account' : 'accounts'}</span
													>
												</div>
											{/if}
											<div class="finance-grid">
												{#each ownershipGroup.accounts as account (account.id)}
													{@const bonusOffers = availableBonusOffers(account)}
													{@const logoUrl = institutionLogoUrl(account)}
													<article
														class:brokerage-detail={account.accountType === 'brokerage'}
														class:hidden-account={account.hidden}
														class="finance-card"
													>
														<header>
															<div class="account-identity">
																<span class:institution-logo={logoUrl} class="institution-mark">
																	{#if logoUrl}
																		<img
																			src={logoUrl}
																			alt={`${account.institution ?? account.nickname} logo`}
																		/>
																	{:else}
																		<svg viewBox="0 0 24 24" aria-hidden="true">
																			<path d="M3 9h18M5 9V7l7-4 7 4v2M5 20h14M7 9v8m5-8v8m5-8v8" />
																		</svg>
																	{/if}
																</span>
																<div>
																	<h4>{account.nickname}</h4>
																	<p>
																		{account.institution ?? 'Institution not entered'}{account.last4
																			? ` · •••• ${account.last4}`
																			: ''}
																	</p>
																</div>
															</div>
															<div class="account-pills">
																<span
																	class:connected={account.source === 'connected'}
																	class="finance-pill source"
																>
																	{account.source === 'connected'
																		? financialProviderName(account.connectionProvider)
																		: 'Manual'}
																</span>
																<span
																	class:good={account.status === 'active'}
																	class:muted={account.status !== 'active'}
																	class="finance-pill"
																>
																	{account.status}
																</span>
																{#if account.hidden}
																	<span class="finance-pill muted">Hidden</span>
																{/if}
															</div>
														</header>
														<div class="finance-card-value">
															<span
																>{account.source === 'connected'
																	? 'Synced balance'
																	: 'Current balance'}</span
															>
															<strong>{formatMoney(account.currentBalanceCents)}</strong>
														</div>
														<dl class="finance-details">
															<div>
																<dt>Account type</dt>
																<dd>{typeLabel(account.accountType)}</dd>
															</div>
															{#if account.apyBasisPoints !== null}
																<div class="apy-detail">
																	<dt>APY</dt>
																	<dd>{formatApy(account.apyBasisPoints)}</dd>
																</div>
															{/if}
															{#if account.accountType !== 'brokerage'}
																<div>
																	<dt>Ownership</dt>
																	<dd>
																		{account.ownerType === 'business' ? 'Business' : 'Personal'}
																	</dd>
																</div>
															{/if}
															<div>
																<dt>Opened</dt>
																<dd>{formatDate(account.openedDate)}</dd>
															</div>
															<div>
																<dt>Data source</dt>
																<dd>
																	{account.source === 'connected'
																		? formatSyncTime(account.lastSyncedAt)
																		: 'Manual entry'}
																</dd>
															</div>
															{#if account.accountType === 'brokerage'}
																<div>
																	<dt>Investment return</dt>
																	<dd
																		class:gain={investmentReturn(account) !== null &&
																			(investmentReturn(account) ?? 0) >= 0}
																	>
																		{investmentReturnLabel(account)}
																	</dd>
																</div>
															{/if}
														</dl>
														{#if account.accountType === 'brokerage'}
															<BalanceHistoryChart
																accountId={account.id}
																accountName={account.nickname}
																currency={account.currency}
																points={account.balanceHistory}
																netContributionsCents={account.netContributionsCents}
															/>
															{#if account.source === 'connected'}
																<div class="history-estimate-action">
																	<div>
																		<strong>Estimated portfolio history</strong>
																		<span
																			>Uses {isEtradeBrokerage(account)
																				? 'E*TRADE'
																				: financialProviderName(account.connectionProvider)} activity
																			and daily market closes; it is not broker-reported performance.</span
																		>
																		<small>
																			Net contributions are calculated automatically for the
																			available history.
																		</small>
																		{#if historyEstimateErrorByAccount[account.id]}
																			<small class="error"
																				>{historyEstimateErrorByAccount[account.id]}</small
																			>
																		{:else if historyEstimateNoteByAccount[account.id]}
																			<small>{historyEstimateNoteByAccount[account.id]}</small>
																		{/if}
																	</div>
																	{#if !account.transactionHistoryEnabled && !isEtradeBrokerage(account)}
																		<span class="disabled-label">Sync activity first</span>
																	{:else if !isEtradeBrokerage(account) || ordersByAccount[account.id]?.availability === 'available'}
																		<button
																			type="button"
																			disabled={historyEstimateLoadingByAccount[account.id]}
																			onclick={() => buildEstimatedHistory(account)}
																		>
																			{historyEstimateLoadingByAccount[account.id]
																				? 'Building…'
																				: account.balanceHistory.some(
																							(point) => point.source === 'estimated'
																					  )
																					? 'Refresh estimate'
																					: 'Build 2-year estimate'}
																		</button>
																	{:else}
																		<a href={resolve('/etrade')}>Connect E*TRADE</a>
																	{/if}
																</div>
															{/if}
														{/if}
														{#if bonusOffers.length > 0}
															<section
																class="bonus-offer-callout"
																aria-label="Verified bonus offers"
															>
																<div>
																	<span>Verified bonus catalog</span>
																	<strong>
																		{bonusOffers.length} matching {bonusOffers.length === 1
																			? 'offer'
																			: 'offers'}
																	</strong>
																</div>
																<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- bonusSetupHref resolves the route before appending its query. -->
																<a href={bonusSetupHref(account)}>Choose your offer</a>
															</section>
														{/if}
														{#if account.accountType === 'brokerage' && account.source === 'connected'}
															<section
																class="holding-list"
																aria-label={`${account.nickname} holdings`}
															>
																<div class="holding-list-heading">
																	<h4>Holdings</h4>
																	<span>
																		{account.holdings.length
																			? `${account.holdings.length} ${account.holdings.length === 1 ? 'position' : 'positions'}`
																			: 'No positions reported'}
																	</span>
																</div>
																{#if account.holdings.length > 0}
																	<div
																		class="holding-table"
																		role="table"
																		aria-label="Holdings and current prices"
																	>
																		<div class="holding-row heading" role="row">
																			<span role="columnheader">Holding</span>
																			<span role="columnheader">Units</span>
																			<span role="columnheader">Current price</span>
																			<span role="columnheader">Value</span>
																		</div>
																		{#each account.holdings as holding, index (index)}
																			<div class="holding-row" role="row">
																				<span class="holding-name" role="cell">
																					<strong
																						>{isCashSweepHolding(holding)
																							? `Cash${holding.tickerSymbol ? ` (${holding.tickerSymbol})` : ''}`
																							: (holding.tickerSymbol ?? holding.name)}</strong
																					>
																					<small>
																						{isCashSweepHolding(holding)
																							? 'Uninvested cash held at Chase'
																							: holding.tickerSymbol
																								? holding.name
																								: (holding.securityType ?? 'Security')}
																					</small>
																				</span>
																				<span role="cell" data-label="Units">
																					{isCashSweepHolding(holding)
																						? '—'
																						: formatQuantity(holding.quantity)}
																				</span>
																				<span
																					class="holding-price"
																					role="cell"
																					data-label="Current price"
																				>
																					<strong
																						>{isCashSweepHolding(holding)
																							? 'Fixed at $1.00'
																							: formatPrice(holding)}</strong
																					>
																					{#if holding.priceAsOf}<small
																							>as of {formatDate(holding.priceAsOf)}</small
																						>{/if}
																				</span>
																				<span role="cell" data-label="Value"
																					>{formatHoldingValue(holding)}</span
																				>
																			</div>
																		{/each}
																	</div>
																{:else}
																	<p class="holding-empty">
																		No holdings are available from the provider yet. Sync again
																		after investment data is ready.
																	</p>
																{/if}
															</section>
														{/if}
														{#if account.source === 'connected'}
															<section
																class="account-activity"
																aria-label={`${account.accountType === 'brokerage' ? 'Investment' : 'Recent'} activity for ${account.nickname}`}
															>
																<div class="account-detail-heading">
																	<h4>
																		{account.accountType === 'brokerage'
																			? 'Investment activity'
																			: 'Recent activity'}
																	</h4>
																	{#if activityByAccount[account.id]?.transactions.length}
																		<span>
																			{activityByAccount[account.id].transactions
																				.length}{activityByAccount[account.id].transactions
																				.length === RECENT_ACTIVITY_LIMIT
																				? '+'
																				: ''}
																			loaded
																		</span>
																	{/if}
																</div>
																{#if !account.transactionHistoryEnabled}
																	<p class="account-activity-message">
																		Sync accounts to load activity from {financialProviderName(
																			account.connectionProvider
																		)}.
																	</p>
																{:else if activityLoadingByAccount[account.id]}
																	<p class="account-activity-message" aria-busy="true">
																		Loading activity…
																	</p>
																{:else if activityErrorByAccount[account.id]}
																	<p class="account-activity-message">
																		Activity is unavailable right now.
																	</p>
																{:else if activityByAccount[account.id]?.transactions.length}
																	{#if hasCashSweepActivity(account.id)}
																		<p class="cash-sweep-explainer">
																			QACDS is Chase’s name for uninvested cash. “Cash used” means
																			Chase took cash from QACDS to pay for a purchase or
																			withdrawal. It is not a stock sale or investment gain.
																		</p>
																	{/if}
																	<ul class="account-activity-list">
																		{#each visibleAccountTransactions(account.id) as transaction (transaction.id)}
																			<li>
																				<div class="account-activity-date">
																					<strong>{formatShortDate(transaction.date)}</strong>
																					<span>{transaction.pending ? 'Pending' : 'Posted'}</span>
																				</div>
																				<div class="account-activity-description">
																					<strong>{activityTitle(transaction)}</strong>
																					<span>{activityDetail(transaction)}</span>
																				</div>
																				<strong
																					class:credit={transaction.amountCents < 0 &&
																						!isCashSweepTransaction(transaction)}
																					class="account-activity-amount"
																				>
																					{formatAccountTransactionAmount(transaction)}
																				</strong>
																			</li>
																		{/each}
																	</ul>
																	{#if activityByAccount[account.id].transactions.length > COLLAPSED_ACTIVITY_COUNT}
																		<button
																			class="account-activity-toggle"
																			type="button"
																			onclick={() => toggleAccountActivity(account.id)}
																		>
																			{expandedActivityAccountIds.includes(account.id)
																				? 'Show less'
																				: `Show all ${activityByAccount[account.id].transactions.length}`}
																		</button>
																	{/if}
																{:else}
																	<p class="account-activity-message">
																		{activityByAccount[account.id]?.status === 'preparing'
																			? 'The provider is still preparing older activity.'
																			: `No ${account.accountType === 'brokerage' ? 'investment activity' : 'transactions'} returned by ${financialProviderName(account.connectionProvider)}.`}
																	</p>
																{/if}
															</section>
															{#if account.accountType === 'brokerage'}
																<section
																	class="open-orders"
																	aria-label={`Open orders for ${account.nickname}`}
																>
																	<div class="account-detail-heading">
																		<h4>Open orders</h4>
																		<span>
																			{isEtradeBrokerage(account)
																				? ordersLoadingByAccount[account.id]
																					? 'Checking E*TRADE…'
																					: ordersByAccount[account.id]?.availability ===
																						  'available'
																						? `${ordersByAccount[account.id].orders.length} open`
																						: 'E*TRADE setup needed'
																				: 'Not available'}
																		</span>
																	</div>
																	{#if !isEtradeBrokerage(account)}
																		<p>
																			Plaid does not provide open-order data. Check your brokerage
																			before placing or changing a trade.
																		</p>
																	{:else if ordersLoadingByAccount[account.id]}
																		<p aria-busy="true">Loading open orders from E*TRADE…</p>
																	{:else if ordersErrorByAccount[account.id]}
																		<p>
																			E*TRADE orders are temporarily unavailable. Verify them at the
																			brokerage before trading.
																		</p>
																	{:else if ordersByAccount[account.id]?.availability === 'available'}
																		{#if ordersByAccount[account.id].orders.length > 0}
																			<ul class="open-order-list">
																				{#each ordersByAccount[account.id].orders as order (order.id)}
																					<li>
																						<span class="open-order-security">
																							<strong>{order.symbol}</strong>
																							<small
																								>{order.description ??
																									titleCase(order.status)}</small
																							>
																						</span>
																						<span class="open-order-action">
																							<strong>{orderActionLabel(order)}</strong>
																							<small>{orderDetailLabel(order)}</small>
																						</span>
																						<strong class="open-order-price"
																							>{orderPriceLabel(order)}</strong
																						>
																					</li>
																				{/each}
																			</ul>
																		{:else}
																			<p>No open orders were reported by E*TRADE.</p>
																		{/if}
																	{:else}
																		<p>
																			{ordersByAccount[account.id]?.availability ===
																			'account_not_found'
																				? 'ChipDue could not match this account to E*TRADE. Make sure its last four characters are current.'
																				: 'Connect E*TRADE for today to load open orders.'}
																			<a class="open-orders-link" href={resolve('/etrade')}>
																				{ordersByAccount[account.id]?.availability ===
																				'not_configured'
																					? 'Connect E*TRADE'
																					: ordersByAccount[account.id]?.availability ===
																						  'authorization_required'
																						? 'Reconnect E*TRADE'
																						: 'Review E*TRADE setup'}
																			</a>
																		</p>
																	{/if}
																</section>
															{/if}
														{/if}
														<footer>
															<span
																>{account.hidden
																	? 'Excluded from totals'
																	: account.source === 'connected'
																		? 'Automatic balance'
																		: 'Manual balance'}</span
															>
															<div>
																<button type="button" onclick={() => openEdit(account)}>
																	{account.source === 'connected' ? 'Details' : 'Edit'}
																</button>
																<button
																	type="button"
																	disabled={visibilityId === account.id}
																	onclick={() => setAccountHidden(account, !account.hidden)}
																>
																	{visibilityId === account.id
																		? 'Saving…'
																		: account.hidden
																			? 'Show'
																			: 'Hide'}
																</button>
																{#if account.source === 'manual'}
																	<button
																		class="delete"
																		type="button"
																		onclick={() => deleteAccount(account)}
																	>
																		{deletingId === account.id ? 'Deleting…' : 'Delete'}
																	</button>
																{/if}
															</div>
														</footer>
													</article>
												{/each}
											</div>
										</div>
									{/if}
								{/each}
							</section>
						{/if}
					{/each}
				</div>
			</section>
		{/if}
	</main>
</div>

{#if dialogOpen}
	<div class="finance-dialog-layer" role="presentation">
		<div
			class="finance-dialog"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="account-dialog-title"
		>
			<header class="finance-dialog-header">
				<div>
					<h2 id="account-dialog-title">
						{dialogAccount?.source === 'connected'
							? 'Account details'
							: editingId
								? 'Edit account'
								: 'Add account'}
					</h2>
					<p>
						{dialogAccount?.source === 'connected'
							? 'Your provider keeps the balance and institution details current. Add the personal details you want ChipDue to remember.'
							: 'Only the last four characters are accepted—never enter a full account number.'}
					</p>
				</div>
				<button type="button" aria-label="Close" onclick={closeDialog}>×</button>
			</header>
			<form class="finance-form" onsubmit={saveAccount}>
				{#if formError}<p class="finance-form-error" role="alert">{formError}</p>{/if}
				<div class="finance-form-grid">
					<div class="finance-field">
						<label for="account-name">Account name</label>
						<input id="account-name" bind:value={form.nickname} maxlength="80" required />
					</div>
					<div class="finance-field">
						<label for="account-institution">Institution</label>
						<input
							id="account-institution"
							bind:value={form.institution}
							maxlength="80"
							disabled={dialogAccount?.source === 'connected'}
						/>
					</div>
					<div class="finance-field">
						<label for="account-type">Account type</label>
						<select
							id="account-type"
							bind:value={form.accountType}
							disabled={dialogAccount?.source === 'connected'}
						>
							<option value="checking">Checking</option>
							<option value="savings">Savings</option>
							<option value="brokerage">Brokerage</option>
							<option value="cash_management">Cash management</option>
							<option value="other">Other</option>
						</select>
					</div>
					{#if form.accountType !== 'brokerage'}
						<div class="finance-field">
							<label for="account-owner">Ownership</label>
							<select id="account-owner" bind:value={form.ownerType}>
								<option value="personal">Personal</option>
								<option value="business">Business</option>
							</select>
						</div>
					{/if}
					<div class="finance-field">
						<label for="account-balance">Current balance</label>
						<input
							id="account-balance"
							type="number"
							step="0.01"
							bind:value={form.currentBalance}
							placeholder="0.00"
							disabled={dialogAccount?.source === 'connected'}
						/>
					</div>
					<div class="finance-field">
						<label for="account-apy">APY (%)</label>
						<input
							id="account-apy"
							type="number"
							min="0"
							max="1000"
							step="0.01"
							inputmode="decimal"
							bind:value={form.apyPercent}
							placeholder="4.25"
						/>
						<small>Leave blank if this account does not earn interest.</small>
					</div>
					{#if form.accountType === 'brokerage'}
						<div class="finance-field">
							<label for="account-contributions">
								{dialogAccount?.source === 'connected'
									? 'Lifetime net contributions (optional)'
									: 'Net contributions'}
							</label>
							<input
								id="account-contributions"
								type="number"
								step="0.01"
								bind:value={form.netContributions}
								placeholder="0.00"
							/>
							<small>
								{dialogAccount?.source === 'connected'
									? 'ChipDue calculates the displayed period automatically. Enter a lifetime total only to override it.'
									: 'Money deposited minus money withdrawn. This is your invested principal.'}
							</small>
						</div>
						<div class="finance-field">
							<label for="account-cost-basis">
								{dialogAccount?.source === 'connected' ? 'Cost basis fallback' : 'Cost basis'}
							</label>
							<input
								id="account-cost-basis"
								type="number"
								min="0"
								step="0.01"
								bind:value={form.costBasis}
								placeholder="0.00"
							/>
							<small>What you paid for the investments you currently hold.</small>
						</div>
					{/if}
					<div class="finance-field">
						<label for="account-opened">Opened date</label>
						<input id="account-opened" type="date" bind:value={form.openedDate} />
					</div>
					<div class="finance-field">
						<label for="account-last4">Last four</label>
						<input
							id="account-last4"
							bind:value={form.last4}
							minlength="4"
							maxlength="4"
							pattern={'[A-Za-z0-9]{4}'}
							placeholder="1234"
							disabled={dialogAccount?.source === 'connected'}
						/>
					</div>
					<div class="finance-field">
						<label for="account-status">Status</label>
						<select
							id="account-status"
							bind:value={form.status}
							disabled={dialogAccount?.source === 'connected'}
						>
							<option value="planned">Planned</option>
							<option value="active">Active</option>
							<option value="closed">Closed</option>
						</select>
					</div>
					<div class="finance-field wide">
						<label for="account-notes">Private notes</label>
						<textarea id="account-notes" bind:value={form.notes} maxlength="2000"></textarea>
					</div>
				</div>
				<div class="finance-form-actions">
					<button class="finance-button secondary" type="button" onclick={closeDialog}
						>Cancel</button
					>
					<button class="finance-button" type="submit" disabled={busy}>
						{busy
							? 'Saving…'
							: dialogAccount?.source === 'connected'
								? 'Save details'
								: editingId
									? 'Save changes'
									: 'Add account'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

{#if toast}
	<div class:error={toastError} class="finance-toast" role={toastError ? 'alert' : 'status'}>
		<span>{toast}</span>
		{#if undoHiddenAccountId}
			<button type="button" disabled={visibilityId !== null} onclick={undoHiddenAccount}
				>Undo</button
			>
		{/if}
	</div>
{/if}

<style>
	.skip-link {
		position: fixed;
		top: 0.75rem;
		left: 0.75rem;
		z-index: 100;
		padding: 0.65rem 0.9rem;
		border-radius: 0.5rem;
		color: white;
		background: var(--accent-dark);
		transform: translateY(-150%);
	}

	.skip-link:focus {
		transform: translateY(0);
	}

	dd.gain {
		color: var(--positive);
	}

	.finance-details .apy-detail dd {
		color: var(--positive);
	}

	.account-group + .account-group {
		margin-top: 2rem;
		padding-top: 2rem;
		border-top: 1px solid var(--line);
	}

	.hidden-accounts-toggle {
		padding: 0.45rem 0.65rem;
		border: 1px solid var(--line-strong);
		border-radius: 8px;
		color: var(--muted);
		font: inherit;
		font-size: 0.64rem;
		font-weight: 720;
		background: var(--paper);
		cursor: pointer;
	}

	.hidden-accounts-toggle:hover {
		border-color: var(--accent);
		color: var(--accent-dark);
	}

	.all-accounts-hidden {
		padding: 1rem;
		border: 1px dashed var(--line-strong);
		border-radius: 10px;
		color: var(--muted);
		font-size: 0.7rem;
		text-align: center;
		background: var(--paper-soft);
	}

	.all-accounts-hidden p {
		margin: 0;
	}

	.account-group-heading {
		margin-bottom: 0.8rem;
	}

	.account-group-heading h3 {
		margin: 0;
		font-size: 0.84rem;
		letter-spacing: -0.01em;
	}

	.account-group-heading p {
		margin: 0.28rem 0 0;
		color: var(--faint);
		font-size: 0.64rem;
	}

	.account-ownership-group + .account-ownership-group {
		margin-top: 1.5rem;
	}

	.account-ownership-heading {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.65rem;
		padding: 0.5rem 0.65rem;
		border-left: 3px solid var(--accent);
		border-radius: 6px;
		background: var(--accent-soft);
	}

	.account-ownership-heading.business {
		border-left-color: var(--amber);
		background: var(--amber-soft);
	}

	.account-ownership-heading h4 {
		margin: 0;
		color: var(--accent-dark);
		font-size: 0.7rem;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.account-ownership-heading.business h4 {
		color: var(--amber);
	}

	.account-ownership-heading span {
		color: var(--muted);
		font-size: 0.62rem;
		font-weight: 700;
	}

	.finance-card h4 {
		margin: 0;
		font-size: 1rem;
		font-weight: 750;
		letter-spacing: -0.025em;
	}

	.account-identity {
		display: flex;
		min-width: 0;
		gap: 0.7rem;
		align-items: center;
	}

	.account-identity > div {
		min-width: 0;
	}

	.institution-mark {
		display: grid;
		width: 38px;
		height: 38px;
		padding: 8px;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: 10px;
		color: var(--accent-dark);
		background: var(--accent-soft);
		flex: 0 0 auto;
		place-items: center;
	}

	.institution-mark svg {
		width: 21px;
		height: 21px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.7;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.institution-mark.institution-logo {
		padding: 4px;
		background: white;
	}

	.institution-mark img {
		display: block;
		width: 100%;
		height: 100%;
		border-radius: 6px;
		object-fit: contain;
	}

	.finance-card.brokerage-detail {
		grid-column: span 2;
	}

	.finance-card.hidden-account {
		border-style: dashed;
		box-shadow: none;
	}

	.bonus-offer-callout {
		display: flex;
		gap: 0.8rem;
		align-items: center;
		justify-content: space-between;
		margin-top: 0.8rem;
		padding: 0.65rem 0.7rem;
		border: 1px solid rgba(61, 90, 254, 0.22);
		border-radius: 9px;
		background: rgba(61, 90, 254, 0.065);
	}

	.bonus-offer-callout div {
		display: grid;
		gap: 0.14rem;
	}

	.bonus-offer-callout span {
		color: var(--faint);
		font-size: 0.56rem;
		font-weight: 740;
		letter-spacing: 0.045em;
		text-transform: uppercase;
	}

	.bonus-offer-callout strong {
		font-size: 0.7rem;
	}

	.bonus-offer-callout a {
		color: var(--accent-dark);
		font-size: 0.62rem;
		font-weight: 760;
		white-space: nowrap;
	}

	.holding-list {
		margin-top: 1rem;
		padding-top: 0.9rem;
		border-top: 1px solid var(--line);
	}

	.holding-list-heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 0.55rem;
	}

	.holding-list h4 {
		margin: 0;
		font-size: 0.72rem;
	}

	.holding-list-heading span,
	.holding-empty {
		color: var(--faint);
		font-size: 0.58rem;
	}

	.holding-table {
		border: 1px solid var(--line);
		border-radius: 9px;
		overflow: hidden;
	}

	.holding-row {
		display: grid;
		grid-template-columns: minmax(130px, 1.6fr) minmax(70px, 0.7fr) minmax(105px, 0.85fr) minmax(
				95px,
				0.8fr
			);
		gap: 0.7rem;
		align-items: center;
		padding: 0.65rem 0.75rem;
		font-size: 0.66rem;
	}

	.holding-row + .holding-row {
		border-top: 1px solid var(--line);
	}

	.holding-row.heading {
		padding-top: 0.48rem;
		padding-bottom: 0.48rem;
		color: var(--faint);
		font-size: 0.54rem;
		font-weight: 720;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		background: var(--paper-soft);
	}

	.holding-name,
	.holding-price {
		display: grid;
		gap: 0.13rem;
		min-width: 0;
	}

	.holding-name strong,
	.holding-name small,
	.holding-price small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.holding-name strong,
	.holding-price strong {
		font-size: 0.68rem;
	}

	.holding-name small,
	.holding-price small {
		color: var(--faint);
		font-size: 0.54rem;
	}

	.holding-empty {
		margin: 0;
		padding: 0.7rem 0.75rem;
		border: 1px dashed var(--line-strong);
		border-radius: 9px;
		line-height: 1.45;
		background: var(--paper-soft);
	}

	.account-activity,
	.open-orders {
		margin-top: 1rem;
		padding-top: 0.9rem;
		border-top: 1px solid var(--line);
	}

	.history-estimate-action {
		display: flex;
		gap: 1rem;
		align-items: center;
		justify-content: space-between;
		margin-top: 0.55rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: var(--paper-soft);
	}

	.history-estimate-action > div {
		display: grid;
		gap: 0.12rem;
	}

	.history-estimate-action strong {
		font-size: 0.62rem;
	}

	.history-estimate-action span,
	.history-estimate-action small {
		color: var(--faint);
		font-size: 0.54rem;
		line-height: 1.4;
	}

	.history-estimate-action small.error {
		color: var(--red);
	}

	.history-estimate-action button,
	.history-estimate-action a {
		flex: 0 0 auto;
		padding: 0.42rem 0.58rem;
		border: 1px solid var(--accent);
		border-radius: 7px;
		color: white;
		font: inherit;
		font-size: 0.56rem;
		font-weight: 760;
		text-decoration: none;
		background: var(--accent);
		cursor: pointer;
	}

	.history-estimate-action .disabled-label {
		flex: 0 0 auto;
		padding: 0.34rem 0.48rem;
		border: 1px solid var(--line);
		border-radius: 7px;
		font-size: 0.54rem;
		font-weight: 700;
		background: white;
	}

	.history-estimate-action button:disabled {
		opacity: 0.58;
		cursor: wait;
	}

	.account-detail-heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 0.55rem;
	}

	.account-detail-heading h4 {
		margin: 0;
		font-size: 0.72rem;
	}

	.account-detail-heading span {
		color: var(--faint);
		font-size: 0.58rem;
	}

	.account-activity-list {
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 9px;
		list-style: none;
		overflow: hidden;
	}

	.open-order-list {
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 9px;
		list-style: none;
		overflow: hidden;
	}

	.open-order-list li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(105px, auto) auto;
		gap: 0.75rem;
		align-items: center;
		padding: 0.65rem 0.75rem;
		font-size: 0.64rem;
	}

	.open-order-list li + li {
		border-top: 1px solid var(--line);
	}

	.open-order-security,
	.open-order-action {
		display: grid;
		gap: 0.13rem;
		min-width: 0;
	}

	.open-order-security strong,
	.open-order-action strong,
	.open-order-price {
		font-size: 0.66rem;
	}

	.open-order-security small,
	.open-order-action small {
		color: var(--faint);
		font-size: 0.54rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.open-order-price {
		text-align: right;
		white-space: nowrap;
	}

	.open-orders-link {
		display: inline-block;
		margin-left: 0.25rem;
		color: var(--accent-dark);
		font-weight: 750;
	}

	.cash-sweep-explainer {
		margin: 0 0 0.55rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--line));
		border-radius: 9px;
		color: var(--muted);
		font-size: 0.58rem;
		line-height: 1.45;
		background: color-mix(in srgb, var(--accent) 5%, var(--paper));
	}

	.account-activity-list li {
		display: grid;
		grid-template-columns: 70px minmax(0, 1fr) auto;
		gap: 0.75rem;
		align-items: center;
		padding: 0.65rem 0.75rem;
		font-size: 0.64rem;
	}

	.account-activity-list li + li {
		border-top: 1px solid var(--line);
	}

	.account-activity-date,
	.account-activity-description {
		display: grid;
		gap: 0.13rem;
		min-width: 0;
	}

	.account-activity-date strong,
	.account-activity-description strong {
		font-size: 0.66rem;
	}

	.account-activity-date span,
	.account-activity-description span {
		color: var(--faint);
		font-size: 0.54rem;
	}

	.account-activity-description strong,
	.account-activity-description span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.account-activity-amount {
		font-size: 0.67rem;
		white-space: nowrap;
	}

	.account-activity-amount.credit {
		color: var(--positive);
	}

	.account-activity-toggle {
		margin-top: 0.55rem;
		padding: 0;
		border: 0;
		color: var(--accent-dark);
		font: inherit;
		font-size: 0.6rem;
		font-weight: 750;
		background: transparent;
		cursor: pointer;
	}

	.account-activity-message,
	.open-orders p {
		margin: 0;
		padding: 0.7rem 0.75rem;
		border: 1px dashed var(--line-strong);
		border-radius: 9px;
		color: var(--faint);
		font-size: 0.58rem;
		line-height: 1.45;
		background: var(--paper-soft);
	}

	.account-toolbar-actions,
	.empty-account-actions,
	.account-pills,
	.finance-card footer > div {
		display: flex;
		gap: 0.55rem;
		align-items: center;
		flex-wrap: wrap;
	}

	.account-toolbar-actions {
		justify-content: flex-end;
	}

	.empty-account-actions {
		justify-content: center;
	}

	.account-pills {
		justify-content: flex-end;
	}

	.finance-pill.source {
		color: var(--muted);
		background: var(--paper-soft);
	}

	.finance-pill.source.connected {
		color: var(--accent-dark);
		background: var(--accent-soft);
	}

	.finance-card footer {
		justify-content: space-between;
	}

	.finance-card footer > span {
		color: var(--faint);
		font-size: 0.6rem;
		font-weight: 680;
	}

	.finance-card footer button:disabled {
		opacity: 0.55;
		cursor: wait;
	}

	.finance-toast {
		display: flex;
		gap: 1rem;
		align-items: center;
		justify-content: space-between;
	}

	.finance-toast.error {
		border-color: #e8b8b1;
		color: var(--red);
		background: var(--red-soft);
	}

	.finance-toast button {
		padding: 0;
		border: 0;
		color: inherit;
		font: inherit;
		font-weight: 800;
		text-decoration: underline;
		background: transparent;
		cursor: pointer;
	}

	.finance-field input:disabled,
	.finance-field select:disabled {
		color: var(--muted);
		background: var(--paper-soft);
		cursor: not-allowed;
	}

	@media (max-width: 620px) {
		.finance-card.brokerage-detail {
			grid-column: auto;
		}

		.account-toolbar-actions {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			width: 100%;
		}

		.account-toolbar-actions > :last-child:nth-child(3) {
			grid-column: 1 / -1;
		}

		.account-toolbar-actions > :only-child {
			grid-column: 1 / -1;
		}

		.finance-section-heading {
			gap: 0.8rem;
			align-items: flex-start;
		}

		.hidden-accounts-toggle {
			white-space: nowrap;
		}

		.holding-row {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 0.55rem 1rem;
		}

		.holding-row.heading {
			display: none;
		}

		.holding-row > span:nth-child(2)::before,
		.holding-row > span:nth-child(3)::before,
		.holding-row > span:nth-child(4)::before {
			content: attr(data-label);
			display: block;
			margin-bottom: 0.13rem;
			color: var(--faint);
			font-size: 0.5rem;
			font-weight: 700;
			text-transform: uppercase;
		}

		.holding-row > span:nth-child(2),
		.holding-row > span:nth-child(3),
		.holding-row > span:nth-child(4) {
			text-align: left;
		}

		.holding-row .holding-name {
			grid-column: 1 / -1;
		}

		.holding-row > span:nth-child(3) {
			text-align: center;
		}

		.holding-row > span:nth-child(4) {
			text-align: right;
		}

		.account-activity-list li {
			grid-template-columns: 58px minmax(0, 1fr) auto;
			gap: 0.55rem;
			padding-right: 0.6rem;
			padding-left: 0.6rem;
		}

		.open-order-list li {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.45rem 0.75rem;
		}

		.open-order-action {
			text-align: right;
		}

		.open-order-price {
			grid-column: 1 / -1;
			text-align: left;
		}
	}
</style>
