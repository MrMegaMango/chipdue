<script lang="ts">
	import { getBonusChurnToday } from '$lib/bonus-churn';
	import { currentTime } from '$lib/sync-time';
	import { cardDowngradeTiming, type CardDowngradeDates } from '$lib/card-downgrade';
	import type { AccountBonus } from '$lib/types';
	type BonusContext = CardDowngradeDates &
		Partial<
			Pick<
				AccountBonus,
				'name' | 'notes' | 'institution' | 'rewardCents' | 'currency' | 'openedDate'
			>
		>;
	let { bonus }: { bonus: BonusContext } = $props();
	let copyStatus = $state('');
	const timing = $derived(cardDowngradeTiming(bonus, getBonusChurnToday(new Date($currentTime))));
	const issuer = $derived(bonus.institution?.trim() || 'your issuer');
	const reward = $derived(
		bonus.rewardCents != null && bonus.rewardCents > 0
			? new Intl.NumberFormat('en-US', {
					style: 'currency',
					currency: bonus.currency ?? 'USD',
					minimumFractionDigits: 0,
					maximumFractionDigits: 2
				}).format(bonus.rewardCents / 100)
			: null
	);
	const question = $derived(
		[
			bonus.name ? `I'm asking about my ${bonus.name}.` : '',
			`I want to downgrade to a no-annual-fee card, keep my ${reward ? `${reward} ` : ''}bonus, and avoid any annual fee being charged, even temporarily.`,
			'What is the latest date the downgrade can take effect?',
			timing.deadline
				? `My saved fee cutoff is ${formatDate(timing.deadline)}${timing.estimated ? ' (estimated)' : ''}.`
				: '',
			timing.earliest ? `My saved bonus hold date is ${formatDate(timing.earliest)}.` : '',
			'Please confirm whether a date meets both conditions and how much processing time is needed.'
		]
			.filter(Boolean)
			.join(' ')
	);
	const dateFormat = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC'
	});
	function formatDate(value: string | null): string {
		return value ? dateFormat.format(new Date(`${value}T00:00:00Z`)) : 'Not confirmed';
	}
	async function copyQuestion(): Promise<void> {
		try {
			await navigator.clipboard.writeText(question);
			copyStatus = 'Question copied.';
		} catch {
			copyStatus = 'Select and copy the question below.';
		}
	}
</script>

<section
	class="downgrade-timing"
	class:conflict={timing.conflict || timing.expired}
	aria-label="Downgrade timing"
>
	<dl>
		<div>
			<dt>Avoid annual-fee charge by</dt>
			<dd>
				{formatDate(timing.deadline)}{timing.expired ? ' · Passed' : ''}
				{#if timing.deadline}
					<small>{timing.estimated ? 'Estimated cutoff' : 'Issuer-confirmed cutoff'}</small>
				{/if}
			</dd>
			<dd class="date-help">
				{timing.deadline
					? 'The downgrade must take effect by this date.'
					: 'Confirm the latest effective downgrade date with your issuer.'}
			</dd>
		</div>
		<div>
			<dt>Bonus hold ends</dt>
			<dd>
				{formatDate(timing.earliest)}
				{#if timing.earliest}<small>Saved hold date</small>{/if}
			</dd>
			<dd class="date-help">
				{timing.earliest
					? `Downgrading earlier may risk ${reward ? `your ${reward} bonus` : 'your bonus'}.`
					: 'Confirm how long you must keep the card to protect your bonus.'}
			</dd>
		</div>
	</dl>
	<p class="timing-message">
		{#if timing.conflict}<strong>Ask {issuer} before downgrading.</strong>{/if}
		{timing.message}
	</p>
	<p class="goal"><strong>Goal:</strong> No annual fee charged, even temporarily.</p>
	<details>
		<summary>Why these dates?</summary>
		{#if bonus.openedDate}
			<p><strong>Saved offer date:</strong> {formatDate(bonus.openedDate)}</p>
		{/if}
		<p>
			{timing.estimated
				? 'The fee cutoff is a planning estimate from your offer terms. Your issuer has not confirmed the exact fee timing.'
				: timing.deadline
					? 'The fee cutoff is saved as issuer-confirmed.'
					: 'A fee cutoff has not been saved yet.'}
			The bonus hold date is intended to protect the bonus; it does not establish when a fee starts. A
			fee-refund deadline is different from avoiding a charge.
		</p>
		{#if bonus.notes?.trim()}
			<p class="context-label">Saved offer context</p>
			<p class="saved-notes">{bonus.notes}</p>
		{/if}
		<p class="context-label">Ask {issuer}</p>
		<blockquote>{question}</blockquote>
		<button type="button" onclick={copyQuestion}>Copy question</button>
		<p class="copy-status" role="status">{copyStatus}</p>
	</details>
</section>

<style>
	.downgrade-timing {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid #dcdff7;
	}
	dl {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		margin: 0;
	}
	dt {
		color: #626d82;
		font-size: 12px;
		line-height: 1.45;
	}
	dd {
		margin: 2px 0 0;
		color: #182132;
		font-size: 14px;
		font-weight: 750;
	}
	p {
		margin: 10px 0 0;
		color: #626d82;
		font-size: 12px;
		line-height: 1.5;
	}
	dd small {
		display: block;
		margin-top: 3px;
		color: #626d82;
		font-size: 11px;
		font-weight: 500;
	}
	.date-help {
		margin-top: 6px;
		color: #626d82;
		font-size: 11px;
		font-weight: 450;
		line-height: 1.45;
	}
	.timing-message strong {
		display: block;
		margin-bottom: 4px;
	}
	.conflict .timing-message {
		color: #9b3b20;
	}
	.goal {
		font-size: 11px;
	}
	details {
		margin-top: 12px;
		border-top: 1px solid #dcdff7;
		padding-top: 10px;
	}
	summary {
		color: #354db3;
		font-size: 12px;
		font-weight: 650;
		cursor: pointer;
	}
	.context-label {
		font-weight: 700;
		color: #182132;
	}
	.saved-notes {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	blockquote {
		margin: 8px 0 12px;
		padding-left: 10px;
		border-left: 2px solid #c8d0f3;
		font-size: 12px;
		line-height: 1.5;
		color: #465163;
	}
	button {
		padding: 7px 10px;
		border: 1px solid #c8d0f3;
		border-radius: 5px;
		color: #354db3;
		background: #f7f8ff;
		font: inherit;
		font-size: 12px;
		font-weight: 650;
		cursor: pointer;
	}
	.copy-status:empty {
		display: none;
	}
</style>
