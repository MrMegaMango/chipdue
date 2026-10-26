<script module lang="ts">
	import type { EmergencySession, EmergencySnapshot } from '$lib/emergency';
	import { getBonusChurnToday } from '$lib/bonus-churn';

	export function savedSessionChanged(previous: EmergencySession | null, next: EmergencySession) {
		return next.authenticated && previous?.sessionRef !== next.sessionRef;
	}

	export function savedDeadlines(snapshot: EmergencySnapshot, today = getBonusChurnToday()) {
		const deadlines: Array<{ id: string; name: string; label: string; date: string }> = [];
		for (const card of snapshot.cards) {
			if (card.dueDate) {
				deadlines.push({
					id: `card:${card.id}`,
					name: card.nickname,
					label: 'Payment date',
					date: card.dueDate
				});
			}
		}
		for (const bonus of snapshot.bonuses) {
			if (['closed', 'abandoned'].includes(bonus.status)) continue;
			const dates = [
				{
					label: 'Requirement deadline',
					date: ['planned', 'active'].includes(bonus.status) ? bonus.requirementDeadline : null
				},
				{
					label: 'Expected payout',
					date: ['active', 'qualified', 'pending'].includes(bonus.status)
						? bonus.expectedPayoutDate
						: null
				},
				{ label: 'Saved close date', date: bonus.status === 'paid' ? bonus.safeToCloseDate : null },
				{ label: 'Downgrade deadline', date: bonus.feeFreeDowngradeDate }
			];
			for (const { label, date } of dates) {
				if (date)
					deadlines.push({ id: `bonus:${bonus.id}:${label}`, name: bonus.name, label, date });
			}
		}
		return deadlines.sort((left, right) => {
			const leftPast = left.date < today;
			const rightPast = right.date < today;
			if (leftPast !== rightPast) return leftPast ? 1 : -1;
			return leftPast ? right.date.localeCompare(left.date) : left.date.localeCompare(right.date);
		});
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { asset, resolve } from '$app/paths';
	import WorkspaceHeader from '$lib/components/WorkspaceHeader.svelte';
	import BalanceHistoryChart from '$lib/components/BalanceHistoryChart.svelte';
	import '$lib/finance-pages.css';

	let session = $state<EmergencySession | null>(null);
	let snapshot = $state<EmergencySnapshot | null>(null);
	let snapshotLoaded = $state(false);
	let loading = $state(true);
	let loggingOut = $state(false);
	let setupRequired = $state(false);
	let error = $state('');
	let generation = 0;
	let checking = false;
	let lastSessionCheck = 0;
	const deadlines = $derived(snapshot ? savedDeadlines(snapshot) : []);
	const pacificTimestamp = new Intl.DateTimeFormat('en-US', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'America/Los_Angeles'
	});
	const calendarDate = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC'
	});

	function money(cents: number | null, currency: string): string {
		if (cents === null) return 'Not reported';
		return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
	}

	function date(value: string | null): string {
		if (!value) return 'Not set';
		const parsed = new Date(`${value.slice(0, 10)}T12:00:00Z`);
		return Number.isFinite(parsed.getTime()) ? calendarDate.format(parsed) : 'Not set';
	}

	function timestamp(value: string | null): string {
		if (!value || !Number.isFinite(Date.parse(value))) return 'Not recorded';
		return `${pacificTimestamp.format(new Date(value))} Pacific`;
	}

	function clearView(): void {
		generation += 1;
		snapshot = null;
		snapshotLoaded = false;
		if (session) session = { ...session, authenticated: false, sessionRef: null };
	}

	async function readSavedSnapshot(): Promise<void> {
		const started = generation;
		const sessionRef = session?.sessionRef;
		loading = true;
		try {
			const response = await fetch(resolve('/api/emergency/snapshot'), {
				credentials: 'same-origin',
				cache: 'no-store'
			});
			if (started !== generation || session?.sessionRef !== sessionRef) return;
			if (response.status === 401) {
				clearView();
				loading = false;
				error = 'Your saved-finances session expired. Sign in again.';
				return;
			}
			if (!response.ok) throw new Error('snapshot');
			const result = (await response.json()) as { snapshot: EmergencySnapshot | null };
			if (started !== generation || session?.sessionRef !== sessionRef) return;
			snapshot = result.snapshot;
			snapshotLoaded = true;
			error = '';
		} catch {
			if (started === generation) error = 'Saved finances could not be opened. Try again.';
		} finally {
			if (started === generation) loading = false;
		}
	}

	async function checkSession(readSnapshot = false): Promise<void> {
		if (checking || loggingOut) return;
		checking = true;
		lastSessionCheck = Date.now();
		const started = generation;
		let shouldReadSnapshot = false;
		if (readSnapshot) loading = true;
		try {
			const response = await fetch(resolve('/api/emergency/session'), {
				credentials: 'same-origin',
				cache: 'no-store'
			});
			if (started !== generation) return;
			if (response.status === 401) {
				clearView();
				loading = false;
				error = 'Your saved-finances session expired. Sign in again.';
				return;
			}
			if (!response.ok) throw new Error('session');
			const next = (await response.json()) as EmergencySession;
			if (started !== generation) return;
			const previouslyAuthenticated = session?.authenticated;
			const changed = savedSessionChanged(session, next);
			if (changed || !next.authenticated) {
				generation += 1;
				snapshot = null;
				snapshotLoaded = false;
			}
			session = next;
			if (!next.authenticated) {
				loading = false;
				if (previouslyAuthenticated) error = 'Your saved-finances session expired. Sign in again.';
				return;
			}
			setupRequired = false;
			shouldReadSnapshot = readSnapshot || changed;
			error = '';
		} catch {
			if (started === generation) {
				error = 'Saved finances could not be opened. Try again.';
				if (readSnapshot) loading = false;
			}
		} finally {
			checking = false;
		}
		if (shouldReadSnapshot) await readSavedSnapshot();
	}

	async function logout(): Promise<void> {
		if (loggingOut) return;
		loggingOut = true;
		clearView();
		loading = false;
		error = '';
		try {
			const response = await fetch(resolve('/api/emergency/logout'), {
				method: 'POST',
				credentials: 'same-origin',
				cache: 'no-store'
			});
			if (!response.ok) throw new Error('logout');
		} catch {
			error = 'Sign-out could not be confirmed. Close this page and try again.';
		} finally {
			loggingOut = false;
		}
	}

	onMount(() => {
		const googleResult = new URL(window.location.href).searchParams.get('google');
		setupRequired = googleResult === 'setup-required';
		if (googleResult === 'error') {
			error = 'Google sign-in could not be completed. Try again.';
		}
		void checkSession(true);
		const recheck = () => {
			if (
				document.visibilityState === 'visible' &&
				session?.authenticated &&
				Date.now() - lastSessionCheck >= 30_000
			)
				void checkSession();
		};
		window.addEventListener('focus', recheck);
		document.addEventListener('visibilitychange', recheck);
		return () => {
			generation += 1;
			snapshot = null;
			window.removeEventListener('focus', recheck);
			document.removeEventListener('visibilitychange', recheck);
		};
	});
