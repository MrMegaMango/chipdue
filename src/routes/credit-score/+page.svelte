<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import CreditScoreChart from '$lib/components/CreditScoreChart.svelte';
	import WorkspaceHeader from '$lib/components/WorkspaceHeader.svelte';
	import type { CreditBureau, CreditScoreEntry } from '$lib/credit-score-types';
	import {
		creditBureauLabel,
		creditScoreChange,
		creditScoreRange,
		previousComparableScore
	} from '$lib/credit-scores';
	import '$lib/finance-pages.css';

	type RuntimeMode = 'local' | 'cloud';
	type SessionResponse = { mode: RuntimeMode; authenticated: boolean };
	type ScoreForm = {
		score: number | undefined;
		bureau: CreditBureau;
		model: string;
		source: string;
		recordedDate: string;
		notes: string;
	};

	const fullDate = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
	const preapprovalTools = [
		{
			name: 'Capital One',
			href: 'https://www.capitalone.com/apply/credit-cards/preapprove/',
			detail: 'Checks personalized card eligibility with a soft inquiry.'
		},
		{
			name: 'Citi',
			href: 'https://online.citi.com/US/nga/cards/pre-qualify',
			detail: 'Shows available pre-qualified offers and terms before applying.'
		},
		{
			name: 'Discover',
			href: 'https://cards.discover.com/apply/credit-cards/discover/preapprove/',
			detail: 'Checks for pre-approved Discover offers without a hard inquiry.'
		},
		{
			name: 'American Express',
			href: 'https://www.americanexpress.com/us/credit-cards/',
			detail: 'Lets you know approval and the welcome offer before accepting a card.'
		}
	];

	let mode = $state<RuntimeMode | null>(null);
	let entries = $state<CreditScoreEntry[]>([]);
	let loading = $state(true);
	let pageError = $state('');
	let dialogOpen = $state(false);
	let editingId = $state<string | null>(null);
	let form = $state<ScoreForm>(blankForm());
	let formError = $state('');
	let busy = $state(false);
	let deletingId = $state<string | null>(null);
	let loggingOut = $state(false);
	let toast = $state('');
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	const latestEntry = $derived(entries[0] ?? null);
	const previousEntry = $derived(previousComparableScore(entries, latestEntry));
	const scoreChange = $derived(creditScoreChange(entries, latestEntry));
	const bureauCount = $derived(new Set(entries.map((entry) => entry.bureau)).size);

	onMount(() => {
		void initialize();
	});

	function today(): string {
		const date = new Date();
		return [
			date.getFullYear(),
			String(date.getMonth() + 1).padStart(2, '0'),
			String(date.getDate()).padStart(2, '0')
		].join('-');
	}

	function blankForm(): ScoreForm {
		return {
			score: undefined,
			bureau: 'experian',
			model: '',
			source: '',
			recordedDate: today(),
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
			await reloadEntries();
		} catch (error) {
			pageError = readableError(error, 'Your credit score history could not be loaded.');
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

	function formatDate(value: string | null): string {
		return value ? fullDate.format(new Date(`${value}T12:00:00`)) : 'No reading yet';
	}

	function formatChange(value: number | null): string {
		if (value === null) return 'Baseline';
		if (value === 0) return 'No change';
		return `${value > 0 ? '+' : '−'}${Math.abs(value)} points`;
	}

	function openAdd(): void {
		editingId = null;
		form = blankForm();
		formError = '';
		dialogOpen = true;
	}

	function openEdit(entry: CreditScoreEntry): void {
		editingId = entry.id;
		form = {
			score: entry.score,
			bureau: entry.bureau,
			model: entry.model ?? '',
			source: entry.source ?? '',
			recordedDate: entry.recordedDate,
			notes: entry.notes ?? ''
		};
		formError = '';
		dialogOpen = true;
	}

	function closeDialog(): void {
		if (!busy) dialogOpen = false;
	}

	async function saveEntry(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!Number.isInteger(form.score) || form.score! < 300 || form.score! > 850) {
			formError = 'Enter a whole-number score from 300 to 850.';
			return;
		}
		busy = true;
		formError = '';
		const payload = {
			score: form.score,
			bureau: form.bureau,
			model: form.model.trim() || null,
			source: form.source.trim() || null,
			recordedDate: form.recordedDate,
			notes: form.notes.trim() || null
		};
		try {
			if (editingId) {
				await requestJson(resolve('/api/credit-scores/[id]', { id: editingId }), {
					method: 'PATCH',
					body: JSON.stringify(payload)
				});
			} else {
				await requestJson(resolve('/api/credit-scores'), {
					method: 'POST',
					body: JSON.stringify(payload)
				});
			}
			dialogOpen = false;
			await reloadEntries();
			showToast(editingId ? 'Credit score reading updated.' : 'Credit score reading added.');
		} catch (error) {
			formError = readableError(error, 'The credit score reading could not be saved.');
		} finally {
			busy = false;
		}
	}

	async function reloadEntries(): Promise<void> {
		const response = await requestJson<{ entries: CreditScoreEntry[] }>(
			resolve('/api/credit-scores')
		);
		entries = response.entries;
	}

	async function deleteEntry(entry: CreditScoreEntry): Promise<void> {
		if (!window.confirm(`Delete the ${entry.score} ${creditBureauLabel(entry.bureau)} reading?`)) {
			return;
		}
		deletingId = entry.id;
		try {
			await requestJson(resolve('/api/credit-scores/[id]', { id: entry.id }), {
				method: 'DELETE'
			});
			await reloadEntries();
			showToast('Credit score reading deleted.');
		} catch (error) {
			pageError = readableError(error, 'The credit score reading could not be deleted.');
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
	<title>Credit score — ChipDue</title>
	<meta
		name="description"
		content="Privately track credit scores by bureau, scoring model, source, and date."
	/>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<a class="skip-link" href="#credit-score-main">Skip to credit score</a>

<div class="finance-shell">
	<WorkspaceHeader current="credit-score" {mode} {loggingOut} onlogout={logout} />

	<main id="credit-score-main" class="finance-main">
		<section class="finance-toolbar" aria-labelledby="credit-score-title">
			<div>
				<p class="finance-kicker">Credit health</p>
				<h1 id="credit-score-title">Credit score</h1>
				<p>
					Record the score you see, where it came from, and its scoring model. ChipDue keeps each
					reading private and compares like-for-like bureau updates.
				</p>
			</div>
			<button class="finance-button" type="button" onclick={openAdd}>+ Add reading</button>
		</section>

		<section class="finance-summary" aria-label="Credit score summary">
			<article>
				<span>Latest score</span>
				<strong>{loading ? '—' : (latestEntry?.score ?? '—')}</strong>
			</article>
			<article>
				<span>Change</span>
				<strong
					title={previousEntry
						? `Compared with ${previousEntry.score} from ${formatDate(previousEntry.recordedDate)}`
						: 'Add another reading from this bureau to see a change'}
					class:positive={scoreChange !== null && scoreChange > 0}
					class:negative={scoreChange !== null && scoreChange < 0}
				>
					{loading ? '—' : formatChange(scoreChange)}
				</strong>
			</article>
			<article>
				<span>Common score range</span>
				<strong>{loading || !latestEntry ? '—' : creditScoreRange(latestEntry.score)}</strong>
			</article>
			<article>
				<span>Latest update</span>
				<strong>{loading ? '—' : formatDate(latestEntry?.recordedDate ?? null)}</strong>
			</article>
		</section>

		{#if loading}
			<div class="finance-loading" aria-busy="true">Loading your private score history…</div>
		{:else if pageError}
			<div class="finance-error" role="alert">
				<h2>Credit scores are unavailable</h2>
				<p>{pageError}</p>
				<button class="finance-button secondary" type="button" onclick={initialize}
					>Try again</button
				>
			</div>
		{:else}
			<CreditScoreChart {entries} />

			<section aria-labelledby="score-history-title">
				<div class="finance-section-heading">
					<div>
						<h2 id="score-history-title">Reading history</h2>
						<p>
							{entries.length}
							{entries.length === 1 ? 'reading' : 'readings'} across {bureauCount}
							{bureauCount === 1 ? 'source bureau' : 'source bureaus'}.
						</p>
					</div>
				</div>

				{#if entries.length === 0}
					<div class="finance-empty score-empty">
						<h2>Start with the score you can see today</h2>
						<p>
							Issuer apps and credit-monitoring services often show a bureau and scoring model
							beside the number. Save those details for meaningful comparisons later.
						</p>
						<button class="finance-button" type="button" onclick={openAdd}>Add first reading</button
						>
					</div>
				{:else}
					<div class="score-reading-list">
						{#each entries as entry (entry.id)}
							<article class="score-reading">
								<div class="score-reading-value">
									<strong>{entry.score}</strong>
									<span>{creditScoreRange(entry.score)}</span>
								</div>
								<div class="score-reading-copy">
									<h3>{creditBureauLabel(entry.bureau)}</h3>
									<p>
										{entry.model ?? 'Scoring model not entered'} · {entry.source ??
											'Source not entered'}
									</p>
									{#if entry.notes}<small>{entry.notes}</small>{/if}
								</div>
								<time datetime={entry.recordedDate}>{formatDate(entry.recordedDate)}</time>
								<div class="score-reading-actions">
									<button type="button" onclick={() => openEdit(entry)}>Edit</button>
									<button class="delete" type="button" onclick={() => deleteEntry(entry)}>
										{deletingId === entry.id ? 'Deleting…' : 'Delete'}
									</button>
								</div>
							</article>
						{/each}
					</div>
				{/if}
			</section>

			<section class="preapproval-panel" aria-labelledby="preapproval-title">
				<div>
					<p class="finance-kicker">Personalized offers</p>
					<h2 id="preapproval-title">Check card bonuses without applying</h2>
					<p>
						These issuer-owned tools say the eligibility check uses a soft inquiry. A full
						application or accepting a card can still trigger a hard inquiry, and pre-approval does
						not guarantee final approval.
					</p>
				</div>
				<div class="preapproval-grid">
					{#each preapprovalTools as tool (tool.name)}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- Issuer-owned external pre-approval tool. -->
						<a href={tool.href} target="_blank" rel="noreferrer">
							<strong>{tool.name}</strong>
							<span>{tool.detail}</span>
							<small>Open official checker →</small>
						</a>
					{/each}
				</div>
			</section>
		{/if}
	</main>
</div>

{#if dialogOpen}
	<div class="finance-dialog-layer" role="presentation">
		<div
			class="finance-dialog score-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="score-dialog-title"
		>
			<header class="finance-dialog-header">
				<div>
					<h2 id="score-dialog-title">{editingId ? 'Edit score reading' : 'Add score reading'}</h2>
					<p>Copy the bureau, model, and date shown beside the score whenever possible.</p>
				</div>
				<button type="button" aria-label="Close" onclick={closeDialog}>×</button>
			</header>
			<form class="finance-form" onsubmit={saveEntry}>
				{#if formError}<p class="finance-form-error" role="alert">{formError}</p>{/if}
				<div class="finance-form-grid">
					<div class="finance-field">
						<label for="score-value">Credit score</label>
						<input
							id="score-value"
							type="number"
							min="300"
							max="850"
							step="1"
							bind:value={form.score}
							placeholder="750"
							required
						/>
					</div>
					<div class="finance-field">
						<label for="score-date">Score date</label>
						<input id="score-date" type="date" bind:value={form.recordedDate} required />
					</div>
					<div class="finance-field">
						<label for="score-bureau">Credit bureau</label>
						<select id="score-bureau" bind:value={form.bureau}>
							<option value="experian">Experian</option>
							<option value="equifax">Equifax</option>
							<option value="transunion">TransUnion</option>
							<option value="other">Other / not shown</option>
						</select>
					</div>
					<div class="finance-field">
						<label for="score-model">Scoring model</label>
						<input
							id="score-model"
							bind:value={form.model}
							maxlength="80"
							placeholder="FICO Score 8"
						/>
					</div>
					<div class="finance-field wide">
						<label for="score-source">Where you saw it</label>
						<input
							id="score-source"
							bind:value={form.source}
							maxlength="80"
							placeholder="Issuer app or credit-monitoring service"
						/>
					</div>
					<div class="finance-field wide">
						<label for="score-notes">Notes</label>
						<textarea
							id="score-notes"
							bind:value={form.notes}
							maxlength="2000"
							placeholder="Optional context for this reading"></textarea>
					</div>
				</div>
				<div class="finance-form-actions">
					<button
						class="finance-button secondary"
						type="button"
						onclick={closeDialog}
						disabled={busy}>Cancel</button
					>
					<button class="finance-button" type="submit" disabled={busy}
						>{busy ? 'Saving…' : editingId ? 'Save changes' : 'Add reading'}</button
					>
				</div>
			</form>
		</div>
	</div>
{/if}

{#if toast}<div class="finance-toast" role="status">{toast}</div>{/if}

<style>
	.skip-link {
		position: fixed;
		z-index: 120;
		top: -60px;
		left: 1rem;
		padding: 0.7rem 1rem;
		border-radius: 0 0 8px 8px;
		color: white;
		background: var(--ink-soft);
		transition: top 120ms ease;
	}

	.skip-link:focus {
		top: 0;
	}

	.finance-summary strong.positive {
		color: var(--positive);
	}

	.finance-summary strong.negative {
		color: var(--red);
	}

	.score-reading-list {
		display: grid;
		gap: 0.65rem;
		margin-bottom: 2.8rem;
	}

	.score-reading {
		display: grid;
		grid-template-columns: 92px minmax(0, 1fr) auto auto;
		gap: 1rem;
		align-items: center;
		padding: 0.9rem 1rem;
		border: 1px solid var(--line);
		border-radius: 11px;
		background: var(--paper);
		box-shadow: var(--shadow-sm);
	}

	.score-reading-value {
		display: grid;
	}

	.score-reading-value strong {
		font-size: 1.45rem;
		font-weight: 780;
		letter-spacing: -0.05em;
	}

	.score-reading-value span {
		color: var(--positive);
		font-size: 0.58rem;
		font-weight: 720;
	}

	.score-reading-copy {
		min-width: 0;
	}

	.score-reading-copy h3 {
		margin: 0;
		font-size: 0.85rem;
	}

	.score-reading-copy p,
	.score-reading-copy small {
		display: block;
		margin: 0.2rem 0 0;
		overflow: hidden;
		color: var(--muted);
		font-size: 0.62rem;
		line-height: 1.4;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.score-reading time {
		color: var(--faint);
		font-size: 0.64rem;
		font-weight: 650;
	}

	.score-reading-actions {
		display: flex;
		gap: 0.45rem;
	}

	.score-reading-actions button {
		padding: 0.35rem;
		border: 0;
		color: var(--accent-dark);
		font-size: 0.62rem;
		font-weight: 720;
		background: transparent;
		cursor: pointer;
	}

	.score-reading-actions button.delete {
		color: var(--red);
	}

	.preapproval-panel {
		display: grid;
		grid-template-columns: minmax(220px, 0.72fr) minmax(0, 1.28fr);
		gap: 1.5rem;
		margin-top: 3rem;
		padding: 1.3rem;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: rgba(255, 253, 249, 0.72);
		box-shadow: var(--shadow-sm);
	}

	.preapproval-panel h2 {
		margin: 0;
		font-size: 1.1rem;
		letter-spacing: -0.025em;
	}

	.preapproval-panel > div > p:last-child {
		margin: 0.55rem 0 0;
		color: var(--muted);
		font-size: 0.68rem;
		line-height: 1.55;
	}

	.preapproval-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.65rem;
	}

	.preapproval-grid a {
		display: grid;
		gap: 0.25rem;
		padding: 0.8rem;
		border: 1px solid var(--line);
		border-radius: 9px;
		text-decoration: none;
		background: white;
		transition:
			border-color 120ms ease,
			transform 120ms ease;
	}

	.preapproval-grid a:hover {
		border-color: var(--accent);
		transform: translateY(-1px);
	}

	.preapproval-grid strong {
		font-size: 0.75rem;
	}

	.preapproval-grid span {
		color: var(--muted);
		font-size: 0.6rem;
		line-height: 1.45;
	}

	.preapproval-grid small {
		margin-top: 0.25rem;
		color: var(--accent-dark);
		font-size: 0.58rem;
		font-weight: 720;
	}

	.score-dialog {
		width: min(100%, 620px);
	}

	@media (max-width: 760px) {
		.score-reading {
			grid-template-columns: 72px minmax(0, 1fr) auto;
		}

		.score-reading time {
			grid-column: 2;
		}

		.score-reading-actions {
			grid-row: 1 / 3;
			grid-column: 3;
			align-items: flex-end;
			flex-direction: column;
		}

		.preapproval-panel {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 520px) {
		.preapproval-grid {
			grid-template-columns: 1fr;
		}

		.score-reading-copy p,
		.score-reading-copy small {
			white-space: normal;
		}
	}
</style>
