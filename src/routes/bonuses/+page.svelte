<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import {
		buildBonusOfferDraft,
		buildBonusTracker,
		getBonusOfferTemplate,
		getCompatibleBonusOffers,
		isOfferDateEligible,
		resolveBonusOffer,
		type BonusTracker
	} from '$lib/bonus-offers';
	import WorkspaceHeader from '$lib/components/WorkspaceHeader.svelte';
	import type {
		AccountBonus,
		BonusStatus,
		FinancialAccount,
		FinancialAccountTransaction,
		TransactionHistoryStatus
	} from '$lib/types';
	import '$lib/finance-pages.css';

	type RuntimeMode = 'local' | 'cloud';
	type SessionResponse = { mode: RuntimeMode; authenticated: boolean };
	type AccountActivity = {
		transactions: FinancialAccountTransaction[];
		status: TransactionHistoryStatus;
		lastSyncedAt: string | null;
	};
	type BonusForm = {
		offerTemplateId: string;
		name: string;
		institution: string;
		accountId: string;
		reward: number | undefined;
		status: BonusStatus;
		openedDate: string;
		requirementDeadline: string;
		expectedPayoutDate: string;
		paidDate: string;
		safeToCloseDate: string;
		requirementsText: string;
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
	const activeStatuses = new Set<BonusStatus>(['planned', 'active', 'qualified', 'pending']);

	let mode = $state<RuntimeMode | null>(null);
	let bonuses = $state<AccountBonus[]>([]);
	let accounts = $state<FinancialAccount[]>([]);
	let loading = $state(true);
	let pageError = $state('');
	let dialogOpen = $state(false);
	let editingId = $state<string | null>(null);
	let form = $state<BonusForm>(blankForm());
	let formError = $state('');
	let busy = $state(false);
	let deletingId = $state<string | null>(null);
	let requirementBusy = $state<string | null>(null);
	let activityByAccount = $state<Record<string, AccountActivity>>({});
	let activityErrors = $state<Record<string, string>>({});
	let syncingAccountId = $state<string | null>(null);
	let loggingOut = $state(false);
	let toast = $state('');
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	let queryPrefillHandled = false;

	const activeBonuses = $derived(bonuses.filter((bonus) => activeStatuses.has(bonus.status)));
	const pendingValueCents = $derived(
		activeBonuses.reduce((total, bonus) => total + (bonus.rewardCents ?? 0), 0)
	);
	const paidBonuses = $derived(bonuses.filter((bonus) => bonus.status === 'paid'));
	const earnedValueCents = $derived(
		paidBonuses.reduce((total, bonus) => total + (bonus.rewardCents ?? 0), 0)
	);
	const upcomingBonuses = $derived(
		activeBonuses
			.filter((bonus) => bonus.requirementDeadline)
			.toSorted((left, right) =>
				(left.requirementDeadline ?? '').localeCompare(right.requirementDeadline ?? '')
			)
	);
	const dueSoonCount = $derived(
		upcomingBonuses.filter((bonus) => daysUntil(bonus.requirementDeadline) <= 30).length
	);
	const nextBonus = $derived(upcomingBonuses[0] ?? null);
	const formAccount = $derived(accounts.find((account) => account.id === form.accountId) ?? null);
	const compatibleOffers = $derived(
		getCompatibleBonusOffers(formAccount, form.openedDate || formAccount?.openedDate || null)
	);
	const selectedOffer = $derived(getBonusOfferTemplate(form.offerTemplateId || null));
	const selectableOffers = $derived(
		selectedOffer && !compatibleOffers.some((offer) => offer.id === selectedOffer.id)
			? [selectedOffer, ...compatibleOffers]
			: compatibleOffers
	);
	const selectedOfferDateWarning = $derived(
		selectedOffer && form.openedDate && !isOfferDateEligible(selectedOffer, form.openedDate)
			? `This version was available ${selectedOffer.validFrom ? `from ${formatDate(selectedOffer.validFrom)} ` : ''}through ${formatDate(selectedOffer.validThrough)}.`
			: ''
	);

	onMount(() => {
		void initialize();
	});

	function blankForm(): BonusForm {
		return {
			offerTemplateId: '',
			name: '',
			institution: '',
			accountId: '',
			reward: undefined,
			status: 'active',
			openedDate: '',
			requirementDeadline: '',
			expectedPayoutDate: '',
			paidDate: '',
			safeToCloseDate: '',
			requirementsText: '',
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
			const [bonusResponse, accountResponse] = await Promise.all([
				requestJson<{ bonuses: AccountBonus[] }>(resolve('/api/bonuses')),
				requestJson<{ accounts: FinancialAccount[] }>(resolve('/api/accounts'))
			]);
			bonuses = bonusResponse.bonuses;
			accounts = accountResponse.accounts;
			await loadLinkedAccountActivity(bonusResponse.bonuses, accountResponse.accounts);
			if (!queryPrefillHandled) {
				queryPrefillHandled = true;
				const accountId = new URL(window.location.href).searchParams.get('accountId');
				if (accountId && accountResponse.accounts.some((account) => account.id === accountId)) {
					openAddForAccount(accountId);
				}
			}
		} catch (error) {
			pageError = readableError(error, 'Your bonuses could not be loaded.');
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
		return value === null ? 'Value not entered' : money.format(value / 100);
	}

	function formatDate(value: string | null): string {
		return value ? fullDate.format(new Date(`${value}T12:00:00`)) : 'Not entered';
	}

	function formatSyncTime(value: string | null): string {
		if (!value) return 'Not checked yet';
		return new Intl.DateTimeFormat('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		}).format(new Date(value));
	}

	function daysUntil(value: string | null): number {
		if (!value) return Number.POSITIVE_INFINITY;
		const today = new Date();
		const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
		const target = new Date(`${value}T00:00:00Z`).getTime();
		return Math.ceil((target - start) / 86_400_000);
	}

	function deadlineLabel(value: string | null): string {
		const days = daysUntil(value);
		if (!Number.isFinite(days)) return 'No requirement deadline';
		if (days < 0) return `${Math.abs(days)}d overdue`;
		if (days === 0) return 'Due today';
		if (days === 1) return 'Due tomorrow';
		return `${days}d remaining`;
	}

	function deadlineTone(value: string | null): 'good' | 'warn' | 'muted' {
		const days = daysUntil(value);
		if (!Number.isFinite(days)) return 'muted';
		return days <= 30 ? 'warn' : 'good';
	}

	function statusLabel(status: BonusStatus): string {
		return {
			planned: 'Planned',
			active: 'In progress',
			qualified: 'Qualified',
			pending: 'Payout pending',
			paid: 'Paid',
			closed: 'Closed',
			abandoned: 'Abandoned'
		}[status];
	}

	function statusTone(status: BonusStatus): 'good' | 'warn' | 'muted' {
		if (status === 'paid' || status === 'qualified') return 'good';
		if (status === 'active' || status === 'pending') return 'warn';
		return 'muted';
	}

	function linkedAccount(bonus: AccountBonus): FinancialAccount | null {
		return accounts.find((account) => account.id === bonus.accountId) ?? null;
	}

	function trackerFor(bonus: AccountBonus): BonusTracker | null {
		const account = linkedAccount(bonus);
		return buildBonusTracker(
			bonus,
			account,
			account ? (activityByAccount[account.id]?.transactions ?? []) : []
		);
	}

	async function loadAccountActivity(account: FinancialAccount): Promise<void> {
		if (account.source !== 'plaid' || !account.transactionHistoryEnabled) return;
		try {
			const activity = await requestJson<AccountActivity>(
				resolve('/api/accounts/[id]/transactions', { id: account.id })
			);
			activityByAccount = { ...activityByAccount, [account.id]: activity };
			activityErrors = { ...activityErrors, [account.id]: '' };
		} catch (error) {
			activityErrors = {
				...activityErrors,
				[account.id]: readableError(error, 'Linked account activity could not be loaded.')
			};
		}
	}

	async function loadLinkedAccountActivity(
		loadedBonuses: AccountBonus[],
		loadedAccounts: FinancialAccount[]
	): Promise<void> {
		const linkedIds = new Set(loadedBonuses.map((bonus) => bonus.accountId).filter(Boolean));
		await Promise.all(
			loadedAccounts
				.filter((account) => linkedIds.has(account.id))
				.map((account) => loadAccountActivity(account))
		);
	}

	async function checkLinkedAccount(bonus: AccountBonus): Promise<void> {
		const account = linkedAccount(bonus);
		if (!account?.plaidConnectionId || syncingAccountId) return;
		const offer = resolveBonusOffer(bonus, account);
		syncingAccountId = account.id;
		activityErrors = { ...activityErrors, [account.id]: '' };
		try {
			await requestJson(
				resolve('/api/plaid/items/[id]/transactions/sync', { id: account.plaidConnectionId }),
				{ method: 'POST' }
			);
			const response = await requestJson<{ accounts: FinancialAccount[] }>(
				resolve('/api/accounts')
			);
			accounts = response.accounts;
			const refreshed = response.accounts.find((candidate) => candidate.id === account.id);
			if (refreshed) await loadAccountActivity(refreshed);
			showToast(`${offer?.institution ?? 'Linked account'} tracker updated.`);
		} catch (error) {
			activityErrors = {
				...activityErrors,
				[account.id]: readableError(error, 'The linked account could not be checked right now.')
			};
		} finally {
			syncingAccountId = null;
		}
	}

	function completedCount(bonus: AccountBonus): number {
		return bonus.requirements.filter((requirement) => requirement.completed).length;
	}

	function openAdd(): void {
		editingId = null;
		form = blankForm();
		formError = '';
		dialogOpen = true;
	}

	function openAddForAccount(accountId: string): void {
		openAdd();
		const account = accounts.find((candidate) => candidate.id === accountId);
		if (!account) return;
		form.accountId = account.id;
		form.institution = account.institution ?? '';
		form.openedDate = account.openedDate ?? '';
	}

	function openEdit(bonus: AccountBonus): void {
		editingId = bonus.id;
		const account = linkedAccount(bonus);
		form = {
			offerTemplateId: bonus.offerTemplateId ?? resolveBonusOffer(bonus, account)?.id ?? '',
			name: bonus.name,
			institution: bonus.institution ?? '',
			accountId: bonus.accountId ?? '',
			reward: bonus.rewardCents === null ? undefined : bonus.rewardCents / 100,
			status: bonus.status,
			openedDate: bonus.openedDate ?? '',
			requirementDeadline: bonus.requirementDeadline ?? '',
			expectedPayoutDate: bonus.expectedPayoutDate ?? '',
			paidDate: bonus.paidDate ?? '',
			safeToCloseDate: bonus.safeToCloseDate ?? '',
			requirementsText: bonus.requirements.map((requirement) => requirement.label).join('\n'),
			notes: bonus.notes ?? ''
		};
		formError = '';
		dialogOpen = true;
	}

	function handleAccountChange(): void {
		const account = accounts.find((candidate) => candidate.id === form.accountId);
		if (!account) {
			form.offerTemplateId = '';
			return;
		}
		form.institution = account.institution ?? form.institution;
		if (!form.openedDate && account.openedDate) form.openedDate = account.openedDate;
		if (
			form.offerTemplateId &&
			!getCompatibleBonusOffers(account, form.openedDate || account.openedDate).some(
				(offer) => offer.id === form.offerTemplateId
			)
		) {
			form.offerTemplateId = '';
		}
	}

	function applySelectedOffer(): void {
		if (!form.offerTemplateId) return;
		const offer = getBonusOfferTemplate(form.offerTemplateId);
		const openedDate = form.openedDate || formAccount?.openedDate || '';
		if (!offer || !openedDate) {
			formError = 'Enter the account opening date before applying a verified offer.';
			return;
		}
		const draft = buildBonusOfferDraft(offer, openedDate);
		if (!draft) {
			formError = 'The offer dates could not be calculated.';
			return;
		}
		formError = '';
		form = {
			...form,
			openedDate,
			name: draft.name,
			institution: draft.institution,
			reward: draft.rewardCents / 100,
			requirementDeadline: draft.requirementDeadline,
			expectedPayoutDate: draft.expectedPayoutDate,
			safeToCloseDate: draft.safeToCloseDate,
			requirementsText: draft.requirements.join('\n'),
			notes: draft.notes
		};
	}

	function handleOfferChange(): void {
		if (form.offerTemplateId) applySelectedOffer();
	}

	function handleOpenedDateChange(): void {
		if (form.offerTemplateId) applySelectedOffer();
	}

	function closeDialog(): void {
		if (busy) return;
		dialogOpen = false;
	}

	function formRequirements(): { id?: string; label: string; completed: boolean }[] {
		const existing = editingId ? bonuses.find((bonus) => bonus.id === editingId) : null;
		return form.requirementsText
			.split('\n')
			.map((label) => label.trim())
			.filter(Boolean)
			.slice(0, 20)
			.map((label) => {
				const match = existing?.requirements.find((requirement) => requirement.label === label);
				return { ...(match ? { id: match.id } : {}), label, completed: match?.completed ?? false };
			});
	}

	async function saveBonus(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (form.offerTemplateId) {
			const offer = getBonusOfferTemplate(form.offerTemplateId);
			if (!offer || !formAccount || !form.openedDate) {
				formError = 'A verified offer needs a linked account and opening date.';
				return;
			}
			if (
				!getCompatibleBonusOffers(formAccount, form.openedDate).some(
					(candidate) => candidate.id === offer.id
				)
			) {
				formError = 'That offer version does not match this account and opening date.';
				return;
			}
		}
		if (!form.name.trim()) {
			formError = 'Give this bonus a name.';
			return;
		}
		busy = true;
		formError = '';
		const payload = {
			accountId: form.accountId || null,
			offerTemplateId: form.offerTemplateId || null,
			name: form.name.trim(),
			institution: form.institution.trim() || null,
			rewardCents: cents(form.reward),
			currency: 'USD',
			status: form.status,
			openedDate: form.openedDate || null,
			requirementDeadline: form.requirementDeadline || null,
			expectedPayoutDate: form.expectedPayoutDate || null,
			paidDate: form.paidDate || null,
			safeToCloseDate: form.safeToCloseDate || null,
			requirements: formRequirements(),
			notes: form.notes.trim() || null
		};
		try {
			if (editingId) {
				await requestJson(resolve('/api/bonuses/[id]', { id: editingId }), {
					method: 'PATCH',
					body: JSON.stringify(payload)
				});
			} else {
				await requestJson(resolve('/api/bonuses'), {
					method: 'POST',
					body: JSON.stringify(payload)
				});
			}
			dialogOpen = false;
			await reloadBonuses();
			showToast(editingId ? 'Bonus updated.' : 'Bonus added.');
		} catch (error) {
			formError = readableError(error, 'The bonus could not be saved.');
		} finally {
			busy = false;
		}
	}

	async function reloadBonuses(): Promise<void> {
		const response = await requestJson<{ bonuses: AccountBonus[] }>(resolve('/api/bonuses'));
		bonuses = response.bonuses;
	}

	async function toggleRequirement(bonus: AccountBonus, requirementId: string): Promise<void> {
		requirementBusy = requirementId;
		try {
			await requestJson(resolve('/api/bonuses/[id]', { id: bonus.id }), {
				method: 'PATCH',
				body: JSON.stringify({
					requirements: bonus.requirements.map((requirement) => ({
						...requirement,
						completed:
							requirement.id === requirementId ? !requirement.completed : requirement.completed
					}))
				})
			});
			await reloadBonuses();
		} catch (error) {
			pageError = readableError(error, 'The requirement could not be updated.');
		} finally {
			requirementBusy = null;
		}
	}

	async function deleteBonus(bonus: AccountBonus): Promise<void> {
		if (!window.confirm(`Delete “${bonus.name}”? This removes its requirements and dates.`)) return;
		deletingId = bonus.id;
		try {
			await requestJson(resolve('/api/bonuses/[id]', { id: bonus.id }), { method: 'DELETE' });
			await reloadBonuses();
			showToast('Bonus deleted.');
		} catch (error) {
			pageError = readableError(error, 'The bonus could not be deleted.');
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
	<title>Bonuses — ChipDue</title>
	<meta
		name="description"
		content="Track account signup bonuses, requirements, payout dates, and safe-to-close milestones privately."
	/>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<a class="skip-link" href="#bonuses-main">Skip to bonuses</a>

<div class="finance-shell">
	<WorkspaceHeader current="bonuses" {mode} {loggingOut} onlogout={logout} />

	<main id="bonuses-main" class="finance-main">
		<section class="finance-toolbar" aria-labelledby="bonuses-title">
			<div>
				<p class="finance-kicker">Money in motion</p>
				<h1 id="bonuses-title">Bonuses</h1>
				<p>
					Choose a verified offer, then track its balance, activity, deadlines, and payout without
					asking an AI to interpret the rules each time.
				</p>
			</div>
			<button class="finance-button" type="button" onclick={openAdd}>+ Add bonus</button>
		</section>

		<section class="finance-summary" aria-label="Bonus summary">
			<article>
				<span>Active bonuses</span>
				<strong>{loading ? '—' : activeBonuses.length}</strong>
			</article>
			<article>
				<span>Potential value</span>
				<strong
					>{loading ? '—' : formatMoney(activeBonuses.length ? pendingValueCents : null)}</strong
				>
			</article>
			<article>
				<span>Earned value</span>
				<strong>{loading ? '—' : formatMoney(paidBonuses.length ? earnedValueCents : null)}</strong>
			</article>
			<article>
				<span>Next requirement</span>
				<strong>{loading ? '—' : formatDate(nextBonus?.requirementDeadline ?? null)}</strong>
			</article>
		</section>

		{#if loading}
			<div class="finance-loading" aria-busy="true">Loading your private bonus tracker…</div>
		{:else if pageError}
			<div class="finance-error" role="alert">
				<h2>Bonuses are unavailable</h2>
				<p>{pageError}</p>
				<button class="finance-button secondary" type="button" onclick={initialize}
					>Try again</button
				>
			</div>
		{:else if bonuses.length === 0}
			<div class="finance-empty">
				<h2>Put your next bonus on rails</h2>
				<p>
					Link an account and choose the exact offer you enrolled in. ChipDue calculates its
					deadlines and keeps the tracking rules fixed to that offer version.
				</p>
				<button class="finance-button" type="button" onclick={openAdd}>Add your first bonus</button>
			</div>
		{:else}
			<section aria-labelledby="bonus-list-title">
				<div class="finance-section-heading">
					<div>
						<h2 id="bonus-list-title">Bonus pipeline</h2>
						<p>{dueSoonCount} with a requirement deadline in the next 30 days or overdue.</p>
					</div>
				</div>
				<div class="finance-grid bonus-grid">
					{#each bonuses as bonus (bonus.id)}
						{@const tracker = trackerFor(bonus)}
						<article class="finance-card bonus-card" class:has-tracker={tracker !== null}>
							<header>
								<div>
									<h3>{bonus.name}</h3>
									<p>
										{linkedAccount(bonus)?.nickname ?? bonus.institution ?? 'No account linked'}
									</p>
								</div>
								<span class="finance-pill {statusTone(bonus.status)}">
									{statusLabel(bonus.status)}
								</span>
							</header>
							<div class="finance-card-value">
								<span>Bonus value</span>
								<strong>{formatMoney(bonus.rewardCents)}</strong>
							</div>

							<div class="bonus-deadline">
								<span class="finance-pill {deadlineTone(bonus.requirementDeadline)}">
									{deadlineLabel(bonus.requirementDeadline)}
								</span>
								<strong>{formatDate(bonus.requirementDeadline)}</strong>
							</div>

							{#if tracker}
								<section
									class="linked-tracker"
									aria-label={`Linked ${tracker.offer.institution} offer tracker`}
								>
									<header class="tracker-heading">
										<div>
											<span>Linked {tracker.offer.institution} offer tracker</span>
											<strong>{tracker.offer.accountProduct}</strong>
										</div>
										<span class="finance-pill good">Verified rules</span>
									</header>

									<div class="tracker-metrics">
										<div>
											<span>Current synced balance</span>
											<strong>{formatMoney(tracker.balanceCents)}</strong>
											<small>
												{#if tracker.currentTier}
													Currently tracking the {formatMoney(tracker.currentTier.rewardCents)} tier
												{:else if tracker.amountToNextTierCents !== null}
													{formatMoney(tracker.amountToNextTierCents)} to the first tier
												{:else}
													Waiting for a synced balance
												{/if}
											</small>
										</div>
										<div>
											<span>Likely qualifying activity</span>
											<strong
												>{tracker.likelyQualifyingTransactions.length} / {tracker.offer
													.transactionTarget}</strong
											>
											<small>
												{#if tracker.account.transactionHistoryStatus === 'NOT_READY'}
													Plaid is still preparing older activity
												{:else if tracker.account.transactionHistoryEnabled}
													Posted since {formatDate(bonus.openedDate)}
												{:else}
													Check now to load posted activity
												{/if}
											</small>
										</div>
									</div>

									<progress
										class="balance-progress"
										max={tracker.offer.tiers.at(-1)?.thresholdCents ?? 1}
										value={Math.max(0, tracker.balanceCents ?? 0)}
										aria-label={`Balance progress toward the ${formatMoney(tracker.offer.rewardCents)} offer`}
									></progress>

									<div
										class="tier-rail"
										class:single-tier={tracker.offer.tiers.length === 1}
										aria-label={`${tracker.offer.institution} bonus tiers`}
									>
										{#each tracker.offer.tiers as tier (tier.thresholdCents)}
											<div class:reached={(tracker.balanceCents ?? 0) >= tier.thresholdCents}>
												<strong>{formatMoney(tier.rewardCents)}</strong>
												<span>{tier.label}</span>
											</div>
										{/each}
									</div>

									<dl class="tracker-dates">
										<div>
											<dt>Fund by</dt>
											<dd>{formatDate(tracker.fundingDeadline)}</dd>
										</div>
										<div>
											<dt>Maintain through</dt>
											<dd>{formatDate(tracker.qualificationDeadline)}</dd>
										</div>
										<div>
											<dt>Payout by</dt>
											<dd>{formatDate(tracker.latestPayoutDate)}</dd>
										</div>
									</dl>

									{#if tracker.likelyQualifyingTransactions.length > 0}
										<ul class="tracker-activity" aria-label="Likely qualifying posted activity">
											{#each tracker.likelyQualifyingTransactions.slice(0, 5) as transaction (transaction.id)}
												<li>
													<strong>{transaction.merchantName ?? transaction.name}</strong>
													<span>{formatDate(transaction.date)}</span>
												</li>
											{/each}
										</ul>
									{/if}

									{#if activityErrors[tracker.account.id]}
										<p class="tracker-error" role="alert">{activityErrors[tracker.account.id]}</p>
									{/if}
									<div class="tracker-actions">
										<button
											type="button"
											disabled={syncingAccountId !== null}
											onclick={() => checkLinkedAccount(bonus)}
										>
											{syncingAccountId === tracker.account.id
												? `Checking ${tracker.offer.institution}…`
												: `Check ${tracker.offer.institution} now`}
										</button>
										<small>
											Last checked {formatSyncTime(
												activityByAccount[tracker.account.id]?.lastSyncedAt ??
													tracker.account.lastSyncedAt
											)}
										</small>
									</div>
									<p class="tracker-note">
										Balances are snapshots and cannot prove new-money sources or uninterrupted
										minimums. Activity is a conservative estimate from posted Plaid transactions. {tracker
											.offer.activityNote}
										<a href={tracker.offer.sourceUrl} target="_blank" rel="noreferrer"
											>Official terms</a
										>
										· {tracker.offer.versionLabel} · verified {formatDate(
											tracker.offer.sourceVerifiedAt
										)}.
									</p>
								</section>
							{/if}

							{#if bonus.requirements.length > 0}
								<section class="requirement-list" aria-label={`Requirements for ${bonus.name}`}>
									<div class="requirement-heading">
										<span>Requirements</span>
										<strong>{completedCount(bonus)}/{bonus.requirements.length}</strong>
									</div>
									{#each bonus.requirements as requirement (requirement.id)}
										<label class:completed={requirement.completed}>
											<input
												type="checkbox"
												checked={requirement.completed}
												disabled={requirementBusy !== null}
												onchange={() => toggleRequirement(bonus, requirement.id)}
											/>
											<span>{requirement.label}</span>
										</label>
									{/each}
								</section>
							{/if}

							<dl class="finance-details bonus-dates">
								<div>
									<dt>Expected payout</dt>
									<dd>{formatDate(bonus.expectedPayoutDate)}</dd>
								</div>
								<div>
									<dt>Safe to close</dt>
									<dd>{formatDate(bonus.safeToCloseDate)}</dd>
								</div>
							</dl>
							<footer>
								<button type="button" onclick={() => openEdit(bonus)}>Edit</button>
								<button class="delete" type="button" onclick={() => deleteBonus(bonus)}>
									{deletingId === bonus.id ? 'Deleting…' : 'Delete'}
								</button>
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
			aria-labelledby="bonus-dialog-title"
		>
			<header class="finance-dialog-header">
				<div>
					<h2 id="bonus-dialog-title">{editingId ? 'Edit bonus' : 'Add bonus'}</h2>
					<p>Confirm the exact offer; ChipDue will lock in that published version’s rules.</p>
				</div>
				<button type="button" aria-label="Close" onclick={closeDialog}>×</button>
			</header>
			<form class="finance-form" onsubmit={saveBonus}>
				{#if formError}<p class="finance-form-error" role="alert">{formError}</p>{/if}
				<div class="finance-form-grid">
					<div class="finance-field">
						<label for="bonus-name">Bonus name</label>
						<input
							id="bonus-name"
							bind:value={form.name}
							maxlength="80"
							readonly={Boolean(form.offerTemplateId)}
							required
						/>
					</div>
					<div class="finance-field">
						<label for="bonus-value">Bonus value</label>
						<input
							id="bonus-value"
							type="number"
							min="0"
							step="0.01"
							bind:value={form.reward}
							readonly={Boolean(form.offerTemplateId)}
							placeholder="500.00"
						/>
					</div>
					<div class="finance-field">
						<label for="bonus-account">Linked account</label>
						<select id="bonus-account" bind:value={form.accountId} onchange={handleAccountChange}>
							<option value="">No linked account</option>
							{#each accounts as account (account.id)}
								<option value={account.id}>{account.nickname}</option>
							{/each}
						</select>
					</div>
					<div class="finance-field wide offer-picker">
						<label for="bonus-offer">Verified offer</label>
						<select
							id="bonus-offer"
							bind:value={form.offerTemplateId}
							onchange={handleOfferChange}
							disabled={!formAccount}
						>
							<option value="">Manual rules</option>
							{#each selectableOffers as offer (offer.id)}
								<option value={offer.id}>
									{offer.name} · {offer.versionLabel}
								</option>
							{/each}
						</select>
						<small>
							{#if !formAccount}
								Link an account first to see matching offers.
							{:else if compatibleOffers.length > 0}
								Choose the exact offer you enrolled in. Your bank connection cannot confirm the
								promotion code for you.
							{:else}
								No current verified offer matches this account and opening date. Use manual rules.
							{/if}
						</small>
						{#if selectedOfferDateWarning}
							<small class="offer-warning">{selectedOfferDateWarning}</small>
						{/if}
					</div>
					<div class="finance-field">
						<label for="bonus-institution">Institution</label>
						<input
							id="bonus-institution"
							bind:value={form.institution}
							maxlength="80"
							readonly={Boolean(form.offerTemplateId)}
						/>
					</div>
					<div class="finance-field">
						<label for="bonus-status">Status</label>
						<select id="bonus-status" bind:value={form.status}>
							<option value="planned">Planned</option>
							<option value="active">In progress</option>
							<option value="qualified">Qualified</option>
							<option value="pending">Payout pending</option>
							<option value="paid">Paid</option>
							<option value="closed">Closed</option>
							<option value="abandoned">Abandoned</option>
						</select>
					</div>
					<div class="finance-field">
						<label for="bonus-opened">Account opened</label>
						<input
							id="bonus-opened"
							type="date"
							bind:value={form.openedDate}
							onchange={handleOpenedDateChange}
						/>
					</div>
					<div class="finance-field">
						<label for="bonus-deadline">Requirement deadline</label>
						<input
							id="bonus-deadline"
							type="date"
							bind:value={form.requirementDeadline}
							readonly={Boolean(form.offerTemplateId)}
						/>
					</div>
					<div class="finance-field">
						<label for="bonus-payout">Expected payout</label>
						<input
							id="bonus-payout"
							type="date"
							bind:value={form.expectedPayoutDate}
							readonly={Boolean(form.offerTemplateId)}
						/>
					</div>
					<div class="finance-field">
						<label for="bonus-paid">Paid date</label>
						<input id="bonus-paid" type="date" bind:value={form.paidDate} />
					</div>
					<div class="finance-field">
						<label for="bonus-close">Safe to close</label>
						<input
							id="bonus-close"
							type="date"
							bind:value={form.safeToCloseDate}
							readonly={Boolean(form.offerTemplateId)}
						/>
					</div>
					<div class="finance-field wide">
						<label for="bonus-requirements">Requirements</label>
						<textarea
							id="bonus-requirements"
							bind:value={form.requirementsText}
							readonly={Boolean(form.offerTemplateId)}
							placeholder="Receive two qualifying direct deposits&#10;Maintain the required balance for 90 days"
						></textarea>
						<small>One requirement per line, up to 20. Existing checkmarks are preserved.</small>
					</div>
					<div class="finance-field wide">
						<label for="bonus-notes">Private notes</label>
						<textarea id="bonus-notes" bind:value={form.notes} maxlength="2000"></textarea>
					</div>
				</div>
				<div class="finance-form-actions">
					<button class="finance-button secondary" type="button" onclick={closeDialog}
						>Cancel</button
					>
					<button class="finance-button" type="submit" disabled={busy}>
						{busy ? 'Saving…' : editingId ? 'Save changes' : 'Add bonus'}
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

	.bonus-card {
		min-height: 390px;
	}

	.bonus-card.has-tracker {
		grid-column: span 2;
	}

	.bonus-deadline {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		justify-content: space-between;
		padding: 0.65rem 0;
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}

	.bonus-deadline > strong {
		font-size: 0.68rem;
	}

	.linked-tracker {
		display: grid;
		gap: 0.75rem;
		margin-top: 0.85rem;
		padding: 0.9rem;
		border: 1px solid rgba(61, 90, 254, 0.22);
		border-radius: 12px;
		background: linear-gradient(145deg, rgba(61, 90, 254, 0.075), rgba(255, 253, 249, 0.82));
	}

	.tracker-heading,
	.tracker-actions,
	.tracker-activity li {
		display: flex;
		gap: 0.7rem;
		align-items: center;
		justify-content: space-between;
	}

	.tracker-heading > div {
		display: grid;
		gap: 0.16rem;
	}

	.tracker-heading > div > span,
	.tracker-metrics span,
	.tracker-dates dt {
		color: var(--faint);
		font-size: 0.58rem;
		font-weight: 740;
		letter-spacing: 0.045em;
		text-transform: uppercase;
	}

	.tracker-heading > div > strong {
		font-size: 0.82rem;
	}

	.tracker-metrics {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.55rem;
	}

	.tracker-metrics > div {
		display: grid;
		gap: 0.18rem;
		padding: 0.62rem;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: rgba(255, 255, 255, 0.7);
	}

	.tracker-metrics strong {
		font-size: 1rem;
	}

	.tracker-metrics small,
	.tracker-actions small {
		color: var(--muted);
		font-size: 0.59rem;
		line-height: 1.35;
	}

	.balance-progress {
		width: 100%;
		height: 8px;
		border: 0;
		border-radius: 999px;
		overflow: hidden;
		background: rgba(61, 90, 254, 0.12);
	}

	.balance-progress::-webkit-progress-bar {
		background: rgba(61, 90, 254, 0.12);
	}

	.balance-progress::-webkit-progress-value,
	.balance-progress::-moz-progress-bar {
		border-radius: 999px;
		background: var(--accent);
	}

	.tier-rail,
	.tracker-dates {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.45rem;
	}

	.tier-rail.single-tier {
		grid-template-columns: minmax(0, 1fr);
	}

	.tier-rail > div,
	.tracker-dates > div {
		display: grid;
		gap: 0.14rem;
		padding: 0.5rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.58);
	}

	.tier-rail > div.reached {
		border-color: rgba(34, 139, 94, 0.35);
		background: rgba(34, 139, 94, 0.09);
	}

	.tier-rail strong {
		font-size: 0.72rem;
	}

	.tier-rail span,
	.tracker-dates dd,
	.tracker-activity li {
		margin: 0;
		color: var(--ink-soft);
		font-size: 0.61rem;
	}

	.tracker-activity {
		display: grid;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.tracker-activity li {
		padding: 0.34rem 0.45rem;
		border-radius: 7px;
		background: rgba(255, 255, 255, 0.56);
	}

	.tracker-activity li span {
		color: var(--faint);
		white-space: nowrap;
	}

	.tracker-actions button {
		padding: 0.5rem 0.7rem;
		border: 1px solid var(--accent);
		border-radius: 7px;
		color: var(--accent-dark);
		font-size: 0.62rem;
		font-weight: 740;
		background: white;
		cursor: pointer;
	}

	.tracker-actions button:disabled {
		opacity: 0.55;
		cursor: wait;
	}

	.tracker-error,
	.tracker-note {
		margin: 0;
		font-size: 0.59rem;
		line-height: 1.45;
	}

	.tracker-error {
		color: var(--red);
	}

	.tracker-note {
		color: var(--muted);
	}

	.tracker-note a {
		color: var(--accent-dark);
		font-weight: 740;
	}

	.offer-picker small {
		display: block;
		line-height: 1.45;
	}

	.offer-picker .offer-warning {
		color: var(--red);
	}

	.requirement-list {
		display: grid;
		gap: 0.35rem;
		margin-top: 0.8rem;
	}

	.requirement-heading {
		display: flex;
		justify-content: space-between;
		margin-bottom: 0.15rem;
		color: var(--faint);
		font-size: 0.6rem;
		font-weight: 720;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.requirement-list label {
		display: flex;
		gap: 0.48rem;
		align-items: flex-start;
		padding: 0.36rem 0.42rem;
		border-radius: 7px;
		color: var(--ink-soft);
		font-size: 0.68rem;
		line-height: 1.35;
		background: var(--paper-soft);
		cursor: pointer;
	}

	.requirement-list label.completed {
		color: var(--faint);
		text-decoration: line-through;
	}

	.requirement-list input {
		margin: 0.08rem 0 0;
		accent-color: var(--positive);
	}

	.bonus-dates {
		margin-top: 0.85rem;
	}

	@media (max-width: 1040px) {
		.bonus-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 620px) {
		.bonus-grid {
			grid-template-columns: 1fr;
		}

		.bonus-card.has-tracker {
			grid-column: span 1;
		}

		.tracker-metrics,
		.tier-rail,
		.tracker-dates {
			grid-template-columns: 1fr;
		}

		.tracker-actions {
			align-items: flex-start;
			flex-direction: column;
		}
	}
</style>
