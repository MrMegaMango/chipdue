<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		BONUS_CHURN_PRESETS,
		buildBonusChurnTracker,
		getBonusChurnToday,
		formatBonusChurnDate,
		bonusChurnStatusLabel
	} from '$lib/bonus-churn';
	import {
		resolveAutomaticBonusChurn,
		type BonusChurnAutomationResult
	} from '$lib/bonus-churn-automatic';
	import { clearPrivateApiCache } from '$lib/private-api-cache';
	import { currentTime } from '$lib/sync-time';
	import type {
		AccountBonus,
		BonusChurn,
		BonusChurnCondition,
		FinancialAccount,
		Card
	} from '$lib/types';

	let {
		bonuses,
		onupdated,
		tracking = {},
		loading = false,
		error: trackingError = '',
		accounts = [],
		cards = []
	}: {
		bonuses: AccountBonus[];
		onupdated: (bonus: AccountBonus) => void;
		tracking?: Record<string, BonusChurnAutomationResult>;
		loading?: boolean;
		error?: string;
		accounts?: FinancialAccount[];
		cards?: Card[];
	} = $props();
	let editing = $state<AccountBonus | null>(null);
	let dialog: HTMLDialogElement;
	let selection = $state('automatic');
	let draft = $state<BonusChurn>(blankRule());
	let paidDate = $state('');
	let openedDate = $state('');
	let closedDate = $state('');
	let manualDate = $state('');
	let sourceUrl = $state('');
	let notes = $state('');
	let paidDateEdited = $state(false);
	let openedDateEdited = $state(false);
	let closedDateEdited = $state(false);
	let correctionsOpen = $state(false);
	let busy = $state(false);
	let error = $state('');
	let notice = $state('');
	let requestVersion = 0;
	const today = $derived(getBonusChurnToday(new Date($currentTime)));
	const rank = { ready: 0, waiting: 1, needs_info: 2, unconfigured: 3, restricted: 4 };
	const rows = $derived(
		bonuses
			.map((bonus) => ({ bonus, result: resultFor(bonus) }))
			.toSorted(
				(a, b) =>
					rank[a.result.tracker.status] - rank[b.result.tracker.status] ||
					(a.result.tracker.reviewDate ?? a.result.projectionDate ?? '').localeCompare(
						b.result.tracker.reviewDate ?? b.result.projectionDate ?? ''
					) ||
					a.bonus.name.localeCompare(b.bonus.name)
			)
	);
	const readyCount = $derived(
		rows.filter(({ result }) => result.tracker.status === 'ready').length
	);
	const waitingCount = $derived(
		rows.filter(({ result }) => result.tracker.status === 'waiting').length
	);
	const editingResult = $derived(
		editing ? resultFor(bonuses.find((bonus) => bonus.id === editing?.id) ?? editing) : null
	);
	const automaticResult = $derived(
		editing
			? resolveAutomaticBonusChurn({ ...editing, churn: null }, activityFor(editing), today)
			: null
	);
	const editingRule = $derived(
		selection === 'automatic' ? (automaticResult?.effectiveRule ?? null) : draft
	);
	const selectedPreset = $derived(BONUS_CHURN_PRESETS.find((preset) => preset.id === selection));
	const needsPaid = $derived(
		editingRule?.mode === 'rules' &&
			editingRule.conditions.some((rule) => rule.anchor === 'paidDate')
	);
	const needsOpened = $derived(
		editingRule?.mode === 'rules' &&
			editingRule.conditions.some((rule) => rule.anchor === 'openedDate')
	);
	const needsClosed = $derived(
		Boolean(
			editingRule?.requiresClosed ||
			editingRule?.conditions.some((rule) => rule.anchor === 'closedDate')
		)
	);
	const preview = $derived.by(() => {
		if (!editing) return null;
		const rule = editingRule;
		if (!rule) return null;
		const evidence = selection === 'automatic' ? automaticResult : editingResult;
		return buildBonusChurnTracker(
			{
				...editing,
				paidDate: paidDateEdited
					? paidDate || null
					: (evidence?.paidDate ??
						(editingResult?.dateSources.paidDate === 'transaction'
							? editingResult.paidDate
							: editing.paidDate)),
				churn: {
					...rule,
					openedDate: openedDateEdited
						? openedDate || null
						: (rule.openedDate ?? evidence?.openedDate ?? null),
					closedDate: closedDateEdited
						? closedDate || null
						: (rule.closedDate ?? evidence?.closedDate ?? null),
					manualEligibleDate: manualDate || null
				}
			},
			today
		);
	});

	function activityFor(bonus: AccountBonus) {
		return {
			account: accounts.find((account) => account.id === bonus.accountId) ?? null,
			card: cards.find((card) => card.id === bonus.cardId) ?? null,
			activityState: 'unavailable' as const
		};
	}

	function resultFor(bonus: AccountBonus): BonusChurnAutomationResult {
		return tracking[bonus.id] ?? resolveAutomaticBonusChurn(bonus, activityFor(bonus), today);
	}

	function provenance(result: BonusChurnAutomationResult): string {
		return result.ruleSource === 'saved'
			? 'Saved rule or correction'
			: result.ruleSource === 'automatic'
				? 'Automatic rule match'
				: 'Offer-specific terms';
	}

	function dateEvidence(source: 'saved' | 'transaction' | 'account' | null): string {
		return source === 'transaction'
			? 'Detected in posted account activity'
			: source === 'account'
				? 'From the linked account'
				: source === 'saved'
					? 'Saved date'
					: 'Not confirmed in available data';
	}

	function checkedLabel(value: string | null): string | null {
		if (!value || !Number.isFinite(new Date(value).getTime())) return null;
		return new Intl.DateTimeFormat('en-US', {
			timeZone: 'America/Los_Angeles',
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			timeZoneName: 'short'
		}).format(new Date(value));
	}

	function blankRule(): BonusChurn {
		return {
			mode: 'rules',
			conditions: [{ anchor: 'paidDate', months: 24, days: 0 }],
			requiresClosed: false,
			openedDate: null,
			closedDate: null,
			manualEligibleDate: null,
			presetId: null,
			sourceUrl: null,
			notes: null
		};
	}

	function ruleSelection(rule: BonusChurn): string {
		return rule.presetId && BONUS_CHURN_PRESETS.some((preset) => preset.id === rule.presetId)
			? rule.presetId
			: rule.mode === 'rules'
				? 'custom'
				: rule.mode;
	}

	function open(bonus: AccountBonus): void {
		if (busy) return;
		editing = structuredClone($state.snapshot(bonus));
		const effectiveRule = resultFor(bonus).effectiveRule;
		draft = structuredClone($state.snapshot(bonus.churn ?? effectiveRule ?? blankRule()));
		selection = bonus.churn ? ruleSelection(bonus.churn) : 'automatic';
		paidDate = bonus.paidDate ?? '';
		openedDate = bonus.churn?.openedDate ?? '';
		closedDate = bonus.churn?.closedDate ?? '';
		manualDate = bonus.churn?.manualEligibleDate ?? '';
		sourceUrl = draft.sourceUrl ?? '';
		notes = draft.notes ?? '';
		paidDateEdited = false;
		openedDateEdited = false;
		closedDateEdited = false;
		correctionsOpen = false;
		error = '';
		notice = '';
		dialog.showModal();
	}

	function changeRule(): void {
		error = '';
		if (selection === 'automatic') {
			const automatic = editing
				? resolveAutomaticBonusChurn({ ...editing, churn: null }, activityFor(editing), today)
				: null;
			draft = structuredClone(automatic?.effectiveRule ?? blankRule());
			openedDate = '';
			closedDate = '';
			manualDate = '';
			openedDateEdited = false;
			closedDateEdited = false;
			sourceUrl = draft.sourceUrl ?? '';
			notes = draft.notes ?? '';
			return;
		}
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

	function correctRuleDate(anchor: 'openedDate' | 'closedDate'): void {
		if (anchor === 'openedDate') openedDateEdited = true;
		else closedDateEdited = true;
		if (selection === 'automatic') selection = ruleSelection(draft);
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
		if (selection !== 'automatic' && draft.mode === 'rules') {
			if (
				new Set(draft.conditions.map((condition) => condition.anchor)).size !==
				draft.conditions.length
			) {
				error = 'Use each starting date only once.';
				return;
			}
			if (
				!draft.conditions.length ||
				draft.conditions.some((condition) => !(condition.months > 0 || condition.days > 0))
			) {
				error = 'Each waiting period needs at least one month or one day.';
				return;
			}
		}
		const bonusId = editing.id;
		const currentBonus = bonuses.find((bonus) => bonus.id === bonusId);
		if (currentBonus && currentBonus.updatedAt !== editing.updatedAt) {
			error = 'This bonus was updated. Close and reopen details before saving your correction.';
			return;
		}
		busy = true;
		error = '';
		const version = ++requestVersion;
		const churn =
			selection === 'automatic'
				? null
				: {
						...draft,
						openedDate: openedDate || null,
						closedDate: closedDate || null,
						manualEligibleDate: manualDate || null,
						sourceUrl: sourceUrl.trim() || null,
						notes: notes.trim() || null
					};
		const savePaidDate = paidDateEdited && paidDate !== (editing.paidDate ?? '');
		try {
			const response = await fetch(resolve('/api/bonuses/[id]', { id: bonusId }), {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ churn, ...(savePaidDate ? { paidDate: paidDate || null } : {}) })
			});
			if (!response.ok) {
				if (response.status === 401) {
					clearPrivateApiCache();
					window.location.assign(resolve('/'));
					return;
				}
				const payload = await response.json().catch(() => null);
				throw new Error(payload?.error?.message ?? 'Repeat bonus corrections could not be saved.');
			}
			const payload = (await response.json()) as { bonus: AccountBonus };
			if (version !== requestVersion || editing?.id !== bonusId) return;
			clearPrivateApiCache();
			onupdated(payload.bonus);
			dialog.close();
			notice = churn
				? 'Repeat bonus correction saved.'
				: 'Automatic repeat bonus tracking enabled.';
		} catch (cause) {
			if (version === requestVersion)
				error =
					cause instanceof Error ? cause.message : 'Repeat bonus corrections could not be saved.';
		} finally {
			if (version === requestVersion) busy = false;
		}
	}
