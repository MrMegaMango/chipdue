<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		BONUS_CHURN_PRESETS,
		buildBonusChurnTracker,
		bonusChurnOpenedDate,
		getBonusChurnToday,
		formatBonusChurnDate,
		bonusChurnStatusLabel
	} from '$lib/bonus-churn';
	import { clearPrivateApiCache } from '$lib/private-api-cache';
	import { currentTime } from '$lib/sync-time';
	import type { AccountBonus, BonusChurn, BonusChurnCondition } from '$lib/types';

	let {
		bonuses,
		onupdated
	}: { bonuses: AccountBonus[]; onupdated: (bonus: AccountBonus) => void } = $props();
	let editing = $state<AccountBonus | null>(null);
	let dialog: HTMLDialogElement;
	let selection = $state('custom');
	let draft = $state<BonusChurn>(blankRule());
	let paidDate = $state('');
	let openedDate = $state('');
	let closedDate = $state('');
	let manualDate = $state('');
	let sourceUrl = $state('');
	let notes = $state('');
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	const today = $derived(getBonusChurnToday(new Date($currentTime)));
	const rank = { ready: 0, waiting: 1, needs_info: 2, unconfigured: 3, restricted: 4 };
	const rows = $derived(
		bonuses
			.map((bonus) => ({ bonus, tracker: buildBonusChurnTracker(bonus, today) }))
			.toSorted(
				(a, b) =>
					rank[a.tracker.status] - rank[b.tracker.status] ||
					(a.tracker.reviewDate ?? '').localeCompare(b.tracker.reviewDate ?? '') ||
					a.bonus.name.localeCompare(b.bonus.name)
			)
	);
	const readyCount = $derived(rows.filter(({ tracker }) => tracker.status === 'ready').length);
	const waitingCount = $derived(rows.filter(({ tracker }) => tracker.status === 'waiting').length);
	const selectedPreset = $derived(BONUS_CHURN_PRESETS.find((preset) => preset.id === selection));
	const needsPaid = $derived(
		draft.mode === 'rules' && draft.conditions.some((rule) => rule.anchor === 'paidDate')
	);
	const needsOpened = $derived(
		draft.mode === 'rules' && draft.conditions.some((rule) => rule.anchor === 'openedDate')
	);
	const needsClosed = $derived(
		draft.requiresClosed || draft.conditions.some((rule) => rule.anchor === 'closedDate')
	);
	const preview = $derived(
		editing && selection !== 'off'
			? buildBonusChurnTracker(
					{
						...editing,
						paidDate: paidDate || null,
						churn: {
							...draft,
							openedDate: openedDate || null,
							closedDate: closedDate || null,
							manualEligibleDate: manualDate || null
						}
					},
					today
				)
			: null
	);

	function blankRule(): BonusChurn {
		return {
			mode: 'rules',
			conditions: [{ anchor: 'paidDate', months: 24, days: 0 }],
			requiresClosed: false,
			closedDate: null,
			manualEligibleDate: null,
			presetId: null,
			sourceUrl: null,
			notes: null
		};
	}

	function open(bonus: AccountBonus): void {
		editing = bonus;
		draft = bonus.churn ? structuredClone($state.snapshot(bonus.churn)) : blankRule();
		selection =
			draft.presetId && BONUS_CHURN_PRESETS.some((preset) => preset.id === draft.presetId)
				? draft.presetId
				: draft.mode === 'rules'
					? 'custom'
					: draft.mode;
		paidDate = bonus.paidDate ?? '';
		openedDate = bonusChurnOpenedDate(bonus) ?? '';
		closedDate = draft.closedDate ?? '';
		manualDate = draft.manualEligibleDate ?? '';
		sourceUrl = draft.sourceUrl ?? '';
		notes = draft.notes ?? '';
		error = '';
		notice = '';
		dialog.showModal();
	}

	function changeRule(): void {
		const preset = BONUS_CHURN_PRESETS.find((candidate) => candidate.id === selection);
		if (preset) {
			draft = structuredClone(preset.churn);
			sourceUrl = preset.sourceUrl;
			notes = draft.notes ?? '';
		} else {
			draft = {
				...draft,
				presetId: null,
				mode:
					selection === 'manual' ? 'manual' : selection === 'restricted' ? 'restricted' : 'rules',
				conditions:
					selection === 'custom'
						? draft.conditions.length
							? draft.conditions
							: blankRule().conditions
						: []
			};
		}
	}

	function customize(): void {
		selection = 'custom';
		draft.presetId = null;
	}

	function addCondition(): void {
		const anchor = (['paidDate', 'openedDate', 'closedDate'] as const).find(
			(value) => !draft.conditions.some((rule) => rule.anchor === value)
		);
		if (!anchor) return;
		customize();
		draft.conditions = [...draft.conditions, { anchor, months: 12, days: 0 }];
	}

	function removeCondition(index: number): void {
		customize();
		draft.conditions = draft.conditions.filter((_, i) => i !== index);
	}

	function anchorLabel(anchor: BonusChurnCondition['anchor']): string {
		return {
			paidDate: 'Bonus received',
			openedDate: 'Account opened',
			closedDate: 'Account closed'
		}[anchor];
	}

	function close(): void {
		if (!busy) dialog.close();
	}

	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!editing || busy) return;
		if (selection !== 'off' && draft.mode === 'rules') {
			if (
				new Set(draft.conditions.map((condition) => condition.anchor)).size !==
				draft.conditions.length
			) {
				error = 'Use each starting date only once.';
				return;
			}
			if (draft.conditions.some((condition) => !(condition.months > 0 || condition.days > 0))) {
				error = 'Each waiting period needs at least one month or one day.';
				return;
			}
		}
		busy = true;
		error = '';
		const churn =
			selection === 'off'
				? null
				: {
						...draft,
						openedDate: openedDate || null,
						closedDate: closedDate || null,
						manualEligibleDate: manualDate || null,
						sourceUrl: sourceUrl.trim() || null,
						notes: notes.trim() || null
					};
		try {
			const response = await fetch(resolve('/api/bonuses/[id]', { id: editing.id }), {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					churn,
					...(selection !== 'off' && needsPaid ? { paidDate: paidDate || null } : {})
				})
			});
			if (!response.ok) {
				if (response.status === 401) {
					window.location.assign(resolve('/'));
					return;
				}
				const payload = await response.json().catch(() => null);
				throw new Error(payload?.error?.message ?? 'Repeat bonus tracking could not be saved.');
			}
			clearPrivateApiCache();
			const payload = (await response.json()) as { bonus: AccountBonus };
			onupdated(payload.bonus);
			dialog.close();
			notice = churn ? 'Repeat bonus tracking saved.' : 'Repeat bonus tracking removed.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Repeat bonus tracking could not be saved.';
		} finally {
			busy = false;
		}
	}
