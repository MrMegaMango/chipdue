<script lang="ts">
	import { tick } from 'svelte';
	import { formatBonusChurnDate, getBonusChurnToday } from '$lib/bonus-churn';
	import { creditLimitReviewStatus } from '$lib/credit-limit-review';
	import { currentTime } from '$lib/sync-time';
	import type { CardCreditLimitReview } from '$lib/types';

	let {
		nickname,
		review,
		disabled = false,
		onsaved
	}: {
		nickname: string;
		review: CardCreditLimitReview | null | undefined;
		disabled?: boolean;
		onsaved: (review: CardCreditLimitReview | null) => Promise<void>;
	} = $props();
	let editing = $state(false);
	let saving = $state(false);
	let reviewDate = $state('');
	let dateSource = $state<CardCreditLimitReview['dateSource']>('estimated');
	let notes = $state('');
	let error = $state('');
	let dateInput = $state<HTMLInputElement>();
	let editButton = $state<HTMLButtonElement>();
	const timing = $derived(
		review ? creditLimitReviewStatus(review, getBonusChurnToday(new Date($currentTime))) : null
	);

	async function edit(): Promise<void> {
		reviewDate = review?.reviewDate ?? '';
		dateSource = review?.dateSource ?? 'estimated';
		notes = review?.notes ?? '';
		error = '';
		editing = true;
		await tick();
		dateInput?.focus();
	}

	async function close(): Promise<void> {
		editing = false;
		error = '';
		notes = '';
		await tick();
		editButton?.focus();
	}

	async function save(value: CardCreditLimitReview | null): Promise<void> {
		if (saving || disabled) return;
		saving = true;
		error = '';
		try {
			await onsaved(value);
			await close();
		} catch (failure) {
			error = failure instanceof Error ? failure.message : 'The review date could not be saved.';
		} finally {
			saving = false;
		}
	}

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		void save({ reviewDate, dateSource, notes: notes.trim() || null });
	}
</script>

<section
	class="limit-review"
	class:tracked={review}
	class:due={timing?.due}
	aria-label={`Credit-limit review for ${nickname}`}
>
	{#if review && timing}
		<header>
			<div>
				<h4>Credit-limit increase</h4>
				<strong>{formatBonusChurnDate(review.reviewDate)}</strong>
			</div>
			<span class="countdown">{timing.label}</span>
		</header>
		<p class="source">
			{review.dateSource === 'estimated'
				? 'Estimated review date'
				: 'Issuer-confirmed request date'}
		</p>
		<p>Review another request with your issuer. Approval is not guaranteed.</p>
		{#if review.notes}
			<details>
				<summary>Why this date?</summary>
				<p class="notes">{review.notes}</p>
			</details>
		{/if}
	{/if}
	{#if editing}
		<form onsubmit={submit} autocomplete="off">
			<label>
				<span>Review date</span>
				<input
					bind:this={dateInput}
					bind:value={reviewDate}
					type="date"
					name="creditLimitReviewDate"
					required
					disabled={saving || disabled}
				/>
			</label>
			<label>
				<span>Date source</span>
				<select bind:value={dateSource} disabled={saving || disabled}>
					<option value="estimated">Estimated</option>
					<option value="issuer_confirmed">Confirmed by issuer</option>
				</select>
			</label>
			<label>
				<span>Basis for this date <small>Optional</small></span>
				<textarea bind:value={notes} rows="3" maxlength="2000" disabled={saving || disabled}
				></textarea>
			</label>
			<p>
				Use the issuer’s notice or confirmed waiting period. A review date does not confirm
				eligibility.
			</p>
			{#if error}<p class="error" role="alert">{error}</p>{/if}
			<div class="actions">
				<button type="submit" class="primary" disabled={saving || disabled}
					>{saving ? 'Saving…' : 'Save review date'}</button
				>
				<button type="button" onclick={close} disabled={saving}>Cancel</button>
				{#if review}<button type="button" onclick={() => save(null)} disabled={saving || disabled}
						>Clear date</button
					>{/if}
			</div>
		</form>
	{:else}
		<button bind:this={editButton} class="edit" type="button" onclick={edit} {disabled}>
			{review ? 'Edit review date' : 'Track credit-limit review'}
		</button>
	{/if}
</section>

<style>
	.limit-review {
		padding: 12px 18px;
		border: 1px solid #e4e8ee;
		border-radius: 12px;
		background: white;
	}
	.tracked {
		background: #f7f9ff;
		border-color: #dce3f8;
		padding: 18px;
	}
	.due {
		border-color: #aad6be;
		background: #f5fbf7;
	}
	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}
	h4 {
		margin: 0 0 7px;
		font-size: 12px;
		color: #626d82;
		font-weight: 600;
	}
	strong {
		font-size: 20px;
		color: #182132;
	}
	.countdown {
		border-radius: 20px;
		padding: 5px 9px;
		background: #e8edfc;
		color: #354db3;
		font-size: 11px;
		font-weight: 650;
	}
	.due .countdown {
		background: #e1f2e7;
		color: #246c47;
	}
	p {
		margin: 8px 0 0;
		color: #626d82;
		font-size: 12px;
		line-height: 1.5;
	}
	.source {
		font-size: 11px;
	}
	details {
		margin: 12px 0;
	}
	summary {
		color: #354db3;
		cursor: pointer;
		font-size: 12px;
	}
	.notes {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	form {
		display: grid;
		gap: 12px;
		margin-top: 12px;
	}
	label {
		display: grid;
		gap: 6px;
		font-size: 12px;
		font-weight: 600;
		color: #354156;
	}
	small {
		font-weight: 400;
		color: #626d82;
	}
	input,
	select,
	textarea {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		border: 1px solid #cbd3df;
		border-radius: 6px;
		padding: 9px;
		font: inherit;
		background: white;
		color: #182132;
	}
	textarea {
		resize: vertical;
	}
	button {
		padding: 7px 10px;
		border: 1px solid #c8d0f3;
		border-radius: 6px;
		color: #354db3;
		background: white;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.6;
		cursor: wait;
	}
	button:focus-visible,
	summary:focus-visible {
		outline: 2px solid #354db3;
		outline-offset: 3px;
	}
	.edit {
		padding: 0;
		border: 0;
		background: none;
	}
	.tracked .edit {
		margin-top: 12px;
	}
	.primary {
		background: #354db3;
		color: white;
		border-color: #354db3;
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.error {
		color: #b43b3b;
	}
</style>
