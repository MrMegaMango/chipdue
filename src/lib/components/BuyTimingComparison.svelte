<script lang="ts">
	import { resolve } from '$app/paths';
	import type { BuyTimingRange, BuyTimingResponse, BuyTimingSchedule } from '$lib/buy-timing';
	import type { FinancialAccount } from '$lib/types';

	let { accounts }: { accounts: FinancialAccount[] } = $props();
	let selectedId = $state('');
	let range = $state<BuyTimingRange>('1Y');
	let schedule = $state<BuyTimingSchedule>('monthly');
	let response = $state<BuyTimingResponse | null>(null);
	let loading = $state(false);
	let error = $state('');
	let retry = $state(0);
	let selectedPoint = $state<number | null>(null);
	const schedules: Array<{ value: BuyTimingSchedule; label: string }> = [
		{ value: 'monthly', label: 'Monthly' },
		{ value: 'weekly', label: 'Weekly' },
		{ value: 'biweekly', label: 'Every 2 weeks' }
	];
	const ranges: BuyTimingRange[] = ['1M', '3M', 'YTD', '1Y', 'ALL'];
	const eligible = $derived(
		accounts
			.filter(
				(account) =>
					account.accountType === 'brokerage' && account.status === 'active' && !account.hidden
			)
			.sort((a, b) => (b.currentBalanceCents ?? 0) - (a.currentBalanceCents ?? 0))
	);
	const selected = $derived(eligible.find((account) => account.id === selectedId) ?? eligible[0]);
	const requestKey = $derived(
		selected ? `${selected.id}/${range}/${schedule}/${selected.lastSyncedAt ?? ''}/${retry}` : ''
	);
	const scheduleLabel = $derived(schedules.find((item) => item.value === schedule)!.label);

	$effect(() => {
		const key = requestKey;
		response = null;
		error = '';
		selectedPoint = null;
		if (!key) {
			loading = false;
			return;
		}
		const [id, requestedRange, requestedSchedule] = key.split('/');
		const controller = new AbortController();
		loading = true;
		void fetch(
			`${resolve('/api/accounts/[id]/buy-timing', { id })}?range=${requestedRange}&schedule=${requestedSchedule}`,
			{ signal: controller.signal }
		)
			.then(async (result) => {
				if (!result.ok) throw new Error('Comparison unavailable');
				const data = (await result.json()) as BuyTimingResponse;
				if (!controller.signal.aborted) response = data;
			})
			.catch(() => {
				if (!controller.signal.aborted)
					error = 'The buy-timing comparison is temporarily unavailable. Try again in a moment.';
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});
		return () => controller.abort();
	});

	const available = $derived(
		response?.comparison.status === 'available' ? response.comparison : null
	);
	const coverage = $derived(response?.coverage);
	const width = 900;
	const height = 270;
	const left = 70;
	const right = 18;
	const top = 22;
	const bottom = 34;
	const chart = $derived.by(() => {
		if (!available) return null;
		const gain = (value: number) => (value / available.totalInvestedCents - 1) * 100;
		const values = available.points.flatMap((point) => [
			gain(point.actualValueCents),
			gain(point.scheduledValueCents)
		]);
		const low = Math.min(0, ...values);
		const high = Math.max(0, ...values);
		const pad = Math.max((high - low) * 0.15, 1);
		const min = low - pad;
		const max = high + pad;
		const first = Date.parse(available.startDate);
		const span = Math.max(1, Date.parse(available.endDate) - first);
		const y = (value: number) => top + ((max - value) / (max - min)) * (height - top - bottom);
		const purchases = new Map(available.buyDates.map((buy) => [buy.date, buy.amountCents]));
		const points = available.points.map((point) => ({
			...point,
			x: left + ((Date.parse(point.date) - first) / span) * (width - left - right),
			y: y(gain(point.actualValueCents)),
			scheduledY: y(gain(point.scheduledValueCents)),
			purchaseCents: purchases.get(point.date) ?? 0
		}));
		return {
			points,
			actualPath: points
				.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`)
				.join(' '),
			scheduledPath: points
				.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.scheduledY}`)
				.join(' '),
			ticks: [max, (max + min) / 2, min].map((value) => ({ value, y: y(value) })),
			zeroY: y(0)
		};
	});
	const focusedPoint = $derived(
		chart?.points[Math.min(selectedPoint ?? chart.points.length - 1, chart.points.length - 1)]
	);
	const dateFormat = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		timeZone: 'America/Los_Angeles'
	});
	const shortDateFormat = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		timeZone: 'America/Los_Angeles'
	});
	function date(day: string, short = false): string {
		return (short ? shortDateFormat : dateFormat).format(new Date(`${day}T20:00:00Z`));
	}
	function money(cents: number): string {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: 'USD',
			maximumFractionDigits: 2
		}).format(cents / 100);
	}
	function signedMoney(cents: number): string {
		return `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${money(Math.abs(cents))}`;
	}
	function pointAtPointer(event: PointerEvent): void {
		if (!chart) return;
		const bounds = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
		const x = ((event.clientX - bounds.left) / bounds.width) * width;
		let nearest = 0;
		chart.points.forEach((point, index) => {
			if (Math.abs(point.x - x) < Math.abs(chart!.points[nearest].x - x)) nearest = index;
		});
		selectedPoint = nearest;
	}
