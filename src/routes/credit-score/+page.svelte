<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import CreditScoreChart from '$lib/components/CreditScoreChart.svelte';
	import WorkspaceHeader from '$lib/components/WorkspaceHeader.svelte';
	import type {
		CreditBureau,
		CreditScoreConnectionStatus,
		CreditScoreEntry
	} from '$lib/credit-score-types';
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
	type AutomaticSetupForm = {
		firstName: string;
		lastName: string;
		phone: string;
	};
	type OpalSession = {
		token: string;
		sessionId: string;
		opalUrl: string;
		opalOrigin: string;
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
	let connection = $state<CreditScoreConnectionStatus | null>(null);
	let loading = $state(true);
	let pageError = $state('');
	let dialogOpen = $state(false);
	let editingId = $state<string | null>(null);
	let form = $state<ScoreForm>(blankForm());
	let formError = $state('');
	let busy = $state(false);
	let deletingId = $state<string | null>(null);
	let automaticSetupOpen = $state(false);
	let automaticSetupForm = $state<AutomaticSetupForm>({ firstName: '', lastName: '', phone: '' });
	let automaticSetupError = $state('');
	let automaticSetupBusy = $state(false);
	let automaticSyncing = $state(false);
	let opalSession = $state<OpalSession | null>(null);
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

	function formatTimestamp(value: string | null): string {
		if (!value) return 'Not synced yet';
		return new Intl.DateTimeFormat('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		}).format(new Date(value));
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

	async function openAutomaticSetup(): Promise<void> {
		automaticSetupError = '';
		if (connection?.state === 'onboarding') {
			automaticSetupBusy = true;
			try {
				const response = await requestJson<{ session: OpalSession }>(
					resolve('/api/credit-scores/connection'),
					{ method: 'POST', body: JSON.stringify({ action: 'resume' }) }
				);
				opalSession = response.session;
				automaticSetupOpen = true;
			} catch (error) {
				automaticSetupError = readableError(error, 'Automatic setup could not be resumed.');
				automaticSetupOpen = true;
			} finally {
				automaticSetupBusy = false;
			}
			return;
		}
		opalSession = null;
		automaticSetupOpen = true;
	}

	function closeAutomaticSetup(): void {
		if (!automaticSetupBusy) automaticSetupOpen = false;
	}

	async function startAutomaticSetup(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		automaticSetupBusy = true;
		automaticSetupError = '';
		try {
			const response = await requestJson<{ session: OpalSession }>(
				resolve('/api/credit-scores/connection'),
				{
					method: 'POST',
					body: JSON.stringify({ action: 'start', ...automaticSetupForm })
				}
			);
			opalSession = response.session;
			await reloadEntries();
		} catch (error) {
			automaticSetupError = readableError(error, 'Automatic setup could not be started.');
		} finally {
			automaticSetupBusy = false;
		}
	}

	function handleOpalMessage(event: MessageEvent): void {
		if (!opalSession || event.origin !== opalSession.opalOrigin || automaticSetupBusy) return;
		const payload = event.data as { type?: unknown } | null;
		if (
			payload?.type === 'identity_verification.identity.completed' ||
			payload?.type === 'opal.session.completed'
		) {
			void activateAutomaticSetup();
		}
	}

	async function activateAutomaticSetup(): Promise<void> {
		if (automaticSetupBusy) return;
		automaticSetupBusy = true;
		automaticSetupError = '';
		try {
			await requestJson(resolve('/api/credit-scores/connection/activate'), { method: 'POST' });
			automaticSetupOpen = false;
			opalSession = null;
			await reloadEntries();
			showToast('Automatic credit score monitoring is connected.');
		} catch (error) {
			automaticSetupError = readableError(
				error,
				'Identity verification finished, but automatic monitoring could not be activated.'
			);
		} finally {
			automaticSetupBusy = false;
		}
	}

	async function refreshAutomaticScores(): Promise<void> {
		if (automaticSyncing) return;
		automaticSyncing = true;
		pageError = '';
		try {
			const result = await requestJson<{ imported: number }>(
				resolve('/api/credit-scores/connection/sync'),
				{ method: 'POST' }
			);
			await reloadEntries();
			showToast(
				result.imported ? 'A new credit score was imported.' : 'Credit score is up to date.'
			);
		} catch (error) {
			pageError = readableError(error, 'Automatic credit score sync could not finish.');
		} finally {
			automaticSyncing = false;
		}
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
		const response = await requestJson<{
			entries: CreditScoreEntry[];
			connection: CreditScoreConnectionStatus;
		}>(resolve('/api/credit-scores'));
		entries = response.entries;
		connection = response.connection;
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
		if (event.key !== 'Escape') return;
		if (dialogOpen) closeDialog();
		else if (automaticSetupOpen) closeAutomaticSetup();
	}
</script>

<svelte:head>
	<title>Credit score — ChipDue</title>
	<meta
		name="description"
		content="Automatically monitor an encrypted credit score history and the factors behind changes."
	/>
</svelte:head>

<svelte:window onkeydown={handleKeydown} onmessage={handleOpalMessage} />

<a class="skip-link" href="#credit-score-main">Skip to credit score</a>

<div class="finance-shell">
	<WorkspaceHeader current="credit-score" {mode} {loggingOut} onlogout={logout} />

	<main id="credit-score-main" class="finance-main">
		<section class="finance-toolbar" aria-labelledby="credit-score-title">
			<div>
				<p class="finance-kicker">Credit health</p>
				<h1 id="credit-score-title">Credit score</h1>
				<p>
					Connect once. ChipDue then imports verified score changes automatically, keeps the history
					encrypted, and explains what moved.
				</p>
			</div>
			{#if connection?.state === 'connected' || connection?.state === 'needs_attention'}
				<button
					class="finance-button"
					type="button"
					onclick={refreshAutomaticScores}
					disabled={automaticSyncing}
				>
					{automaticSyncing ? 'Syncing…' : 'Sync now'}
				</button>
			{:else if connection?.state !== 'not_configured'}
				<button
					class="finance-button"
					type="button"
					onclick={openAutomaticSetup}
					disabled={automaticSetupBusy}
				>
					{connection?.state === 'onboarding' ? 'Finish connection' : 'Connect automatic score'}
				</button>
			{/if}
		</section>

		{#if !loading && connection}
			<section
				class:attention={connection.state === 'needs_attention'}
				class:connected={connection.state === 'connected'}
				class="automatic-score-panel"
				aria-labelledby="automatic-score-title"
			>
				<div class="automatic-score-icon" aria-hidden="true">
					{connection.state === 'connected'
						? '✓'
						: connection.state === 'needs_attention'
							? '!'
							: '↻'}
				</div>
				<div>
					<div class="automatic-score-heading">
						<h2 id="automatic-score-title">Automatic score sync</h2>
						<span
							>{connection.state === 'connected'
								? 'Monitoring'
								: connection.state.replaceAll('_', ' ')}</span
						>
					</div>
					<p>{connection.message}</p>
					{#if connection.state === 'connected'}
						<small>
							Equifax VantageScore 4.0 via Method · Last checked {formatTimestamp(
								connection.lastSyncedAt
							)}
						</small>
					{:else if connection.state === 'not_configured'}
						<small
							>No score entry is required. The secure provider must be enabled once for ChipDue.</small
						>
					{:else}
						<small>The identity check is a soft inquiry and does not lower your score.</small>
					{/if}
				</div>
				{#if connection.state === 'disconnected' || connection.state === 'onboarding'}
					<button
						class="finance-button"
						type="button"
						onclick={openAutomaticSetup}
						disabled={automaticSetupBusy}
					>
						{connection.state === 'onboarding' ? 'Continue' : 'Connect'}
					</button>
				{:else if connection.state === 'needs_attention'}
					<button
						class="finance-button"
						type="button"
						onclick={refreshAutomaticScores}
						disabled={automaticSyncing}>Retry</button
					>
				{/if}
			</section>
		{/if}

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
				<span>Score range</span>
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

			{#if latestEntry?.factors.length}
				<section class="score-factors" aria-labelledby="score-factors-title">
					<div>
						<p class="finance-kicker">Latest report</p>
						<h2 id="score-factors-title">What is affecting your score</h2>
					</div>
					<ul>
						{#each latestEntry.factors as factor (factor.code ?? factor.description)}
							<li>{factor.description}</li>
						{/each}
					</ul>
				</section>
			{/if}

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
						<h2>
							{connection?.state === 'connected'
								? 'Waiting for your first automatic score'
								: 'Connect once—never type a score again'}
						</h2>
						<p>
							{connection?.state === 'connected'
								? 'Your initial score request is processing. New score changes will appear here automatically.'
								: 'Method verifies your identity securely, retrieves an Equifax VantageScore 4.0, and monitors it for changes.'}
						</p>
						{#if connection?.state === 'disconnected' || connection?.state === 'onboarding'}
							<button class="finance-button" type="button" onclick={openAutomaticSetup}>
								{connection.state === 'onboarding'
									? 'Finish connection'
									: 'Connect automatic score'}
							</button>
						{/if}
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
									<h3>
										{creditBureauLabel(entry.bureau)}
										{#if entry.origin === 'automatic'}<span class="automatic-badge">Automatic</span
											>{/if}
									</h3>
									<p>
										{entry.model ?? 'Scoring model not entered'} · {entry.source ??
											'Source not entered'}
									</p>
									{#if entry.notes}<small>{entry.notes}</small>{/if}
								</div>
								<time datetime={entry.recordedDate}>{formatDate(entry.recordedDate)}</time>
								<div class="score-reading-actions">
									{#if entry.origin === 'manual'}
										<button type="button" onclick={() => openEdit(entry)}>Edit</button>
										<button class="delete" type="button" onclick={() => deleteEntry(entry)}>
											{deletingId === entry.id ? 'Deleting…' : 'Delete'}
										</button>
									{:else}
										<span class="locked-reading" title="Managed by automatic sync">Encrypted</span>
									{/if}
								</div>
							</article>
						{/each}
					</div>
				{/if}
			</section>

			<details class="manual-fallback">
				<summary>Manual backup</summary>
				<div>
					<p>Only use this if a score provider is temporarily unavailable.</p>
					<button class="finance-button secondary" type="button" onclick={openAdd}>
						Add a manual reading
					</button>
				</div>
			</details>

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

{#if automaticSetupOpen}
	<div class="finance-dialog-layer" role="presentation">
		<div
			class="finance-dialog automatic-setup-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="automatic-setup-title"
		>
			<header class="finance-dialog-header">
				<div>
					<h2 id="automatic-setup-title">Connect automatic credit score</h2>
					<p>One secure identity check turns on ongoing score monitoring.</p>
				</div>
				<button type="button" aria-label="Close" onclick={closeAutomaticSetup}>×</button>
			</header>
			{#if automaticSetupError}
				<p class="finance-form-error automatic-setup-error" role="alert">{automaticSetupError}</p>
			{/if}
			{#if opalSession}
				<div class="opal-frame-wrap" aria-busy={automaticSetupBusy}>
					<iframe
						src={opalSession.opalUrl}
						title="Method secure identity verification"
						sandbox="allow-forms allow-popups allow-same-origin allow-scripts"
					></iframe>
					{#if automaticSetupBusy}
						<p class="opal-status" role="status">Turning on automatic monitoring…</p>
					{/if}
				</div>
			{:else}
				<form class="finance-form" onsubmit={startAutomaticSetup}>
					<p class="automatic-setup-copy">
						Your legal name and phone number are sent to Method to create the verification session.
						Any additional identity details are entered directly in Method’s secure flow; ChipDue
						does not store them.
					</p>
					<div class="finance-form-grid">
						<div class="finance-field">
							<label for="automatic-first-name">Legal first name</label>
							<input
								id="automatic-first-name"
								bind:value={automaticSetupForm.firstName}
								autocomplete="given-name"
								maxlength="80"
								required
							/>
						</div>
						<div class="finance-field">
							<label for="automatic-last-name">Legal last name</label>
							<input
								id="automatic-last-name"
								bind:value={automaticSetupForm.lastName}
								autocomplete="family-name"
								maxlength="80"
								required
							/>
						</div>
						<div class="finance-field wide">
							<label for="automatic-phone">Mobile phone</label>
							<input
								id="automatic-phone"
								bind:value={automaticSetupForm.phone}
								autocomplete="tel"
								inputmode="tel"
								placeholder="+14155550123"
								required
							/>
						</div>
					</div>
					<p class="automatic-setup-legal">
						Continuing opens Method’s consent and identity-verification flow. It uses a soft inquiry
						and does not lower your score.
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- External provider policy. -->
						<a href="https://methodfi.com/legal/privacy" target="_blank" rel="noreferrer"
							>Method privacy</a
						>
					</p>
					<div class="finance-form-actions">
						<button
							class="finance-button secondary"
							type="button"
							onclick={closeAutomaticSetup}
							disabled={automaticSetupBusy}>Cancel</button
						>
						<button class="finance-button" type="submit" disabled={automaticSetupBusy}>
							{automaticSetupBusy ? 'Connecting…' : 'Continue securely'}
						</button>
					</div>
				</form>
			{/if}
		</div>
	</div>
{/if}

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

	.automatic-score-panel {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 0.9rem;
		align-items: center;
		margin: 0 0 1rem;
		padding: 1rem;
		border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--line));
		border-radius: 12px;
		background: color-mix(in srgb, var(--accent) 8%, var(--paper));
		box-shadow: var(--shadow-sm);
	}

	.automatic-score-panel.connected {
		border-color: color-mix(in srgb, var(--positive) 42%, var(--line));
		background: color-mix(in srgb, var(--positive) 7%, var(--paper));
	}

	.automatic-score-panel.attention {
		border-color: color-mix(in srgb, var(--red) 40%, var(--line));
		background: color-mix(in srgb, var(--red) 5%, var(--paper));
	}

	.automatic-score-icon {
		display: grid;
		width: 2.1rem;
		height: 2.1rem;
		place-items: center;
		border-radius: 999px;
		color: white;
		font-size: 0.82rem;
		font-weight: 800;
		background: var(--accent-dark);
	}

	.connected .automatic-score-icon {
		background: var(--positive);
	}

	.attention .automatic-score-icon {
		background: var(--red);
	}

	.automatic-score-heading {
		display: flex;
		gap: 0.55rem;
		align-items: center;
		flex-wrap: wrap;
	}

	.automatic-score-heading h2 {
		margin: 0;
		font-size: 0.88rem;
	}

	.automatic-score-heading span,
	.automatic-badge {
		padding: 0.2rem 0.42rem;
		border-radius: 999px;
		color: var(--accent-dark);
		font-size: 0.52rem;
		font-weight: 760;
		line-height: 1;
		text-transform: capitalize;
		background: color-mix(in srgb, var(--accent) 14%, white);
	}

	.automatic-score-panel p {
		margin: 0.3rem 0 0;
		color: var(--ink-soft);
		font-size: 0.69rem;
		line-height: 1.45;
	}

	.automatic-score-panel small {
		display: block;
		margin-top: 0.22rem;
		color: var(--muted);
		font-size: 0.58rem;
		line-height: 1.45;
	}

	.score-factors {
		display: grid;
		grid-template-columns: minmax(190px, 0.7fr) minmax(0, 1.3fr);
		gap: 1rem;
		margin: 1rem 0 2.4rem;
		padding: 1.1rem;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: var(--paper);
		box-shadow: var(--shadow-sm);
	}

	.score-factors h2 {
		margin: 0;
		font-size: 1rem;
		letter-spacing: -0.02em;
	}

	.score-factors ul {
		display: grid;
		gap: 0.5rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.score-factors li {
		position: relative;
		padding-left: 0.85rem;
		color: var(--ink-soft);
		font-size: 0.67rem;
		line-height: 1.45;
	}

	.score-factors li::before {
		position: absolute;
		top: 0.55em;
		left: 0;
		width: 0.3rem;
		height: 0.3rem;
		border-radius: 999px;
		background: var(--accent);
		content: '';
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
		display: flex;
		gap: 0.45rem;
		align-items: center;
		flex-wrap: wrap;
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

	.locked-reading {
		color: var(--faint);
		font-size: 0.58rem;
		font-weight: 680;
	}

	.manual-fallback {
		margin: -1.2rem 0 3rem;
		padding: 0.75rem 0.9rem;
		border: 1px dashed var(--line);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.38);
	}

	.manual-fallback summary {
		color: var(--muted);
		font-size: 0.65rem;
		font-weight: 720;
		cursor: pointer;
	}

	.manual-fallback > div {
		display: flex;
		gap: 0.8rem;
		align-items: center;
		justify-content: space-between;
		padding-top: 0.8rem;
	}

	.manual-fallback p {
		margin: 0;
		color: var(--muted);
		font-size: 0.63rem;
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

	.automatic-setup-dialog {
		width: min(100%, 720px);
	}

	.automatic-setup-copy,
	.automatic-setup-legal {
		margin: 0 0 1rem;
		color: var(--muted);
		font-size: 0.66rem;
		line-height: 1.55;
	}

	.automatic-setup-legal {
		margin: 1rem 0 0;
	}

	.automatic-setup-legal a {
		color: var(--accent-dark);
		font-weight: 700;
	}

	.automatic-setup-error {
		margin: 1rem;
	}

	.opal-frame-wrap {
		position: relative;
		min-height: 620px;
		background: white;
	}

	.opal-frame-wrap iframe {
		display: block;
		width: 100%;
		height: min(70vh, 680px);
		min-height: 620px;
		border: 0;
	}

	.opal-status {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--ink-soft);
		font-size: 0.72rem;
		font-weight: 700;
		background: rgba(255, 253, 249, 0.94);
	}

	@media (max-width: 760px) {
		.automatic-score-panel {
			grid-template-columns: auto minmax(0, 1fr);
		}

		.automatic-score-panel > .finance-button {
			grid-column: 2;
			justify-self: start;
		}

		.score-factors {
			grid-template-columns: 1fr;
		}

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
		.automatic-score-panel {
			grid-template-columns: 1fr;
		}

		.automatic-score-panel > .finance-button {
			grid-column: 1;
		}

		.manual-fallback > div {
			align-items: flex-start;
			flex-direction: column;
		}

		.preapproval-grid {
			grid-template-columns: 1fr;
		}

		.score-reading-copy p,
		.score-reading-copy small {
			white-space: normal;
		}
	}
</style>
