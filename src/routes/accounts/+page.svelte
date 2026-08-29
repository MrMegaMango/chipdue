<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { getCompatibleBonusOffers } from '$lib/bonus-offers';
	import WorkspaceHeader from '$lib/components/WorkspaceHeader.svelte';
	import { financialProviderName } from '$lib/financial-data';
	import type {
		FinancialConnection,
		FinancialAccount,
		FinancialAccountOwner,
		FinancialAccountStatus,
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
	type AccountForm = {
		nickname: string;
		institution: string;
		accountType: FinancialAccountType;
		ownerType: FinancialAccountOwner;
		status: FinancialAccountStatus;
		last4: string;
		currentBalance: number | undefined;
		costBasis: number | undefined;
		openedDate: string;
		notes: string;
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
	let syncing = $state(false);
	let toast = $state('');
	let toastError = $state(false);
	let undoHiddenAccountId = $state<string | null>(null);
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
			accounts: visibleAccounts.filter((account) => account.accountType !== 'brokerage')
		},
		{
			id: 'brokerage',
			title: 'Brokerage accounts',
			description: 'Investments, positions, and performance.',
			accounts: visibleAccounts.filter((account) => account.accountType === 'brokerage')
		},
		...(showHidden
			? [
					{
						id: 'hidden',
						title: 'Hidden accounts',
						description: 'Excluded from your account map and summary totals.',
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
	const brokerageGainCents = $derived(
		activeAccounts
			.filter(
				(account) =>
					account.accountType === 'brokerage' &&
					account.currentBalanceCents !== null &&
					account.costBasisCents !== null
			)
			.reduce(
				(total, account) =>
					total + (account.currentBalanceCents ?? 0) - (account.costBasisCents ?? 0),
				0
			)
	);
	const brokeragePerformanceCount = $derived(
		activeAccounts.filter(
			(account) =>
				account.accountType === 'brokerage' &&
				account.currentBalanceCents !== null &&
				account.costBasisCents !== null
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
			costBasis: undefined,
			openedDate: '',
			notes: ''
		};
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

	function formatMoney(value: number | null): string {
		return value === null ? 'Not entered' : money.format(value / 100);
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

	function formatDate(value: string | null): string {
		return value ? fullDate.format(new Date(`${value}T12:00:00`)) : 'Not entered';
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

	function performance(account: FinancialAccount): number | null {
		if (
			account.accountType !== 'brokerage' ||
			account.currentBalanceCents === null ||
			account.costBasisCents === null
		) {
			return null;
		}
		return account.currentBalanceCents - account.costBasisCents;
	}

	function performanceLabel(account: FinancialAccount): string {
		const gain = performance(account);
		if (gain === null || account.costBasisCents === null || account.costBasisCents === 0) {
			return 'Add cost basis to track performance';
		}
		const percent = (gain / account.costBasisCents) * 100;
		return `${gain >= 0 ? '+' : ''}${money.format(gain / 100)} · ${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
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
			costBasis: account.costBasisCents === null ? undefined : account.costBasisCents / 100,
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
			costBasisCents: form.accountType === 'brokerage' ? cents(form.costBasis) : null,
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
			showToast(editingId ? 'Account updated.' : 'Account added.');
		} catch (error) {
			formError = readableError(error, 'The account could not be saved.');
		} finally {
			busy = false;
		}
	}

	async function reloadAccounts(): Promise<void> {
		const response = await requestJson<{ accounts: FinancialAccount[] }>(resolve('/api/accounts'));
		accounts = response.accounts;
	}

	async function syncConnectedAccounts(): Promise<void> {
		if (syncing || connections.length === 0) return;
		syncing = true;
		pageError = '';
		try {
			await requestJson(resolve('/api/connections/sync'), { method: 'POST' });
			await reloadAccounts();
			showToast('Connected balances and holdings are up to date.');
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
				{#if plaidConfigured}
					<a
						class="finance-button secondary"
						href={connections.length > 0 ? resolve('/#plaid-connections') : resolve('/')}
					>
						{connections.length > 0 ? 'Manage connections' : 'Connect a provider'}
					</a>
				{/if}
				{#if connections.length > 0}
					<button
						class="finance-button secondary"
						type="button"
						onclick={syncConnectedAccounts}
						disabled={syncing}
					>
						{syncing ? 'Syncing…' : 'Sync accounts'}
					</button>
				{/if}
				<button class="finance-button" type="button" onclick={openAdd}>+ Add manually</button>
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
				<span>Brokerage performance</span>
				<strong
					>{loading
						? '—'
						: formatMoney(brokeragePerformanceCount ? brokerageGainCents : null)}</strong
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
						<a class="finance-button" href={resolve('/')}>Connect a provider</a>
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
						<p>Credit cards remain on the Dashboard with their payment details.</p>
					</div>
					{#if hiddenAccounts.length > 0}
						<button
							class="hidden-accounts-toggle"
							type="button"
							aria-expanded={showHidden}
							onclick={() => (showHidden = !showHidden)}
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
								<div class="finance-grid">
									{#each accountGroup.accounts as account (account.id)}
										{@const bonusOffers = availableBonusOffers(account)}
										<article
											class:brokerage-with-holdings={account.accountType === 'brokerage' &&
												account.holdings.length > 0}
											class:hidden-account={account.hidden}
											class="finance-card"
										>
											<header>
												<div>
													<h4>{account.nickname}</h4>
													<p>
														{account.institution ?? 'Institution not entered'}{account.last4
															? ` · •••• ${account.last4}`
															: ''}
													</p>
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
												<div>
													<dt>Ownership</dt>
													<dd>{account.ownerType === 'business' ? 'Business' : 'Personal'}</dd>
												</div>
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
														<dt>Performance</dt>
														<dd
															class:gain={performance(account) !== null &&
																(performance(account) ?? 0) >= 0}
														>
															{performanceLabel(account)}
														</dd>
													</div>
												{/if}
											</dl>
											{#if bonusOffers.length > 0}
												<section class="bonus-offer-callout" aria-label="Verified bonus offers">
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
												<section class="holding-list" aria-label={`${account.nickname} holdings`}>
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
															aria-label="Stocks and current prices"
														>
															<div class="holding-row heading" role="row">
																<span role="columnheader">Holding</span>
																<span role="columnheader">Shares</span>
																<span role="columnheader">Current price</span>
																<span role="columnheader">Value</span>
															</div>
															{#each account.holdings as holding, index (index)}
																<div class="holding-row" role="row">
																	<span class="holding-name" role="cell">
																		<strong>{holding.tickerSymbol ?? holding.name}</strong>
																		<small>
																			{holding.tickerSymbol
																				? holding.name
																				: (holding.securityType ?? 'Security')}
																		</small>
																	</span>
																	<span role="cell" data-label="Shares"
																		>{formatQuantity(holding.quantity)}</span
																	>
																	<span
																		class="holding-price"
																		role="cell"
																		data-label="Current price"
																	>
																		<strong>{formatPrice(holding)}</strong>
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
															No holdings are available from the provider yet. Sync again after
															investment data is ready.
														</p>
													{/if}
												</section>
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
					<div class="finance-field">
						<label for="account-owner">Ownership</label>
						<select id="account-owner" bind:value={form.ownerType}>
							<option value="personal">Personal</option>
							<option value="business">Business</option>
						</select>
					</div>
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
					{#if form.accountType === 'brokerage'}
						<div class="finance-field">
							<label for="account-cost-basis">
								{dialogAccount?.source === 'connected'
									? 'Cost basis fallback'
									: 'Cost basis / contributions'}
							</label>
							<input
								id="account-cost-basis"
								type="number"
								min="0"
								step="0.01"
								bind:value={form.costBasis}
								placeholder="0.00"
							/>
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

	.finance-card h4 {
		margin: 0;
		font-size: 1rem;
		font-weight: 750;
		letter-spacing: -0.025em;
	}

	.finance-card.brokerage-with-holdings {
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
		.finance-card.brokerage-with-holdings {
			grid-column: auto;
		}

		.account-toolbar-actions {
			display: grid;
			width: 100%;
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
	}
</style>