</script>

{#if eligible.length > 0}
	<section class="timing" aria-labelledby="buy-timing-title">
		<div class="heading">
			<div>
				<p class="eyebrow">Buy timing</p>
				<h2 id="buy-timing-title">Did your buy dates help?</h2>
				<p class="subtitle">
					Compare your recorded purchases with regular buying of the same securities.
				</p>
			</div>
			<span class="badge">Hypothetical comparison</span>
		</div>
		<div class="controls">
			<label
				>Account for buy timing
				<select value={selected?.id} onchange={(event) => (selectedId = event.currentTarget.value)}>
					{#each eligible as account (account.id)}
						<option value={account.id}
							>{account.nickname}{account.last4 ? ` · ${account.last4}` : ''}</option
						>
					{/each}
				</select>
			</label>
			<label
				>Fixed buying schedule
				<select bind:value={schedule}>
					{#each schedules as item (item.value)}<option value={item.value}>{item.label}</option
						>{/each}
				</select>
			</label>
			<div class="ranges" aria-label="Buy timing period">
				{#each ranges as value (value)}
					<button type="button" aria-pressed={range === value} onclick={() => (range = value)}
						>{value === 'ALL' ? 'All' : value}</button
					>
				{/each}
			</div>
		</div>
		{#if loading}
			<p class="empty" role="status">
				Comparing your saved purchases with {scheduleLabel.toLowerCase()} buying…
			</p>
		{:else if error}
			<div class="empty" role="status">
				<p>{error}</p>
				<button class="retry" type="button" onclick={() => retry++}>Try again</button>
			</div>
		{:else if available && chart}
			<div class="metrics">
				<div class="impact">
					<span>Effect of your recorded buy dates</span>
					<strong
						class:negative={available.differenceCents < 0}
						class:neutral={available.differenceCents === 0}
						>{signedMoney(available.differenceCents)}</strong
					>
					<small
						>{available.differenceCents === 0
							? 'Same modeled ending value'
							: `${Math.abs(available.differencePercent).toFixed(2)}% of the purchase budget ${available.differenceCents > 0 ? 'ahead' : 'behind'}`}</small
					>
				</div>
				<div>
					<span>Your recorded dates</span><strong>{money(available.actualValueCents)}</strong><small
						>Modeled ending value</small
					>
				</div>
				<div class="scheduled">
					<span>{scheduleLabel} buying</span><strong>{money(available.scheduledValueCents)}</strong
					><small>Modeled ending value</small>
				</div>
			</div>
			<p class="budget">
				Same <strong>{money(available.totalInvestedCents)}</strong> purchase budget · {coverage?.includedBuyCount ??
					0} buys · {available.securities.length}
				{available.securities.length === 1 ? 'security' : 'securities'} · {available.scheduleDates
					.length} scheduled purchases per security
			</p>
			<p class="assumption">
				Uses daily closing prices and holds every modeled purchase through {date(
					available.endDate
				)}. The fixed schedule assumes the money was available when needed.
			</p>
			{#if coverage && coverage.postedDateBuyCount > 0}
				<p class="notice">
					{coverage.postedDateBuyCount}
					{coverage.postedDateBuyCount === 1
						? 'purchase uses its posting date'
						: 'purchases use posting dates'} because an order date was unavailable. Results may differ
					from your execution-date timing.
				</p>
			{/if}
			{#if coverage && coverage.excludedBuyCount > 0}
				<p class="notice">
					Partial coverage: {coverage.excludedBuyCount}
					{coverage.excludedBuyCount === 1 ? 'purchase is' : 'purchases are'} excluded from both sides.
					See coverage below.
				</p>
			{/if}
			<div class="chart-heading">
				<div class="legend">
					<span><i></i>Your buy dates</span><span
						><i class="scheduled-line"></i>{scheduleLabel}</span
					>
				</div>
				<span>{date(available.startDate)} – {date(available.endDate)}</span>
			</div>
			<svg
				class="chart"
				viewBox={`0 0 ${width} ${height}`}
				role="img"
				aria-label={`Hypothetical growth of the same purchase budget: your buy dates ${money(available.actualValueCents)}, ${scheduleLabel.toLowerCase()} ${money(available.scheduledValueCents)}`}
				onpointermove={pointAtPointer}
				onpointerleave={() => (selectedPoint = null)}
			>
				{#each chart.ticks as tick (tick.y)}
					<line x1={left} x2={width - right} y1={tick.y} y2={tick.y} class="grid" />
					<text x={left - 12} y={tick.y + 4} text-anchor="end">{tick.value.toFixed(1)}%</text>
				{/each}
				<line x1={left} x2={width - right} y1={chart.zeroY} y2={chart.zeroY} class="zero" />
				<path d={chart.scheduledPath} class="line scheduled-stroke" />
				<path d={chart.actualPath} class="line" />
				{#each chart.points.filter((point) => point.purchaseCents > 0) as point (point.date)}
					<circle cx={point.x} cy={point.y} r="3.5" class="buy-dot" />
				{/each}
				{#if focusedPoint}<line
						x1={focusedPoint.x}
						x2={focusedPoint.x}
						y1={top}
						y2={height - bottom}
						class="cursor"
					/>{/if}
				<text x={left} y={height - 8}>{date(available.startDate, true)}</text>
				<text x={width - right} y={height - 8} text-anchor="end"
					>{date(available.endDate, true)}</text
				>
			</svg>
			<p class="chart-note">
				Growth of the same starting budget, including cash waiting to be invested. Dots mark your
				recorded buy dates.
			</p>
			{#if focusedPoint}
				<div class="point-detail">
					<span>{date(focusedPoint.date)}</span><span
						>Your dates <b>{money(focusedPoint.actualValueCents)}</b></span
					><span>{scheduleLabel} <b>{money(focusedPoint.scheduledValueCents)}</b></span
					>{#if focusedPoint.purchaseCents > 0}<span
							>Recorded buys <b>{money(focusedPoint.purchaseCents)}</b></span
						>{/if}
				</div>
				<label class="scrubber"
					>Explore buy timing
					<input
						type="range"
						min="0"
						max={chart.points.length - 1}
						value={selectedPoint ?? chart.points.length - 1}
						oninput={(event) => (selectedPoint = Number(event.currentTarget.value))}
						aria-valuetext={`${date(focusedPoint.date)}: your dates ${money(focusedPoint.actualValueCents)}, ${scheduleLabel.toLowerCase()} ${money(focusedPoint.scheduledValueCents)}`}
					/>
				</label>
			{/if}
			<div class="security-results">
				{#each available.securities as security (security.symbol)}
					<div class="security-result">
						<div>
							<strong>{security.symbol}</strong><span
								>{security.buyCount} buys · {money(security.budgetCents)} invested</span
							>
						</div>
						<strong class:negative={security.differenceCents < 0}
							>{signedMoney(security.differenceCents)}<small
								>vs. {scheduleLabel.toLowerCase()}</small
							></strong
						>
					</div>
				{/each}
			</div>
			<details>
				<summary>Method and purchase coverage</summary>
				<p>
					Each security keeps the same total purchase amount in both scenarios. The schedule spreads
					that amount equally across the first trading day in each month, week, or alternating
					two-week interval. Weeks begin on Monday. A partial first interval starts on the first
					market day in the comparison window.
				</p>
				<p>
					Both scenarios start with the full budget available, allow fractional shares, and use
					dividend- and split-adjusted closing-price ratios. Uninvested cash earns no interest.
					Fees, taxes, later sales, and intraday execution prices are excluded. These are
					hypothetical purchase-and-hold values, not actual account profit or proof of timing skill.
				</p>
				<p>
					Only available synced purchases are covered; provider history can be incomplete. Dividends
					reinvested automatically, cash sweeps, unsupported securities, and non-USD purchases are
					excluded. Recorded order dates are used when available; otherwise the posting date is used
					and counted above.
				</p>
				{#if coverage?.activitySyncedAt}<p>
						Purchase activity last synced {new Intl.DateTimeFormat('en-US', {
							dateStyle: 'medium',
							timeStyle: 'short',
							timeZone: 'America/Los_Angeles'
						}).format(new Date(coverage.activitySyncedAt))} Pacific time.
					</p>{/if}
				{#if coverage?.capped}<p>
						The saved activity reached the retrieval limit. This is a partial-history comparison.
					</p>{/if}
				{#if coverage && coverage.exclusions.length > 0}<ul>
						{#each coverage.exclusions as exclusion (exclusion.reason)}<li>
								{exclusion.reason}: {exclusion.count}{exclusion.amountCents > 0
									? ` · ${money(exclusion.amountCents)} in known USD purchase principal`
									: ''}
							</li>{/each}
					</ul>{/if}
				<p>Scheduled dates: {available.scheduleDates.map((day) => date(day)).join(' · ')}</p>
				<p>
					Public adjusted prices come from Yahoo Finance. <a
						href="https://www.investor.gov/introduction-investing/investing-basics/glossary/dollar-cost-averaging"
						target="_blank"
						rel="noreferrer">About regular equal-dollar investing</a
					>.
				</p>
			</details>
		{:else if response}
			<div class="empty" role="status">
				<p>
					{response.comparison.status === 'unavailable'
						? response.comparison.message
						: 'No comparison is available for this period.'}
				</p>
				{#if coverage && coverage.exclusions.length > 0}<ul>
						{#each coverage.exclusions as exclusion (exclusion.reason)}<li>
								{exclusion.reason}: {exclusion.count}
							</li>{/each}
					</ul>{/if}
				<button class="retry" type="button" onclick={() => retry++}>Refresh comparison</button>
			</div>
		{/if}
	</section>
{/if}

<style>
	.timing {
		margin: 1.5rem 0 0;
		padding: 1.5rem;
		border: 1px solid var(--line);
		border-radius: 18px;
		background: white;
	}
	.heading,
	.controls,
	.chart-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.heading {
		align-items: flex-start;
		margin-bottom: 1.3rem;
	}
	.eyebrow {
		margin: 0 0 0.35rem;
		color: var(--accent);
		font-size: 0.65rem;
		font-weight: 780;
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}
	h2 {
		margin: 0;
		font-size: 1.3rem;
		letter-spacing: -0.025em;
	}
	.subtitle {
		margin: 0.45rem 0 0;
		font-size: 0.78rem;
		color: var(--muted);
	}
	.badge {
		padding: 0.35rem 0.65rem;
		border-radius: 20px;
		background: #f2f4f8;
		color: var(--muted);
		white-space: nowrap;
		font-size: 0.65rem;
	}
	.controls {
		align-items: flex-end;
		flex-wrap: wrap;
		margin-bottom: 1.4rem;
	}
	label {
		display: grid;
		gap: 0.4rem;
		font-size: 0.65rem;
		color: var(--muted);
	}
	select {
		min-width: 170px;
		max-width: 100%;
		padding: 0.6rem 2rem 0.6rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: white;
		font: inherit;
		font-size: 0.8rem;
		color: var(--ink);
	}
	.ranges {
		display: flex;
		gap: 0.25rem;
		padding: 0.2rem;
		border-radius: 9px;
		background: #f2f4f8;
	}
	button {
		cursor: pointer;
	}
	.ranges button {
		border: 0;
		padding: 0.5rem 0.7rem;
		background: transparent;
		border-radius: 7px;
		color: var(--muted);
		font-size: 0.7rem;
		font-weight: 700;
	}
	.ranges button[aria-pressed='true'] {
		background: white;
		color: var(--accent);
		box-shadow: 0 1px 4px #11182712;
	}
	.metrics {
		display: grid;
		grid-template-columns: 1.2fr 1fr 1fr;
		gap: 1rem;
		padding: 1.1rem 0;
		border-top: 1px solid var(--line);
	}
	.metrics > div {
		display: grid;
		gap: 0.3rem;
	}
	.metrics span {
		font-size: 0.72rem;
		color: var(--muted);
	}
	.metrics strong {
		font-size: 1.65rem;
		letter-spacing: -0.04em;
		font-variant-numeric: tabular-nums;
	}
	.metrics .impact strong {
		color: #167554;
	}
	.metrics .scheduled strong {
		color: #a36616;
	}
	.metrics strong.negative,
	.security-result strong.negative {
		color: #b4424d;
	}
	.metrics strong.neutral {
		color: var(--ink);
	}
	.metrics small,
	.security-result small {
		font-size: 0.62rem;
		color: var(--muted);
		line-height: 1.5;
	}
	.budget {
		margin: 0 0 0.65rem;
		font-size: 0.72rem;
		color: var(--muted);
		line-height: 1.7;
	}
	.budget strong {
		color: var(--ink);
	}
	.assumption,
	.notice {
		padding: 0.7rem 0.85rem;
		border-radius: 8px;
		font-size: 0.7rem;
		line-height: 1.6;
	}
	.assumption {
		margin: 0 0 1rem;
		background: #f6f8fc;
		color: var(--muted);
	}
	.notice {
		margin: 0.65rem 0;
		background: #fffaed;
		color: #775820;
	}
	.chart-heading {
		flex-wrap: wrap;
		margin-top: 1.2rem;
		color: var(--muted);
		font-size: 0.65rem;
	}
	.legend,
	.legend span {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.legend {
		gap: 1rem;
	}
	.legend i {
		width: 16px;
		height: 3px;
		border-radius: 3px;
		background: var(--accent);
	}
	.legend .scheduled-line {
		background: #bd8429;
	}
	.chart {
		display: block;
		width: 100%;
		margin-top: 0.4rem;
		overflow: visible;
	}
	.chart text {
		fill: var(--muted);
		font-size: 11px;
	}
	.grid {
		stroke: #e9edf2;
		stroke-width: 1;
	}
	.zero {
		stroke: #cbd2df;
		stroke-dasharray: 3 5;
	}
	.line {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2.5;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.scheduled-stroke {
		stroke: #bd8429;
		stroke-dasharray: 6 4;
	}
	.cursor {
		stroke: #bac3d1;
		stroke-dasharray: 3 4;
	}
	.buy-dot {
		fill: var(--accent);
		stroke: white;
		stroke-width: 1.5;
	}
	.chart-note {
		margin: 0.2rem 0 0.7rem;
		text-align: center;
		color: var(--muted);
		font-size: 0.65rem;
		line-height: 1.6;
	}
	.point-detail {
		display: flex;
		justify-content: center;
		flex-wrap: wrap;
		gap: 0.5rem 1.2rem;
		font-size: 0.68rem;
		color: var(--muted);
	}
	.point-detail b {
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.scrubber {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.7rem;
		margin: 0.65rem 0;
	}
	.scrubber input {
		max-width: 250px;
		width: 50%;
		accent-color: var(--accent);
	}
	.security-results {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.7rem;
		margin: 1.2rem 0;
	}
	.security-result {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		border: 1px solid var(--line);
		border-radius: 9px;
		padding: 0.75rem 0.85rem;
	}
	.security-result > div,
	.security-result > strong {
		display: grid;
		gap: 0.3rem;
	}
	.security-result strong {
		font-size: 0.85rem;
	}
	.security-result > strong {
		text-align: right;
		color: #167554;
		font-variant-numeric: tabular-nums;
	}
	.security-result span {
		font-size: 0.62rem;
		color: var(--muted);
	}
	details {
		font-size: 0.68rem;
		color: var(--muted);
		line-height: 1.7;
	}
	summary {
		cursor: pointer;
	}
	details p {
		max-width: 100ch;
	}
	.empty {
		padding: 2rem 1rem;
		margin: 0;
		text-align: center;
		font-size: 0.8rem;
		color: var(--muted);
		line-height: 1.7;
		background: #f8f9fc;
		border-radius: 10px;
	}
	.empty p {
		margin: 0;
	}
	.empty ul {
		display: inline-block;
		text-align: left;
		font-size: 0.7rem;
	}
	.retry {
		margin-top: 0.7rem;
		padding: 0.45rem 0.8rem;
		border: 1px solid var(--line);
		background: white;
		border-radius: 7px;
		color: var(--accent);
	}
	@media (max-width: 600px) {
		.timing {
			padding: 1rem;
		}
		.heading {
			flex-wrap: wrap;
			gap: 0.6rem;
		}
		h2 {
			font-size: 1.15rem;
		}
		.controls {
			align-items: stretch;
			flex-direction: column;
		}
		.ranges {
			align-self: flex-start;
		}
		.metrics {
			grid-template-columns: 1fr 1fr;
			gap: 1rem 0.65rem;
		}
		.metrics .impact {
			grid-column: 1 / -1;
		}
		.metrics strong {
			font-size: 1.35rem;
		}
		.metrics .impact strong {
			font-size: 1.8rem;
		}
		.chart {
			min-height: 175px;
		}
		.chart text {
			font-size: 23px;
		}
		.line {
			stroke-width: 4;
		}
		.buy-dot {
			r: 5px;
		}
		.security-results {
			grid-template-columns: 1fr;
		}
	}
</style>