</script>

<section class="churn-panel" aria-labelledby="churn-title">
	<div class="churn-heading">
		<div>
			<p class="finance-kicker">Plan your next round</p>
			<h2 id="churn-title">When can I earn it again?</h2>
			<p>Repeat-bonus timing from your accounts, saved offers, and posted activity.</p>
		</div>
		<div class="churn-counts">
			<span><strong>{readyCount}</strong> ready to review</span>
			<span><strong>{waitingCount}</strong> cooling down</span>
		</div>
	</div>
	{#if notice}<p class="churn-notice" role="status">{notice}</p>{/if}
	{#if loading}<p class="churn-loading" role="status">Checking connected activity…</p>{/if}
	{#if trackingError}<p class="churn-error" role="status">
			{trackingError}
		</p>{/if}
	<div class="churn-rows">
		{#each rows as { bonus, result } (bonus.id)}
			<div class="churn-row" class:ready={result.tracker.status === 'ready'}>
				<div class="churn-name">
					<strong>{bonus.name}</strong>
					<span>{bonus.institution ?? 'Bonus offer'}</span>
					<small class="churn-provenance">{provenance(result)}</small>
				</div>
				<div class="churn-state">
					<span class="churn-badge" data-status={result.tracker.status}>{result.statusLabel}</span>
					{#if result.tracker.reviewDate}<strong
							>{formatBonusChurnDate(result.tracker.reviewDate)}</strong
						>{/if}
					{#if result.tracker.status === 'waiting'}<small
							>{result.tracker.daysRemaining}
							{result.tracker.daysRemaining === 1 ? 'day' : 'days'} to recheck</small
						>{/if}
					<small>{result.detail}</small>
					{#if result.projectionDate}
						<div class="churn-projection">
							<span>Earliest estimated recheck</span><strong
								>{formatBonusChurnDate(result.projectionDate)}</strong
							><small>{result.projectionNote}</small>
						</div>
					{/if}
				</div>
				<button
					type="button"
					onclick={() => open(bonus)}
					aria-label={`Repeat bonus details for ${bonus.name}`}
					>Details <span aria-hidden="true">↗</span></button
				>
			</div>
		{/each}
	</div>
	<p class="churn-footnote">
		Dates are reminders to review eligibility, not approval guarantees. Projections are labeled
		separately from confirmed dates. Other accounts, prior bonuses, and current offer terms can
		affect eligibility. Countdowns use Pacific time.
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
			<h2 id="repeat-bonus-title">Repeat bonus details</h2>
			<p>{editing?.name}</p>
		</div>
		<button type="button" aria-label="Close repeat bonus tracking" onclick={close} disabled={busy}
			>×</button
		>
	</header>
	{#if editingResult}
		<div class="churn-detected">
			<div class="churn-detected-state">
				<span class="churn-badge" data-status={editingResult.tracker.status}
					>{editingResult.statusLabel}</span
				>
				{#if editingResult.tracker.reviewDate}<strong
						>{formatBonusChurnDate(editingResult.tracker.reviewDate)}</strong
					>{/if}
				<p>{editingResult.detail}</p>
			</div>
			{#if editingResult.projectionDate}<div class="churn-projection">
					<span>Earliest estimated recheck</span><strong
						>{formatBonusChurnDate(editingResult.projectionDate)}</strong
					><small>{editingResult.projectionNote}</small>
				</div>{/if}
			<div class="churn-detected-rule">
				<h3>
					{editingResult.ruleSource === 'saved' ? 'Saved rule or correction' : 'Detected rule'}
				</h3>
				<p>
					{editingResult.effectiveRule
						? editingResult.tracker.ruleSummary
						: 'No confirmed repeat-bonus rule was found in the available offer terms.'}
				</p>
				{#if editingResult.sourceUrl}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- Saved offer terms are an external URL. -->
					<a href={editingResult.sourceUrl} target="_blank" rel="noreferrer">Offer terms ↗</a>
				{/if}
				{#if editingResult.ruleVerifiedAt}<small class="churn-terms-checked">
						Terms checked {formatBonusChurnDate(editingResult.ruleVerifiedAt)}
					</small>{/if}
			</div>
			<dl class="churn-evidence">
				<div>
					<dt>Bonus received</dt>
					<dd>
						{editingResult.paidDate
							? formatBonusChurnDate(editingResult.paidDate)
							: 'Not confirmed'}<small>{dateEvidence(editingResult.dateSources.paidDate)}</small>
					</dd>
				</div>
				<div>
					<dt>Account opened</dt>
					<dd>
						{editingResult.openedDate
							? formatBonusChurnDate(editingResult.openedDate)
							: 'Not confirmed'}<small>{dateEvidence(editingResult.dateSources.openedDate)}</small>
					</dd>
				</div>
				<div>
					<dt>Account closed</dt>
					<dd>
						{editingResult.closedDate
							? formatBonusChurnDate(editingResult.closedDate)
							: 'No recorded closure'}<small
							>{dateEvidence(editingResult.dateSources.closedDate)}</small
						>
					</dd>
				</div>
			</dl>
			{#if checkedLabel(editingResult.checkedAt)}<p class="churn-checked">
					Activity checked {checkedLabel(editingResult.checkedAt)}
				</p>{/if}
		</div>
	{/if}
	<details class="churn-corrections" bind:open={correctionsOpen}>
		<summary>Correct dates or override rule</summary>
		<form class="finance-form" onsubmit={save}>
			<p class="churn-form-intro">
				Tracking uses your available records and connected activity. Correct a date or rule when
				needed.
			</p>
			<fieldset class="churn-fieldset" disabled={busy}>
				{#if error}<p class="finance-form-error" role="alert">{error}</p>{/if}
				<div class="finance-form-grid">
					<div class="finance-field wide">
						<label for="churn-rule">Repeat-bonus rule</label>
						<select id="churn-rule" bind:value={selection} onchange={changeRule}>
							<option value="automatic">Automatic</option>
							<option value="custom">Custom waiting period</option>
							<option value="manual">Specific date to recheck</option>
							<option value="restricted">No confirmed reset / offer review required</option>
							<optgroup label="Offer-specific starting points"
								>{#each BONUS_CHURN_PRESETS as preset (preset.id)}<option value={preset.id}
										>{preset.label}</option
									>{/each}</optgroup
							>
						</select>
						<small
							>Choose the exact product and rule from your offer. A bank connection does not
							establish bonus eligibility.</small
						>
					</div>
					{#if selection === 'automatic'}<p class="churn-automatic-note wide">
							Use the detected offer rule and available account activity. Saving Automatic clears
							saved repeat-tracking overrides. Original bonus dates stay saved.
						</p>{/if}
					{#if selectedPreset}<p class="churn-preset wide">
							{selectedPreset.description}
							<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- Issuer terms are an external URL. -->
							<a href={selectedPreset.sourceUrl} target="_blank" rel="noreferrer"
								>Official terms ↗</a
							>{#if selectedPreset.verifiedAt}<small
									>Checked {formatBonusChurnDate(selectedPreset.verifiedAt)}</small
								>{/if}
						</p>{/if}
					{#if selection !== 'automatic' && draft.mode === 'rules'}
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
					{#if selection !== 'automatic' && draft.mode !== 'restricted'}
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
								oninput={() => {
									paidDateEdited = true;
								}}
							/><small
								>{editingResult?.dateSources.paidDate === 'transaction'
									? `Detected ${formatBonusChurnDate(editingResult.paidDate)} in posted activity. Leave blank to keep using it.`
									: 'An explicit correction to the actual payout date.'}</small
							>
						</div>{/if}
					{#if needsOpened}<div class="finance-field">
							<label for="churn-opened">Account opened date</label><input
								id="churn-opened"
								type="date"
								max={today}
								bind:value={openedDate}
								oninput={() => correctRuleDate('openedDate')}
							/><small
								>{editingResult?.openedDate
									? `Available date: ${formatBonusChurnDate(editingResult.openedDate)}. Enter a date only to override it.`
									: 'An actual opening date correction; your offer enrollment date stays unchanged.'}</small
							>
						</div>{/if}
					{#if needsClosed}<div class="finance-field">
							<label for="churn-closed">Account closed date</label><input
								id="churn-closed"
								type="date"
								max={today}
								bind:value={closedDate}
								oninput={() => correctRuleDate('closedDate')}
							/><small
								>Leave blank while still open. “Safe to close” does not start this clock.</small
							>
						</div>{/if}
					{#if selection !== 'automatic' && draft.mode === 'manual'}<div class="finance-field">
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
					{#if selection !== 'automatic'}<details class="churn-details wide">
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
						</details>{/if}
				</div>
				<div class="finance-form-actions">
					<button class="finance-button secondary" type="button" onclick={close} disabled={busy}
						>Close</button
					><button class="finance-button" type="submit" disabled={busy}
						>{busy
							? 'Saving…'
							: selection === 'automatic'
								? 'Use automatic tracking'
								: 'Save correction'}</button
					>
				</div>
			</fieldset>
		</form>
	</details>
</dialog>

<style>
	.wide {
		grid-column: 1 / -1;
	}

	.churn-panel {
		margin: 1.5rem 0;
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
	.churn-provenance {
		color: var(--accent-dark);
		font-size: 0.6rem;
		line-height: 1.45;
	}
	.churn-projection {
		display: grid;
		gap: 0.25rem;
		margin-top: 0.45rem;
		padding: 0.55rem 0.65rem;
		border: 1px dashed var(--line-strong);
		border-radius: 7px;
		background: var(--paper-soft);
	}
	.churn-projection > span {
		font-size: 0.6rem;
		font-weight: 700;
		color: var(--muted);
	}
	.churn-projection > strong {
		font-size: 0.8rem;
	}
	.churn-projection > small {
		font-size: 0.64rem;
		line-height: 1.45;
		color: var(--muted);
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
	.churn-loading,
	.churn-error {
		margin: 0;
		padding: 0.5rem 1.2rem;
		font-size: 0.68rem;
		line-height: 1.45;
		color: var(--muted);
	}
	.churn-error {
		color: #895612;
		background: #fff2d8;
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
	.churn-detected {
		display: grid;
		gap: 1rem;
		padding: 1.2rem 1.35rem;
	}
	.churn-detected-state {
		display: grid;
		gap: 0.45rem;
	}
	.churn-detected-state > strong {
		font-size: 1.15rem;
	}
	.churn-detected p,
	.churn-form-intro,
	.churn-automatic-note {
		margin: 0;
		font-size: 0.72rem;
		line-height: 1.55;
		color: var(--muted);
	}
	.churn-detected-rule h3 {
		margin: 0 0 0.35rem;
		font-size: 0.78rem;
	}
	.churn-detected-rule a {
		display: inline-block;
		margin-top: 0.45rem;
		font-size: 0.7rem;
		color: var(--accent-dark);
	}
	.churn-terms-checked {
		display: block;
		margin-top: 0.35rem;
		font-size: 0.62rem;
		color: var(--muted);
	}
	.churn-evidence {
		display: grid;
		gap: 0.75rem;
		margin: 0;
		padding: 0.85rem 0;
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}
	.churn-evidence > div {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr);
		gap: 0.75rem;
		font-size: 0.72rem;
	}
	.churn-evidence dt {
		color: var(--muted);
	}
	.churn-evidence dd {
		display: grid;
		gap: 0.2rem;
		margin: 0;
		font-weight: 650;
	}
	.churn-evidence small {
		color: var(--muted);
		font-weight: 400;
		font-size: 0.62rem;
		line-height: 1.45;
	}
	.churn-detected .churn-checked {
		font-size: 0.62rem;
	}
	.churn-corrections {
		border-top: 1px solid var(--line);
	}
	.churn-corrections > summary {
		padding: 1rem 1.35rem;
		font-size: 0.73rem;
		font-weight: 650;
		color: var(--muted);
		cursor: pointer;
	}
	.churn-corrections[open] > summary {
		border-bottom: 1px solid var(--line);
	}
	.churn-form-intro {
		margin-bottom: 1rem;
	}
	.churn-fieldset {
		min-width: 0;
		border: 0;
		margin: 0;
		padding: 0;
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