</script>

<svelte:head><title>Saved finances — ChipDue</title></svelte:head>

<div class="finance-shell">
	<WorkspaceHeader
		current="emergency"
		mode={session?.authenticated ? 'cloud' : null}
		{loggingOut}
		onlogout={logout}
	/>
	<main class="finance-main">
		<div class="saved-banner">
			<h1>Saved finances · Read only</h1>
			{#if snapshot}
				<p>
					Copy saved {timestamp(snapshot.capturedAt)}. Balances and dates may have changed since
					then.
				</p>
			{:else}
				<p>Open your last saved copy when the live dashboard is unavailable.</p>
			{/if}
		</div>

		{#if error}<p class="error" role="alert">{error}</p>{/if}
		{#if loading}
			<p role="status">Opening saved finances…</p>
		{:else if !session}
			<button class="finance-button secondary" onclick={() => checkSession(true)}>Try again</button>
		{:else if !session.configured}
			<section class="empty">
				<h2>Saved finances are not available yet</h2>
				<p>Return to the dashboard after access is restored to save your first copy.</p>
			</section>
		{:else if !session.authenticated}
			<section class="empty">
				{#if setupRequired}
					<h2>Saved-finances access is not set up</h2>
					<p>
						This Google account needs a successful sign-in to the live dashboard first. Once
						database access returns, sign in there and open your finances to save your emergency
						copy.
					</p>
					<a class="finance-button secondary" href={resolve('/')} data-sveltekit-reload
						>Open live dashboard</a
					>
					<p>
						<a href={resolve('/api/auth/google/start?intent=emergency')} data-sveltekit-reload
							>Choose a different Google account</a
						>
					</p>
				{:else}
					<h2>Sign in to view your saved copy</h2>
					<p>Use the Google account you use for ChipDue.</p>
					<p>Requires a successful normal sign-in and saved copy before an outage.</p>
					<a
						class="google-login"
						href={resolve('/api/auth/google/start?intent=emergency')}
						data-sveltekit-reload
					>
						<img
							src={asset('/google-sign-in.svg')}
							alt="Sign in with Google"
							width="180"
							height="40"
						/>
					</a>
				{/if}
			</section>
		{:else if !snapshotLoaded}
			<button class="finance-button secondary" onclick={() => checkSession(true)}>Try again</button>
		{:else if !snapshot}
			<section class="empty">
				<h2>No saved copy yet</h2>
				<p>
					A copy will become available after your finances load or sync successfully when database
					access returns.
				</p>
			</section>
		{:else}
			<section aria-labelledby="saved-dates">
				<h2 id="saved-dates">Recorded payment dates &amp; deadlines</h2>
				<p class="section-note">
					Check the issuer before acting. A saved date does not confirm that a payment or
					requirement is still outstanding.
				</p>
				{#if deadlines.length}
					<div class="deadline-grid">
						{#each deadlines as deadline (deadline.id)}
							<article class="deadline">
								<time datetime={deadline.date}>{date(deadline.date)}</time><strong
									>{deadline.name}</strong
								><span>{deadline.label}</span>
							</article>
						{/each}
					</div>
				{:else}<p class="empty-line">No payment dates or deadlines were saved.</p>{/if}
			</section>

			<section aria-labelledby="saved-cards">
				<h2 id="saved-cards">Cards <span>{snapshot.cards.length}</span></h2>
				<div class="record-grid">
					{#each snapshot.cards as card (card.id)}
						<article class="record">
							<h3>{card.nickname}</h3>
							<p class="identity">{card.issuer ?? 'Card'}{card.last4 ? ` · ${card.last4}` : ''}</p>
							<strong class="balance">{money(card.currentBalanceCents, card.currency)}</strong>
							<dl>
								<div>
									<dt>Statement balance</dt>
									<dd>{money(card.statementBalanceCents, card.currency)}</dd>
								</div>
								<div>
									<dt>Minimum payment</dt>
									<dd>{money(card.minimumPaymentCents, card.currency)}</dd>
								</div>
								<div>
									<dt>Payment date</dt>
									<dd>{date(card.dueDate)}</dd>
								</div>
								<div>
									<dt>Autopay at last save</dt>
									<dd>{card.autopayEnabled ? 'Enabled' : 'Not enabled'}</dd>
								</div>
							</dl>
							<p class="synced">Provider last synced: {timestamp(card.lastSyncedAt)}</p>
						</article>
					{:else}<p class="empty-line">No cards were saved.</p>{/each}
				</div>
			</section>

			<section aria-labelledby="saved-accounts">
				<h2 id="saved-accounts">Accounts <span>{snapshot.accounts.length}</span></h2>
				<div class="record-grid">
					{#each snapshot.accounts as account (account.id)}
						<article class="record">
							<h3>{account.nickname}</h3>
							<p class="identity">
								{account.institution ?? account.accountType}{account.last4
									? ` · ${account.last4}`
									: ''} · {account.status}{account.hidden ? ' · Hidden in dashboard' : ''}
							</p>
							<strong class="balance">{money(account.currentBalanceCents, account.currency)}</strong
							>
							<p class="synced">Provider last synced: {timestamp(account.lastSyncedAt)}</p>
							{#if account.notes}<p class="notes">{account.notes}</p>{/if}
							{#if account.balanceHistory.length}
								<details>
									<summary>Balance history</summary><BalanceHistoryChart
										accountId={account.id}
										accountName={account.nickname}
										currency={account.currency}
										netContributionsCents={account.netContributionsCents}
										points={account.balanceHistory}
									/>
								</details>
							{/if}
							{#if account.holdings.length}
								<details>
									<summary>Holdings ({account.holdings.length})</summary>
									<ul class="holdings">
										{#each account.holdings as holding, index (index)}<li>
												<span
													>{holding.tickerSymbol ?? holding.name}<small
														>{holding.quantity} units</small
													></span
												><strong>{money(holding.valueCents, holding.currency)}</strong>
											</li>{/each}
									</ul>
								</details>
							{/if}
						</article>
					{:else}<p class="empty-line">No accounts were saved.</p>{/each}
				</div>
			</section>

			<section aria-labelledby="saved-bonuses">
				<h2 id="saved-bonuses">Bonuses <span>{snapshot.bonuses.length}</span></h2>
				<div class="record-grid">
					{#each snapshot.bonuses as bonus (bonus.id)}
						<article class="record">
							<h3>{bonus.name}</h3>
							<p class="identity">{bonus.institution ?? 'Bonus'} · {bonus.status}</p>
							<strong class="balance">{money(bonus.rewardCents, bonus.currency)}</strong>
							<dl>
								<div>
									<dt>Requirement deadline</dt>
									<dd>{date(bonus.requirementDeadline)}</dd>
								</div>
								<div>
									<dt>Expected payout</dt>
									<dd>{date(bonus.expectedPayoutDate)}</dd>
								</div>
								{#if bonus.paidDate}<div>
										<dt>Paid</dt>
										<dd>{date(bonus.paidDate)}</dd>
									</div>{/if}{#if bonus.safeToCloseDate}<div>
										<dt>Saved close date</dt>
										<dd>{date(bonus.safeToCloseDate)}</dd>
									</div>{/if}{#if bonus.feeFreeDowngradeDate}<div>
										<dt>Downgrade deadline</dt>
										<dd>{date(bonus.feeFreeDowngradeDate)}</dd>
									</div>{/if}
							</dl>
							{#if bonus.requirements.length}<ul class="requirements">
									{#each bonus.requirements as requirement (requirement.id)}<li>
											{requirement.completed ? 'Completed: ' : ''}{requirement.label}
										</li>{/each}
								</ul>{/if}
							{#if bonus.notes}<p class="notes">{bonus.notes}</p>{/if}
						</article>
					{:else}<p class="empty-line">No bonuses were saved.</p>{/each}
				</div>
			</section>

			<section aria-labelledby="saved-activity">
				<h2 id="saved-activity">Recent activity</h2>
				<p class="section-note">
					Up to {snapshot.transactionLimit} saved transactions per account or card. This is not a complete
					statement.
				</p>
				{#each snapshot.activity as activity (`${activity.kind}:${activity.id}`)}
					<details class="record activity">
						<summary
							>{activity.name} <span>{activity.transactions.length} transactions</span></summary
						>
						<p class="synced">Provider last synced: {timestamp(activity.lastSyncedAt)}</p>
						<div class="table-scroll">
							<table>
								<thead
									><tr><th>Date</th><th>Description</th><th class="amount">Amount</th></tr></thead
								><tbody
									>{#each activity.transactions as transaction (transaction.id)}<tr
											><td>{date(transaction.date)}</td><td
												>{transaction.merchantName ??
													transaction.name}{#if transaction.pending}<small>Pending when saved</small
													>{/if}</td
											><td class="amount">{money(transaction.amountCents, transaction.currency)}</td
											></tr
										>{:else}<tr
											><td colspan="3">No transactions were saved for this account.</td></tr
										>{/each}</tbody
								>
							</table>
						</div>
					</details>
				{:else}<p class="empty-line">No transaction activity was saved.</p>{/each}
			</section>
		{/if}
	</main>
</div>

<style>
	.saved-banner {
		position: sticky;
		top: 0;
		z-index: 2;
		padding: 1rem 1.2rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--accent-soft);
		margin-bottom: 1.8rem;
	}
	.saved-banner h1 {
		margin: 0;
		font-size: 1.25rem;
		letter-spacing: -0.03em;
	}
	.saved-banner p {
		margin: 0.4rem 0 0;
		color: var(--muted);
		font-size: 0.8rem;
		line-height: 1.5;
	}
	section {
		margin: 0 0 2rem;
	}
	h2 {
		margin: 0 0 0.7rem;
		font-size: 1.1rem;
	}
	h2 span,
	summary span {
		color: var(--faint);
		font-size: 0.8rem;
		font-weight: 500;
		margin-left: 0.4rem;
	}
	h3 {
		margin: 0;
		font-size: 1rem;
	}
	.section-note,
	.empty-line,
	.identity,
	.synced {
		color: var(--muted);
		font-size: 0.78rem;
		line-height: 1.5;
	}
	.section-note {
		margin: -0.2rem 0 1rem;
	}
	.deadline-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(185px, 1fr));
		gap: 0.65rem;
	}
	.deadline {
		display: grid;
		gap: 0.3rem;
		padding: 0.85rem 1rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--paper);
		font-size: 0.8rem;
	}
	.deadline time {
		color: var(--accent-dark);
		font-weight: 750;
	}
	.deadline span {
		color: var(--muted);
		font-size: 0.72rem;
	}
	.record-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
	}
	.record {
		min-width: 0;
		overflow-wrap: anywhere;
		border: 1px solid var(--line);
		border-radius: 10px;
		padding: 1.1rem;
		background: var(--paper);
	}
	.identity {
		margin: 0.3rem 0 0.9rem;
	}
	.balance {
		display: block;
		font-size: 1.45rem;
		letter-spacing: -0.04em;
	}
	dl {
		display: grid;
		gap: 0.45rem;
		margin: 1rem 0;
		font-size: 0.78rem;
	}
	dl div {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		text-align: right;
	}
	.synced {
		font-size: 0.7rem;
		margin-bottom: 0;
	}
	.notes {
		font-size: 0.8rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	details {
		margin-top: 1rem;
	}
	summary {
		cursor: pointer;
		font-size: 0.82rem;
		font-weight: 700;
		padding: 0.4rem 0;
	}
	.holdings {
		list-style: none;
		padding: 0;
		font-size: 0.78rem;
	}
	.holdings li {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.55rem 0;
		border-bottom: 1px solid var(--line);
	}
	small {
		display: block;
		color: var(--muted);
		margin-top: 0.2rem;
	}
	.requirements {
		padding-left: 1.2rem;
		font-size: 0.8rem;
		line-height: 1.7;
	}
	.activity {
		margin-top: 0.7rem;
	}
	.table-scroll {
		overflow-x: auto;
		margin-top: 0.7rem;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.78rem;
		text-align: left;
	}
	th,
	td {
		padding: 0.65rem 0.4rem;
		border-bottom: 1px solid var(--line);
		vertical-align: top;
	}
	th {
		color: var(--muted);
		font-weight: 600;
	}
	.amount {
		text-align: right;
		white-space: nowrap;
	}
	.empty {
		max-width: 560px;
		padding: 1.5rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--paper);
	}
	.empty p {
		color: var(--muted);
		line-height: 1.6;
		font-size: 0.85rem;
	}
	.google-login {
		display: inline-block;
		margin-top: 0.5rem;
	}
	.google-login img {
		display: block;
	}
	.error {
		color: var(--red);
		background: var(--red-soft);
		padding: 0.85rem 1rem;
		border-radius: 8px;
		font-size: 0.85rem;
	}
	@media (max-width: 680px) {
		.record-grid {
			grid-template-columns: 1fr;
		}
		.saved-banner {
			padding: 0.85rem;
		}
		.saved-banner h1 {
			font-size: 1.1rem;
		}
		.deadline-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 380px) {
		.deadline-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
