<script lang="ts">
	import { getBonusChurnToday } from '$lib/bonus-churn';
	import { currentTime } from '$lib/sync-time';
	import { cardDowngradeTiming, type CardDowngradeDates } from '$lib/card-downgrade';
	let { bonus }: { bonus: CardDowngradeDates } = $props();
	const timing = $derived(cardDowngradeTiming(bonus, getBonusChurnToday(new Date($currentTime))));
	const dateFormat = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'UTC'
	});
	function formatDate(value: string | null): string {
		return value ? dateFormat.format(new Date(`${value}T00:00:00Z`)) : 'Not confirmed';
	}
</script>

<section
	class="downgrade-timing"
	class:conflict={timing.conflict || timing.expired}
	aria-label="Downgrade timing"
>
	<dl>
		<div>
			<dt>Downgrade by to avoid fee</dt>
			<dd>
				{formatDate(timing.deadline)}{timing.expired ? ' · Passed' : ''}
				{#if timing.estimated}<small>Estimated</small>{/if}
			</dd>
		</div>
		<div>
			<dt>Earliest downgrade</dt>
			<dd>{formatDate(timing.earliest)}</dd>
		</div>
	</dl>
	<p>{timing.message}</p>
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
	.conflict p {
		color: #9b3b20;
	}
</style>
