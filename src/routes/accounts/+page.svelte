<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import WorkspaceHeader from '$lib/components/WorkspaceHeader.svelte';
	import type {
		FinancialAccount,
		FinancialAccountOwner,
		FinancialAccountStatus,
		FinancialAccountType,
		PlaidConnection
	} from '$lib/types';
	import '$lib/finance-pages.css';

	type RuntimeMode = 'local' | 'cloud';
	type SessionResponse = { mode: RuntimeMode; authenticated: boolean };
	type PlaidStatusResponse = { configured: boolean; connections: PlaidConnection[] };
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
	let loggingOut = $state(false);
	let plaidConfigured = $state(false);
	let plaidConnections = $state<PlaidConnection[]>([]);
	let syncing = $state(false);
	let toast = $state('');
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	const activeAccounts = $derived(accounts.filter((account) => account.status === 'active'));
	const syncedAccountCount = $derived(
		activeAccounts.filter((account) => account.source === 'plaid').length
	);
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
			const [accountResponse, plaidResponse] = await Promise.all([
				requestJson<{ accounts: FinancialAccount[] }>(resolve('/api/accounts')),
				requestJson<PlaidStatusResponse>(resolve('/api/plaid/status'))
			]);
			accounts = accountResponse.accounts;
			plaidConfigured = plaidResponse.configured;
			plaidConnections = plaidResponse.connections;
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
			editingAccount?.source === 'plaid'
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
			if (editingId) {
				await requestJson(resolve('/api/accounts/[id]', { id: editingId }), {
					method: 'PATCH',
					body: JSON.stringify(payload)
				});
			} else {
				await requestJson(resolve('/api/accounts'), {
					method: 'POST',
					body: JSON.stringify(payload)
				});
			}
			dialogOpen = false;
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

	async function syncPlaidAccounts(): Promise<void> {
		if (syncing || plaidConnections.length === 0) return;
		syncing = true;
		pageError = '';
		try {
			await requestJson(resolve('/api/plaid/sync'), { method: 'POST' });
			await reloadAccounts();
			showToast('Plaid balances are up to date.');
		} catch (error) {
			pageError = readableError(error, 'Plaid accounts could not be synced.');
		} finally {
			syncing = false;
		}
	}

	async function deleteAccount(account: FinancialAccount): Promise<void> {
		if (account.source === 'plaid') return;
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

	function showToast(message: string): void {
		toast = message;
		if (toastTimer) clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = ''), 3_000);
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
					Use manual accounts only when Plaid cannot cover an institution.
				</p>
			</div>
			<div class="account-toolbar-actions">
				{#if plaidConfigured}
					<a
						class="finance-button secondary"
						href={plaidConnections.length > 0 ? resolve('/#plaid-connections') : resolve('/')}
					>
						{plaidConnections.length > 0 ? 'Manage Plaid' : 'Connect Plaid'}
					</a>
				{/if}
				{#if plaidConnections.length > 0}
					<button
						class="finance-button secondary"
						type="button"
						onclick={syncPlaidAccounts}
						disabled={syncing}
					>
						{syncing ? 'Syncing…' : 'Sync balances'}
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
				<span>Plaid-synced</span>
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
					Plaid can pull eligible bank and brokerage balances into this account map. You can still
					add an unsupported account once and maintain it manually.
				</p>
				<div class="empty-account-actions">
					{#if plaidConfigured}
						<a class="finance-button" href={resolve('/')}>Connect with Plaid</a>
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
				</div>
				<div class="finance-grid">
					{#each accounts as account (account.id)}
						<article class="finance-card">
							<header>
								<div>
									<h3>{account.nickname}</h3>
									<p>
										{account.institution ?? 'Institution not entered'}{account.last4
											? ` · •••• ${account.last4}`
											: ''}
									</p>
								</div>
								<div class="account-pills">
									<span class:plaid={account.source === 'plaid'} class="finance-pill source">
										{account.source === 'plaid' ? 'Plaid' : 'Manual'}
									</span>
									<span
										class:good={account.status === 'active'}
										class:muted={account.status !== 'active'}
										class="finance-pill"
									>
										{account.status}
									</span>
								</div>
							</header>
							<div class="finance-card-value">
								<span>{account.source === 'plaid' ? 'Synced balance' : 'Current balance'}</span>
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
										{account.source === 'plaid'
											? formatSyncTime(account.lastSyncedAt)
											: 'Manual entry'}
									</dd>
								</div>
								{#if account.accountType === 'brokerage'}
									<div>
										<dt>Performance</dt>
										<dd
											class:gain={performance(account) !== null && (performance(account) ?? 0) >= 0}
										>
											{performanceLabel(account)}
										</dd>
									</div>
								{/if}
							</dl>
							<footer>
								<span>{account.source === 'plaid' ? 'Automatic balance' : 'Manual balance'}</span>
								<div>
									<button type="button" onclick={() => openEdit(account)}>
										{account.source === 'plaid' ? 'Details' : 'Edit'}
									</button>
									{#if account.source === 'manual'}
										<button class="delete" type="button" onclick={() => deleteAccount(account)}>
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
						{dialogAccount?.source === 'plaid'
							? 'Account details'
							: editingId
								? 'Edit account'
								: 'Add account'}
					</h2>
					<p>
						{dialogAccount?.source === 'plaid'
							? 'Plaid keeps the balance and bank details current. Add the personal details you want ChipDue to remember.'
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
							disabled={dialogAccount?.source === 'plaid'}
						/>
					</div>
					<div class="finance-field">
						<label for="account-type">Account type</label>
						<select
							id="account-type"
							bind:value={form.accountType}
							disabled={dialogAccount?.source === 'plaid'}
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
							disabled={dialogAccount?.source === 'plaid'}
						/>
					</div>
					{#if form.accountType === 'brokerage'}
						<div class="finance-field">
							<label for="account-cost-basis">
								{dialogAccount?.source === 'plaid'
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
							disabled={dialogAccount?.source === 'plaid'}
						/>
					</div>
					<div class="finance-field">
						<label for="account-status">Status</label>
						<select
							id="account-status"
							bind:value={form.status}
							disabled={dialogAccount?.source === 'plaid'}
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
							: dialogAccount?.source === 'plaid'
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

{#if toast}<div class="finance-toast" role="status">{toast}</div>{/if}

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

	.finance-pill.source.plaid {
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

	.finance-field input:disabled,
	.finance-field select:disabled {
		color: var(--muted);
		background: var(--paper-soft);
		cursor: not-allowed;
	}

	@media (max-width: 620px) {
		.account-toolbar-actions {
			display: grid;
			width: 100%;
		}
	}
</style>
