<script lang="ts">
	import { resolve } from '$app/paths';
	import { SvelteDate } from 'svelte/reactivity';
	import {
		buildInvestmentComparison,
		type BenchmarkPrice,
		type BenchmarkRange
	} from '$lib/investment-benchmark';
	import type { FinancialAccount } from '$lib/types';

	let { accounts }: { accounts: FinancialAccount[] } = $props();
	let selectedId = $state('');
	let range = $state<BenchmarkRange>('1Y');
	let prices = $state<BenchmarkPrice[]>([]);
	let loading = $state(false);
	let error = $state('');
	let retry = $state(0);
	let selectedPoint = $state<number | null>(null);
	const ranges: BenchmarkRange[] = ['1M', '3M', 'YTD', '1Y', 'ALL'];
	const width = 900;
	const height = 265;
	const left = 55;
	const right = 18;
	const top = 20;
	const bottom = 34;
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
	const eligible = $derived(
		accounts.filter(
			(account) =>
				account.accountType === 'brokerage' && account.status === 'active' && !account.hidden
		)
	);
	const selected = $derived(eligible.find((account) => account.id === selectedId) ?? eligible[0]);
	const requestDates = $derived.by(() => {
		const days = eligible
			.flatMap((account) => account.balanceHistory.map((point) => point.recordedAt.slice(0, 10)))
			.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
			.sort();
		if (days.length < 2) return null;
		const today = new Date();
		const end =
			days.at(-1)! < today.toISOString().slice(0, 10)
				? days.at(-1)!
				: today.toISOString().slice(0, 10);
		const earliest = new SvelteDate(`${end}T12:00:00Z`);
		earliest.setUTCFullYear(earliest.getUTCFullYear() - 10);
		// An evening observation in Pacific time can have tomorrow's UTC date.
		const bufferedStart = new Date(Date.parse(`${days[0]}T12:00:00Z`) - 86_400_000)
			.toISOString()
			.slice(0, 10);
		const start =
			bufferedStart > earliest.toISOString().slice(0, 10)
				? bufferedStart
				: earliest.toISOString().slice(0, 10);
		return { start, end };
	});
	const requestKey = $derived(requestDates ? `${requestDates.start}/${requestDates.end}` : '');
	const request = $derived({ key: requestKey, retry });

	$effect(() => {
		const key = request.key;
		if (!key) {
			loading = false;
			error = '';
			prices = [];
			return;
		}
		const controller = new AbortController();
		const [start, end] = key.split('/');
		loading = true;
		error = '';
		prices = [];
		void fetch(`${resolve('/api/investments/benchmark')}?start=${start}&end=${end}`, {
			signal: controller.signal
		})
			.then(async (response) => {
				if (!response.ok) throw new Error('Benchmark unavailable');
				const data = (await response.json()) as { prices: BenchmarkPrice[] };
				if (!controller.signal.aborted) prices = data.prices;
			})
			.catch(() => {
				if (!controller.signal.aborted)
					error = 'SPY prices are temporarily unavailable. Your account data is unchanged.';
			})
			.finally(() => {
				if (!controller.signal.aborted) loading = false;
			});
		return () => controller.abort();
	});

	const comparison = $derived(
		selected
			? buildInvestmentComparison(selected.balanceHistory, prices, range, selected.currency)
			: null
	);
	const available = $derived(comparison?.status === 'available' ? comparison : null);
	const chart = $derived.by(() => {
		if (!available) return null;
		const values = available.points.flatMap((point) => [
			point.accountReturnPercent,
			point.benchmarkReturnPercent
		]);
		const minValue = Math.min(0, ...values);
		const maxValue = Math.max(0, ...values);
		const pad = Math.max((maxValue - minValue) * 0.15, 1);
		const min = minValue - pad;
		const max = maxValue + pad;
		const first = Date.parse(available.startDate);
		const last = Date.parse(available.endDate);
		const y = (value: number) => top + ((max - value) / (max - min)) * (height - top - bottom);
		const points = available.points.map((point) => ({
			...point,
			x: left + ((Date.parse(point.date) - first) / (last - first)) * (width - left - right),
			y: y(point.accountReturnPercent),
			spyY: y(point.benchmarkReturnPercent)
		}));
		return {
			points,
			accountPath: points
				.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`)
				.join(' '),
			spyPath: points
				.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.spyY}`)
				.join(' '),
			ticks: [max, (max + min) / 2, min].map((value) => ({ value, y: y(value) })),
			zeroY: y(0)
		};
	});
	const focusedPoint = $derived(
		chart?.points[Math.min(selectedPoint ?? chart.points.length - 1, chart.points.length - 1)]
	);
	const unavailableMessage = $derived.by(() => {
		if (comparison?.status !== 'unavailable') return '';
		switch (comparison.reason) {
			case 'unsupported_currency':
				return 'SPY is quoted in USD. A currency-adjusted comparison is not available for this account.';
			case 'missing_contributions':
				return 'A fair comparison needs contribution history to separate deposits and withdrawals from investment gains. Connected history is calculated automatically when available.';
			case 'nonpositive_balance':
				return 'A comparison needs a positive starting balance and a continuous funded period.';
			case 'invalid_values':
				return 'Some history values cannot support a reliable comparison.';
			case 'market_data_unavailable':
				return 'No matching SPY closing prices are available for this account’s recorded dates.';
			default:
				return 'At least two matching market days of balances and contribution history are needed. Connected accounts build estimated history automatically when available.';
		}
	});
	function percent(value: number): string {
		return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
	}
	function money(cents: number): string {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: 'USD',
			maximumFractionDigits: 0
		}).format(cents / 100);
	}
	function date(day: string, short = false): string {
		return (short ? shortDateFormat : dateFormat).format(new Date(`${day}T20:00:00Z`));
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
	<section class="benchmark" aria-labelledby="investment-benchmark-title">
		<div class="heading">
			<div>
				<p class="eyebrow">Investment performance</p>
				<h2 id="investment-benchmark-title">Your investments vs. S&amp;P 500</h2>
				<p class="subtitle">Compare investment returns with SPY over the same dates.</p>
			</div>
			<span class="estimate-label">Estimated returns</span>
		</div>
		<div class="controls">
			<label
				>Investment account
				<select
					value={selected?.id}
					onchange={(event) => {
						selectedId = event.currentTarget.value;
						selectedPoint = null;
					}}
				>
					{#each eligible as account (account.id)}
						<option value={account.id}
							>{account.nickname}{account.last4 ? ` · ${account.last4}` : ''}</option
						>
					{/each}
				</select>
			</label>
			<div class="ranges" aria-label="Investment comparison range">
				{#each ranges as value (value)}
					<button
						type="button"
						aria-pressed={range === value}
						onclick={() => {
							range = value;
							selectedPoint = null;
						}}>{value === 'ALL' ? 'All' : value}</button
					>
				{/each}
			</div>
		</div>
		{#if loading}
			<p class="empty" role="status">Loading S&amp;P 500 benchmark…</p>
		{:else if error}
			<div class="empty" role="status">
				<p>{error}</p>
				<button class="retry" type="button" onclick={() => retry++}>Try again</button>
			</div>
		{:else if available && chart}
			<div class="metrics">
				<div>
					<span>Your return</span><strong
						class:negative={available.summary.accountReturnPercent < 0}
						>{percent(available.summary.accountReturnPercent)}</strong
					><small>Adjusted for cash flows</small>
				</div>
				<div class="spy">
					<span>S&amp;P 500 (SPY)</span><strong
						>{percent(available.summary.benchmarkReturnPercent)}</strong
					><small>Dividends reinvested</small>
				</div>
				<div>
					<span
						>{available.summary.excessPercentagePoints >= 0 ? 'Ahead of SPY' : 'Behind SPY'}</span
					><strong class:negative={available.summary.excessPercentagePoints < 0}
						>{Math.abs(available.summary.excessPercentagePoints).toFixed(2)}<em> pp</em></strong
					><small>Percentage point difference</small>
				</div>
			</div>
			<div class="chart-header">
				<div class="legend">
					<span><i></i>Your account</span><span><i class="spy-line"></i>S&amp;P 500 (SPY)</span>
				</div>
				<span>{date(available.startDate)} – {date(available.endDate)}</span>
			</div>
			<svg
				class="chart"
				viewBox={`0 0 ${width} ${height}`}
				role="img"
				aria-label={`${selected?.nickname} estimated return ${percent(available.summary.accountReturnPercent)}, compared with SPY ${percent(available.summary.benchmarkReturnPercent)}, from ${date(available.startDate)} to ${date(available.endDate)}`}
				onpointermove={pointAtPointer}
				onpointerleave={() => (selectedPoint = null)}
			>
				{#each chart.ticks as tick (tick.y)}
					<line x1={left} x2={width - right} y1={tick.y} y2={tick.y} class="grid" />
					<text x={left - 10} y={tick.y + 4} text-anchor="end">{tick.value.toFixed(1)}%</text>
				{/each}
				<line x1={left} x2={width - right} y1={chart.zeroY} y2={chart.zeroY} class="zero" />
				<path d={chart.spyPath} class="line spy-stroke" />
				<path d={chart.accountPath} class="line" />
				{#if focusedPoint}
					<line
						x1={focusedPoint.x}
						x2={focusedPoint.x}
						y1={top}
						y2={height - bottom}
						class="cursor"
					/>
					<circle cx={focusedPoint.x} cy={focusedPoint.spyY} r="4" class="spy-dot" />
					<circle cx={focusedPoint.x} cy={focusedPoint.y} r="4" class="account-dot" />
				{/if}
				<text x={left} y={height - 8}>{date(available.startDate, true)}</text>
				<text x={width - right} y={height - 8} text-anchor="end"
					>{date(available.endDate, true)}</text
				>
			</svg>
			{#if focusedPoint}
				<div class="point-detail" aria-live="off">
					<span>{date(focusedPoint.date)}</span><span
						>Your account <b>{percent(focusedPoint.accountReturnPercent)}</b></span
					><span>SPY <b>{percent(focusedPoint.benchmarkReturnPercent)}</b></span>
				</div>
				<label class="scrubber"
					>Explore a date
					<input
						type="range"
						min="0"
						max={chart.points.length - 1}
						value={selectedPoint ?? chart.points.length - 1}
						oninput={(event) => (selectedPoint = Number(event.currentTarget.value))}
						aria-valuetext={`${date(focusedPoint.date)}: account ${percent(focusedPoint.accountReturnPercent)}, SPY ${percent(focusedPoint.benchmarkReturnPercent)}`}
					/>
				</label>
			{/if}
			{#if available.summary.benchmarkValueCents !== null && available.summary.differenceCents !== null}
				<p class="dollar-comparison">
					With the same starting balance and recorded cash flows, SPY would be worth <strong
						>{money(available.summary.benchmarkValueCents)}</strong
					>. Your account is
					<strong
						>{money(Math.abs(available.summary.differenceCents))}
						{available.summary.differenceCents >= 0 ? 'ahead' : 'behind'}</strong
					>.
				</p>
			{/if}
			{#if available.trimmedHistory}<p class="coverage-note">
					Showing the available continuous history within this range. Dates without contribution
					data or matching market closes are excluded.
				</p>{/if}
			<details>
				<summary>How this comparison works</summary>
				<p>
					Estimated time-weighted returns remove recorded net deposits and withdrawals before
					calculating each interval’s growth. Cash flows are treated as arriving at the end of each
					interval; sparse snapshots and missing provider activity can affect accuracy. Both lines
					start at 0% on the first displayed date.
				</p>
				<p>
					{available.estimatedHistory
						? 'This account includes reconstructed balance history; it is not broker-reported performance. Unpriced positions and incomplete transactions can affect the estimate.'
						: 'This account uses saved balance snapshots; their timing may differ from market closes.'}
					SPY uses dividend-adjusted closing prices from Yahoo Finance as a proxy for the S&amp;P 500.
					Returns are cumulative, not annualized.
				</p>
			</details>
		{:else}
			<p class="empty" role="status">{unavailableMessage}</p>
		{/if}
	</section>
{/if}

<style>
	.benchmark {
		margin: 0 0 1.5rem;
		padding: 1.5rem;
		border: 1px solid var(--line);
		border-radius: 18px;
		background: white;
	}
	.heading,
	.controls,
	.chart-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.heading {
		align-items: flex-start;
		margin-bottom: 1.35rem;
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
	.estimate-label {
		padding: 0.35rem 0.65rem;
		border-radius: 20px;
		background: #f2f4f8;
		color: var(--muted);
		white-space: nowrap;
		font-size: 0.65rem;
	}
	.controls {
		margin-bottom: 1.4rem;
	}
	label {
		display: grid;
		gap: 0.4rem;
		font-size: 0.65rem;
		color: var(--muted);
	}
	select {
		min-width: 220px;
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
		grid-template-columns: repeat(3, 1fr);
		gap: 1rem;
		padding: 1.1rem 0 1.25rem;
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
		color: #167554;
		font-size: 1.8rem;
		letter-spacing: -0.045em;
		font-variant-numeric: tabular-nums;
	}
	.metrics .spy strong {
		color: #a36616;
	}
	.metrics strong.negative {
		color: #b4424d;
	}
	.metrics small {
		font-size: 0.62rem;
		color: var(--muted);
	}
	em {
		font-size: 1rem;
		font-style: normal;
	}
	.chart-header {
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
	.legend .spy-line {
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
	.spy-stroke {
		stroke: #bd8429;
		stroke-dasharray: 6 4;
	}
	.cursor {
		stroke: #bac3d1;
		stroke-dasharray: 3 4;
	}
	.account-dot {
		fill: var(--accent);
		stroke: white;
		stroke-width: 2;
	}
	.spy-dot {
		fill: #bd8429;
		stroke: white;
		stroke-width: 2;
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
	.dollar-comparison {
		background: #f7f9fc;
		padding: 0.9rem 1rem;
		border-radius: 10px;
		font-size: 0.75rem;
		color: var(--muted);
		line-height: 1.6;
		margin: 1rem 0 0.8rem;
	}
	.dollar-comparison strong {
		color: var(--ink);
	}
	.coverage-note {
		color: var(--muted);
		font-size: 0.68rem;
		line-height: 1.6;
	}
	details {
		color: var(--muted);
		font-size: 0.68rem;
		line-height: 1.7;
	}
	summary {
		cursor: pointer;
	}
	details p {
		max-width: 95ch;
	}
	.empty {
		padding: 2.5rem 1rem;
		margin: 0;
		text-align: center;
		font-size: 0.8rem;
		color: var(--muted);
		line-height: 1.7;
		background: #f8f9fc;
		border-radius: 10px;
	}
	.retry {
		padding: 0.45rem 0.8rem;
		border: 1px solid var(--line);
		background: white;
		border-radius: 7px;
		color: var(--accent);
	}
	@media (max-width: 600px) {
		.benchmark {
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
			gap: 0.6rem;
		}
		.metrics strong {
			font-size: 1.35rem;
		}
		.metrics span {
			font-size: 0.65rem;
		}
		.metrics small {
			line-height: 1.4;
		}
		.chart-header {
			flex-wrap: wrap;
			gap: 0.7rem;
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
	}
</style>