</script>

<section class="churn-panel" aria-labelledby="churn-title">
	<div class="churn-heading">
		<div>
			<p class="finance-kicker">Plan your next round</p>
			<h2 id="churn-title">When can I earn it again?</h2>
			<p>Track repeat-bonus waiting periods for your bank accounts and credit cards.</p>
		</div>
		<div class="churn-counts">
			<span><strong>{readyCount}</strong> ready to review</span><span
				><strong>{waitingCount}</strong> cooling down</span
			>
		</div>
	</div>
	{#if notice}<p class="churn-notice" role="status">{notice}</p>{/if}
	<div class="churn-rows">
		{#each rows as { bonus, tracker } (bonus.id)}
			<div class="churn-row" class:ready={tracker.status === 'ready'}>
				<div class="churn-name">
					<strong>{bonus.name}</strong><span>{bonus.institution ?? 'Manual bonus'}</span>
				</div>
				<div class="churn-state">
					<span class="churn-badge" data-status={tracker.status}
						>{bonusChurnStatusLabel(tracker.status)}</span
					>
					{#if tracker.reviewDate}<strong>{formatBonusChurnDate(tracker.reviewDate)}</strong>{/if}
					{#if tracker.status === 'waiting'}<small
							>{tracker.daysRemaining}
							{tracker.daysRemaining === 1 ? 'day' : 'days'} to recheck</small
						>
					{:else if tracker.status === 'needs_info'}<small>{tracker.missing.join(' · ')}</small>
					{:else if tracker.status === 'ready'}<small>Check the current offer before applying</small
						>
					{:else if tracker.status === 'restricted'}<small>No confirmed repeat date</small>
					{:else}<small>Add the offer’s repeat-bonus rule</small>{/if}
				</div>
				<button
					type="button"
					onclick={() => open(bonus)}
					aria-label={`Track repeat bonus for ${bonus.name}`}
					>{bonus.churn ? 'Edit tracking' : 'Set up tracking'}
					<span aria-hidden="true">↗</span></button
				>
			</div>
		{/each}
	</div>
	<p class="churn-footnote">
		Dates are reminders to review eligibility, not approval guarantees. Other accounts, prior
		bonuses, and the current offer’s terms can still affect eligibility. Countdowns use Pacific
		time.
	</p>
</section>

<dialog
	bind:this={dialog}
	class="finance-dialog churn-dialog"
	aria-labelledby="repeat-bonus-title"
	oncancel={(event) => {
		if (busy) event.preventDefault();
	}}
>
	<header class="finance-dialog-header">
		<div>
			<h2 id="repeat-bonus-title">Track repeat bonus</h2>
			<p>{editing?.name}</p>
		</div>
		<button type="button" aria-label="Close repeat bonus tracking" onclick={close} disabled={busy}
			>×</button
		>
	</header>
	<form class="finance-form" onsubmit={save}>
		{#if error}<p class="finance-form-error" role="alert">{error}</p>{/if}
		<div class="finance-form-grid">
			<div class="finance-field wide">
				<label for="churn-rule">Repeat-bonus rule</label>
				<select id="churn-rule" bind:value={selection} onchange={changeRule}>
					<option value="custom">Custom waiting period</option>
					<option value="manual">Specific date to recheck</option>
					<option value="restricted">No confirmed reset / offer review required</option>
					<optgroup label="Offer-specific starting points"
						>{#each BONUS_CHURN_PRESETS as preset (preset.id)}<option value={preset.id}
								>{preset.label}</option
							>{/each}</optgroup
					>
					{#if editing?.churn}<option value="off">Remove repeat tracking</option>{/if}
				</select>
				<small
					>Choose the exact product and rule from your offer. A bank connection does not establish
					bonus eligibility.</small
				>
			</div>
			{#if selection !== 'off'}
				{#if selectedPreset}<p class="churn-preset wide">
						{selectedPreset.description}
						<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- Issuer terms are an external URL. -->
						<a href={selectedPreset.sourceUrl} target="_blank" rel="noreferrer">Official terms ↗</a
						>{#if selectedPreset.verifiedAt}<small
								>Checked {formatBonusChurnDate(selectedPreset.verifiedAt)}</small
							>{/if}
					</p>{/if}
				{#if draft.mode === 'rules'}
					<div class="churn-conditions wide">
						<h3>Waiting periods</h3>
						<p>When more than one rule applies, the latest date wins.</p>
						{#each draft.conditions as condition, index (index)}
							<div class="churn-condition">
								<div class="finance-field">
									<label for={`churn-anchor-${index}`}>Count from</label><select
										id={`churn-anchor-${index}`}
										bind:value={condition.anchor}
										onchange={customize}
										>{#each ['paidDate', 'openedDate', 'closedDate'] as anchor (anchor)}<option
												value={anchor}
												>{anchorLabel(anchor as BonusChurnCondition['anchor'])}</option
											>{/each}</select
									>
								</div>
								<div class="finance-field">
									<label for={`churn-months-${index}`}>Months</label><input
										id={`churn-months-${index}`}
										type="number"
										min="0"
										max="1200"
										step="1"
										required
										bind:value={condition.months}
										oninput={customize}
									/>
								</div>
								<div class="finance-field">
									<label for={`churn-days-${index}`}>Days</label><input
										id={`churn-days-${index}`}
										type="number"
										min="0"
										max="36500"
										step="1"
										required
										bind:value={condition.days}
										oninput={customize}
									/>
								</div>
								{#if draft.conditions.length > 1}<button
										class="churn-remove"
										type="button"
										aria-label={`Remove waiting period ${index + 1}`}
										onclick={() => removeCondition(index)}>×</button
									>{/if}
							</div>
						{/each}
						{#if draft.conditions.length < 3}<button
								class="churn-link"
								type="button"
								onclick={addCondition}>+ Add another waiting period</button
							>{/if}
					</div>
				{/if}
				{#if draft.mode !== 'restricted'}
					<label class="churn-check wide"
						><input
							type="checkbox"
							bind:checked={draft.requiresClosed}
							onchange={() => {
								draft.presetId = null;
								if (draft.mode === 'rules') selection = 'custom';
							}}
						/>Requires closing the previous account</label
					>
				{/if}
				{#if needsPaid}<div class="finance-field">
						<label for="churn-paid">Bonus received date</label><input
							id="churn-paid"
							type="date"
							max={today}
							bind:value={paidDate}
						/><small>Actual payout, not the expected payout date.</small>
					</div>{/if}
				{#if needsOpened}<div class="finance-field">
						<label for="churn-opened">Account opened date</label><input
							id="churn-opened"
							type="date"
							max={today}
							bind:value={openedDate}
						/><small>Use the actual account opening date required by the rule.</small>
					</div>{/if}
				{#if needsClosed}<div class="finance-field">
						<label for="churn-closed">Account closed date</label><input
							id="churn-closed"
							type="date"
							max={today}
							bind:value={closedDate}
						/><small>Leave blank while still open. “Safe to close” does not start this clock.</small
						>
					</div>{/if}
				{#if draft.mode === 'manual'}<div class="finance-field">
						<label for="churn-manual">Date to recheck</label><input
							id="churn-manual"
							type="date"
							bind:value={manualDate}
						/>
					</div>{/if}
				{#if preview}<div class="churn-preview wide" aria-live="polite">
						<span>{bonusChurnStatusLabel(preview.status)}</span>{#if preview.reviewDate}<strong
								>{formatBonusChurnDate(preview.reviewDate)}</strong
							>{/if}
						<p>{preview.missing.length ? preview.missing.join(' · ') : preview.ruleSummary}</p>
					</div>{/if}
				<details class="churn-details wide">
					<summary>Rule source and private notes</summary>
					<div class="finance-field">
						<label for="churn-source">Offer terms URL</label><input
							id="churn-source"
							type="url"
							maxlength="2000"
							bind:value={sourceUrl}
							placeholder="https://"
						/>
					</div>
					<div class="finance-field">
						<label for="churn-notes">Eligibility notes</label><textarea
							id="churn-notes"
							maxlength="2000"
							bind:value={notes}></textarea>
					</div>
				</details>
			{:else}<p class="wide">
					This removes the repeat reminder and keeps your original bonus record.
				</p>{/if}
		</div>
		<div class="finance-form-actions">
			<button class="finance-button secondary" type="button" onclick={close} disabled={busy}
				>Cancel</button
			><button class="finance-button" type="submit" disabled={busy}
				>{busy ? 'Saving…' : 'Save repeat tracking'}</button
			>
		</div>
	</form>
</dialog>

<style>
	.wide {
		grid-column: 1 / -1;
	}

	.churn-panel {
		margin: 0 0 1.5rem;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--paper);
		overflow: hidden;
	}
	.churn-heading {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 1.1rem 1.2rem;
		align-items: center;
	}
	.churn-heading h2 {
		margin: 0.2rem 0 0.3rem;
		font-size: 1.05rem;
	}
	.churn-heading p:not(.finance-kicker) {
		margin: 0;
		font-size: 0.72rem;
		color: var(--muted);
	}
	.churn-counts {
		display: flex;
		gap: 1.2rem;
		flex-shrink: 0;
	}
	.churn-counts span {
		display: grid;
		gap: 0.15rem;
		color: var(--muted);
		font-size: 0.62rem;
	}
	.churn-counts strong {
		font-size: 1.3rem;
		color: var(--ink);
	}
	.churn-row {
		display: grid;
		grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) auto;
		align-items: center;
		gap: 1rem;
		padding: 0.9rem 1.2rem;
		border-top: 1px solid var(--line);
	}
	.churn-row.ready {
		background: rgba(34, 139, 94, 0.055);
	}
	.churn-name,
	.churn-state {
		display: grid;
		gap: 0.3rem;
	}
	.churn-name strong {
		font-size: 0.76rem;
		overflow-wrap: anywhere;
	}
	.churn-name span,
	.churn-state small {
		color: var(--muted);
		font-size: 0.64rem;
		line-height: 1.45;
	}
	.churn-state > strong {
		font-size: 0.85rem;
	}
	.churn-badge {
		justify-self: start;
		border-radius: 5px;
		padding: 0.22rem 0.4rem;
		font-size: 0.6rem;
		font-weight: 740;
		background: var(--paper-soft);
		color: var(--muted);
	}
	.churn-badge[data-status='ready'] {
		color: var(--positive);
		background: rgba(34, 139, 94, 0.1);
	}
	.churn-badge[data-status='waiting'] {
		color: var(--accent-dark);
		background: rgba(61, 90, 254, 0.08);
	}
	.churn-badge[data-status='needs_info'] {
		color: #895612;
		background: #fff2d8;
	}
	.churn-row > button {
		border: 1px solid var(--line);
		padding: 0.5rem 0.65rem;
		border-radius: 7px;
		background: white;
		color: var(--accent-dark);
		font-size: 0.65rem;
		font-weight: 700;
		cursor: pointer;
	}
	.churn-row > button span {
		margin-left: 0.5rem;
	}
	.churn-footnote {
		margin: 0;
		padding: 0.8rem 1.2rem;
		border-top: 1px solid var(--line);
		color: var(--faint);
		font-size: 0.62rem;
		line-height: 1.5;
	}
	.churn-notice {
		margin: 0;
		padding: 0.5rem 1.2rem;
		color: var(--positive);
		font-size: 0.7rem;
	}
	.churn-dialog {
		padding: 0;
		color: var(--ink);
		margin: auto;
		width: min(620px, calc(100% - 2rem));
		max-height: calc(100dvh - 2rem);
	}
	.churn-dialog::backdrop {
		background: rgba(24, 30, 42, 0.45);
		backdrop-filter: blur(3px);
	}
	.churn-dialog:not([open]) {
		display: none;
	}
	.churn-preset {
		margin: 0;
		padding: 0.75rem;
		background: var(--paper-soft);
		border-radius: 8px;
		color: var(--ink-soft);
		font-size: 0.72rem;
		line-height: 1.5;
	}
	.churn-preset a {
		color: var(--accent-dark);
		white-space: nowrap;
	}
	.churn-preset small {
		display: block;
		color: var(--muted);
		margin-top: 0.25rem;
	}
	.churn-conditions h3 {
		margin: 0;
		font-size: 0.8rem;
	}
	.churn-conditions > p {
		margin: 0.3rem 0 0.7rem;
		font-size: 0.68rem;
		color: var(--muted);
	}
	.churn-condition {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) 20px;
		gap: 0.5rem;
		align-items: end;
		margin: 0.5rem 0;
	}
	.churn-remove {
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
		padding: 0.5rem 0;
		font-size: 1.1rem;
	}
	.churn-link {
		border: 0;
		background: none;
		padding: 0.3rem 0;
		color: var(--accent-dark);
		font-size: 0.68rem;
		font-weight: 700;
		cursor: pointer;
	}
	.churn-check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.72rem;
		color: var(--ink-soft);
	}
	.churn-check input {
		accent-color: var(--accent);
	}
	.churn-preview {
		display: grid;
		gap: 0.35rem;
		padding: 0.8rem;
		border: 1px solid rgba(61, 90, 254, 0.2);
		border-radius: 8px;
		background: rgba(61, 90, 254, 0.04);
	}
	.churn-preview span {
		font-size: 0.68rem;
		color: var(--accent-dark);
		font-weight: 700;
	}
	.churn-preview strong {
		font-size: 1.05rem;
	}
	.churn-preview p {
		margin: 0;
		font-size: 0.68rem;
		color: var(--muted);
		line-height: 1.5;
	}
	.churn-details summary {
		font-size: 0.7rem;
		color: var(--muted);
		cursor: pointer;
	}
	.churn-details .finance-field {
		margin-top: 0.8rem;
	}
	@media (max-width: 620px) {
		.churn-heading {
			align-items: start;
			flex-direction: column;
		}
		.churn-counts {
			gap: 1.5rem;
		}
		.churn-row {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.7rem;
		}
		.churn-name {
			grid-column: 1 / -1;
		}
		.churn-row > button {
			font-size: 0.6rem;
		}
		.churn-condition {
			grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr) 16px;
			gap: 0.35rem;
		}
	}
</style>
