<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import WorkspaceHeader from '$lib/components/WorkspaceHeader.svelte';
	import type { AccountBonus, BonusStatus, FinancialAccount } from '$lib/types';
	import '$lib/finance-pages.css';

	type RuntimeMode = 'local' | 'cloud';
	type SessionResponse = { mode: RuntimeMode; authenticated: boolean };
	type BonusForm = {
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
	let loggingOut = $state(false);
	let toast = $state('');
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

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

	onMount(() => {
		void initialize();
	});

	function blankForm(): BonusForm {
		return {
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

	function completedCount(bonus: AccountBonus): number {
		return bonus.requirements.filter((requirement) => requirement.completed).length;
	}

	function openAdd(): void {
		editingId = null;
		form = blankForm();
		formError = '';
		dialogOpen = true;
	}

	function openEdit(bonus: AccountBonus): void {
		editingId = bonus.id;
		form = {
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
		if (!form.name.trim()) {
			formError = 'Give this bonus a name.';
			return;
		}
		busy = true;
		formError = '';
		const payload = {
			accountId: form.accountId || null,
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
					Track every requirement from account opening through payout and the date it becomes safe
					to close. Check off progress without relying on a bank’s interpretation of your activity.
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
					Add the offer value, deadline, payout window, and each requirement. You can link it to an
					account now or later.
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
						<article class="finance-card bonus-card">
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
					<p>Store the bank’s rules as a checklist, then verify completion yourself.</p>
				</div>
				<button type="button" aria-label="Close" onclick={closeDialog}>×</button>
			</header>
			<form class="finance-form" onsubmit={saveBonus}>
				{#if formError}<p class="finance-form-error" role="alert">{formError}</p>{/if}
				<div class="finance-form-grid">
					<div class="finance-field">
						<label for="bonus-name">Bonus name</label>
						<input id="bonus-name" bind:value={form.name} maxlength="80" required />
					</div>
					<div class="finance-field">
						<label for="bonus-value">Bonus value</label>
						<input
							id="bonus-value"
							type="number"
							min="0"
							step="0.01"
							bind:value={form.reward}
							placeholder="500.00"
						/>
					</div>
					<div class="finance-field">
						<label for="bonus-account">Linked account</label>
						<select id="bonus-account" bind:value={form.accountId}>
							<option value="">No linked account</option>
							{#each accounts as account (account.id)}
								<option value={account.id}>{account.nickname}</option>
							{/each}
						</select>
					</div>
					<div class="finance-field">
						<label for="bonus-institution">Institution</label>
						<input id="bonus-institution" bind:value={form.institution} maxlength="80" />
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
						<input id="bonus-opened" type="date" bind:value={form.openedDate} />
					</div>
					<div class="finance-field">
						<label for="bonus-deadline">Requirement deadline</label>
						<input id="bonus-deadline" type="date" bind:value={form.requirementDeadline} />
					</div>
					<div class="finance-field">
						<label for="bonus-payout">Expected payout</label>
						<input id="bonus-payout" type="date" bind:value={form.expectedPayoutDate} />
					</div>
					<div class="finance-field">
						<label for="bonus-paid">Paid date</label>
						<input id="bonus-paid" type="date" bind:value={form.paidDate} />
					</div>
					<div class="finance-field">
						<label for="bonus-close">Safe to close</label>
						<input id="bonus-close" type="date" bind:value={form.safeToCloseDate} />
					</div>
					<div class="finance-field wide">
						<label for="bonus-requirements">Requirements</label>
						<textarea
							id="bonus-requirements"
							bind:value={form.requirementsText}
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
	}
</style>
