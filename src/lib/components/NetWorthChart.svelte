<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		buildNetWorthHistory,
		type NetWorthAccount,
		type NetWorthAccountBreakdown,
		type NetWorthHistoryPoint
	} from '$lib/net-worth';

	type HistoryRange = '1M' | '3M' | '1Y' | 'ALL';
	type ChartPoint = NetWorthHistoryPoint & {
		x: number;
		y: number;
	};

	let {
		accounts,
		cardBalanceCents,
		loading
	}: {
		accounts: NetWorthAccount[];
		cardBalanceCents: number;
		loading: boolean;
	} = $props();

	const WIDTH = 960;
	const HEIGHT = 270;
	const PLOT_LEFT = 72;
	const PLOT_RIGHT = 22;
	const PLOT_TOP = 22;
	const PLOT_BOTTOM = 38;
	const ranges: Array<{ id: HistoryRange; label: string }> = [
		{ id: '1M', label: '1M' },
		{ id: '3M', label: '3M' },
		{ id: '1Y', label: '1Y' },
		{ id: 'ALL', label: 'All' }
	];
	const money = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: 0
	});
	const detailedMoney = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	});
	const compactMoney = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		notation: 'compact',
		maximumFractionDigits: 1
	});
	const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
	const fullDateLabel = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});

	let selectedRange = $state<HistoryRange>('1Y');
	let hoveredIndex = $state<number | null>(null);
	let selectedRecordedAt = $state<string | null>(null);
	const history = $derived(buildNetWorthHistory(accounts, cardBalanceCents));
	const visibleHistory = $derived(pointsForRange(history.points, selectedRange));
	const chart = $derived(chartFor(visibleHistory));
	const firstPoint = $derived(visibleHistory[0]);
	const latestPoint = $derived(visibleHistory.at(-1));
	const changeCents = $derived(
		firstPoint && latestPoint ? latestPoint.netWorthCents - firstPoint.netWorthCents : null
	);
	const changePercent = $derived(
		changeCents !== null && firstPoint?.netWorthCents
			? (changeCents / Math.abs(firstPoint.netWorthCents)) * 100
			: null
	);
	const hoveredPoint = $derived(
		hoveredIndex === null ? null : (chart.points[hoveredIndex] ?? null)
	);
	const selectedPoint = $derived(
		selectedRecordedAt === null
			? null
			: (history.points.find((point) => point.recordedAt === selectedRecordedAt) ?? null)
	);
	const selectedBreakdown = $derived(
		selectedPoint === null ? [] : sortBreakdown(selectedPoint.accounts)
	);

	function pointsForRange(
		points: typeof history.points,
		range: HistoryRange
	): typeof history.points {
		if (range === 'ALL' || points.length < 2) return points;
		const latest = new Date(points.at(-1)!.recordedAt).getTime();
		const days = range === '1M' ? 30 : range === '3M' ? 90 : 365;
		const cutoff = latest - days * 24 * 60 * 60 * 1_000;
		const filtered = points.filter((point) => new Date(point.recordedAt).getTime() >= cutoff);
		return filtered.length > 0 ? filtered : points.slice(-1);
	}

	function samplePoints(points: typeof history.points): typeof history.points {
		if (points.length <= 260) return points;
		const sampled = [points[0]];
		const step = (points.length - 1) / 259;
		for (let index = 1; index < 259; index += 1) {
			sampled.push(points[Math.round(index * step)]);
		}
		sampled.push(points.at(-1)!);
		return sampled.filter(
			(point, index, allPoints) =>
				index === 0 || point.recordedAt !== allPoints[index - 1].recordedAt
		);
	}

	function chartFor(points: typeof history.points): {
		points: ChartPoint[];
		linePath: string;
		areaPath: string;
		ticks: Array<{ value: number; y: number }>;
	} {
		const sampled = samplePoints(points);
		if (sampled.length === 0) return { points: [], linePath: '', areaPath: '', ticks: [] };
		const values = sampled.map((point) => point.netWorthCents);
		const rawMin = Math.min(...values);
		const rawMax = Math.max(...values);
		const valueRange = rawMax - rawMin;
		const padding = Math.max(valueRange * 0.14, Math.max(Math.abs(rawMax), 1) * 0.018, 100);
		const min = rawMin - padding;
		const max = rawMax + padding;
		const firstTime = new Date(sampled[0].recordedAt).getTime();
		const lastTime = new Date(sampled.at(-1)!.recordedAt).getTime();
		const timeRange = lastTime - firstTime;
		const plotWidth = WIDTH - PLOT_LEFT - PLOT_RIGHT;
		const plotHeight = HEIGHT - PLOT_TOP - PLOT_BOTTOM;
		const scaled = sampled.map<ChartPoint>((point) => {
			const time = new Date(point.recordedAt).getTime();
			return {
				...point,
				x:
					sampled.length === 1 || timeRange === 0
						? PLOT_LEFT + plotWidth / 2
						: PLOT_LEFT + ((time - firstTime) / timeRange) * plotWidth,
				y: PLOT_TOP + ((max - point.netWorthCents) / (max - min)) * plotHeight
			};
		});
		const linePath = scaled
			.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
			.join(' ');
		const floor = HEIGHT - PLOT_BOTTOM;
		const areaPath =
			scaled.length > 1
				? `${linePath} L ${scaled.at(-1)!.x} ${floor} L ${scaled[0].x} ${floor} Z`
				: '';
		const ticks = [max, (max + min) / 2, min].map((value) => ({
			value,
			y: PLOT_TOP + ((max - value) / (max - min)) * plotHeight
		}));
		return { points: scaled, linePath, areaPath, ticks };
	}

	function formatMoney(value: number | null): string {
		return value === null ? 'Not available' : money.format(value / 100);
	}

	function formatCompactMoney(value: number): string {
		return compactMoney.format(value / 100);
	}

	function formatDetailedMoney(value: number): string {
		return detailedMoney.format(value / 100);
	}

	function formatSignedMoney(value: number | null): string {
		if (value === null) return '—';
		return `${value >= 0 ? '+' : '−'}${formatDetailedMoney(Math.abs(value))}`;
	}

	function formatCardDeduction(value: number): string {
		return value === 0 ? formatDetailedMoney(value) : `−${formatDetailedMoney(value)}`;
	}

	function formatDate(value: string, full = false): string {
		return (full ? fullDateLabel : dateLabel).format(new Date(value));
	}

	function accountTypeLabel(value: NetWorthAccountBreakdown['accountType']): string {
		return value === 'cash_management'
			? 'Cash management'
			: `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
	}

	function sourceLabel(account: NetWorthAccountBreakdown): string {
		if (account.backfilled) return 'Earliest known';
		return account.estimated ? 'Estimated' : 'Observed';
	}

	function sortBreakdown(accountsForDate: NetWorthAccountBreakdown[]): NetWorthAccountBreakdown[] {
		return accountsForDate.slice().sort((left, right) => {
			const changeDifference = Math.abs(right.changeCents ?? 0) - Math.abs(left.changeCents ?? 0);
			return changeDifference || right.balanceCents - left.balanceCents;
		});
	}

	function nearestPointIndex(clientX: number, target: SVGSVGElement): number {
		const bounds = target.getBoundingClientRect();
		const x = ((clientX - bounds.left) / bounds.width) * WIDTH;
		let nearest = 0;
		for (let index = 1; index < chart.points.length; index += 1) {
			if (Math.abs(chart.points[index].x - x) < Math.abs(chart.points[nearest].x - x)) {
				nearest = index;
			}
		}
		return nearest;
	}

	function handlePointerMove(event: PointerEvent): void {
		if (chart.points.length === 0) return;
		hoveredIndex = nearestPointIndex(event.clientX, event.currentTarget as SVGSVGElement);
	}

	function selectPoint(index: number): void {
		const point = chart.points[index];
		if (!point) return;
		selectedRecordedAt = point.recordedAt;
		hoveredIndex = index;
	}

	function handleChartClick(event: MouseEvent): void {
		if (chart.points.length === 0) return;
		selectPoint(nearestPointIndex(event.clientX, event.currentTarget as SVGSVGElement));
	}

	function handleChartKeydown(event: KeyboardEvent): void {
		if (
			!['ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key) ||
			chart.points.length === 0
		) {
			return;
		}
		event.preventDefault();
		let index = selectedRecordedAt
			? chart.points.findIndex((point) => point.recordedAt === selectedRecordedAt)
			: chart.points.length - 1;
		if (index < 0) index = chart.points.length - 1;
		if (event.key === 'ArrowLeft') index = Math.max(0, index - 1);
		if (event.key === 'ArrowRight') index = Math.min(chart.points.length - 1, index + 1);
		selectPoint(index);
	}
</script>

<section class="net-worth-panel" aria-labelledby="net-worth-title">
	<header class="net-worth-heading">
		<div>
			<p>Tracked net worth</p>
			<h2 id="net-worth-title">Net worth over time</h2>
		</div>
		{#if history.includesEstimates}
			<span class="estimate-badge">Includes estimates</span>
		{/if}
	</header>

	{#if loading}
		<div class="net-worth-loading" aria-label="Loading net worth history" aria-busy="true">
			<span></span><span></span><span></span>
		</div>
	{:else if history.currentNetWorthCents === null}
		<div class="net-worth-empty">
			<svg viewBox="0 0 48 36" aria-hidden="true">
				<path d="M4 30 14 20l8 4 9-15 13 8"></path>
				<path d="M4 32h40"></path>
			</svg>
			<div>
				<strong>Add an account balance to start</strong>
				<p>Net worth history builds automatically as balances update.</p>
			</div>
			<a href={resolve('/accounts')}>Open Accounts</a>
		</div>
	{:else}
		<div class="net-worth-metrics">
			<div>
				<span>Current net worth</span>
				<strong>{formatMoney(history.currentNetWorthCents)}</strong>
			</div>
			<div class:negative={changeCents !== null && changeCents < 0}>
				<span>{selectedRange === 'ALL' ? 'All-time change' : `${selectedRange} change`}</span>
				<strong>
					{changeCents === null ? '—' : `${changeCents >= 0 ? '+' : ''}${formatMoney(changeCents)}`}
				</strong>
				{#if changePercent !== null}
					<small>{changePercent >= 0 ? '+' : ''}{changePercent.toFixed(1)}%</small>
				{/if}
			</div>
			<div>
				<span>Included</span>
				<strong>{history.accountCount} {history.accountCount === 1 ? 'account' : 'accounts'}</strong
				>
				<small>Minus {formatMoney(history.cardBalanceCents)} in card balances</small>
			</div>
		</div>

		<div class="chart-toolbar">
			<p id="net-worth-chart-help">
				Active, visible USD account balances minus current credit-card balances. Click a date for
				details.
			</p>
			<div class="range-controls" aria-label="Net worth history range">
				{#each ranges as range (range.id)}
					<button
						type="button"
						aria-pressed={selectedRange === range.id}
						onclick={() => {
							selectedRange = range.id;
							hoveredIndex = null;
							selectedRecordedAt = null;
						}}
					>
						{range.label}
					</button>
				{/each}
			</div>
		</div>

		<div class="chart-wrap">
			<svg
				class="net-worth-chart"
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				role="button"
				tabindex="0"
				aria-describedby="net-worth-chart-help"
				aria-label={firstPoint && latestPoint
					? `Select a net worth date from ${formatDate(firstPoint.recordedAt, true)} to ${formatDate(latestPoint.recordedAt, true)}`
					: 'Current net worth'}
				onpointermove={handlePointerMove}
				onpointerleave={() => (hoveredIndex = null)}
				onclick={handleChartClick}
				onkeydown={handleChartKeydown}
			>
				<defs>
					<linearGradient id="net-worth-fill" x1="0" x2="0" y1="0" y2="1">
						<stop offset="0%" stop-color="var(--accent)" stop-opacity="0.24"></stop>
						<stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02"></stop>
					</linearGradient>
				</defs>
				{#each chart.ticks as tick (tick.y)}
					<line x1={PLOT_LEFT} x2={WIDTH - PLOT_RIGHT} y1={tick.y} y2={tick.y} class="grid-line"
					></line>
					<text x={PLOT_LEFT - 10} y={tick.y + 4} text-anchor="end">
						{formatCompactMoney(tick.value)}
					</text>
				{/each}
				{#if chart.areaPath}
					<path d={chart.areaPath} fill="url(#net-worth-fill)"></path>
				{/if}
				{#if chart.points.length === 1}
					<line
						x1={PLOT_LEFT}
						x2={WIDTH - PLOT_RIGHT}
						y1={chart.points[0].y}
						y2={chart.points[0].y}
						class="value-line"
					></line>
				{:else}
					<path d={chart.linePath} class="value-line"></path>
				{/if}
				{#each chart.points as point, index (point.recordedAt)}
					{#if index === chart.points.length - 1 || index === hoveredIndex || point.recordedAt === selectedRecordedAt}
						<circle
							cx={point.x}
							cy={point.y}
							r={index === hoveredIndex || point.recordedAt === selectedRecordedAt ? 6 : 4.5}
							class:selected={point.recordedAt === selectedRecordedAt}
							class="value-dot"
						></circle>
					{/if}
				{/each}
				{#if firstPoint && latestPoint}
					<text x={PLOT_LEFT} y={HEIGHT - 11}>{formatDate(firstPoint.recordedAt)}</text>
					<text x={WIDTH - PLOT_RIGHT} y={HEIGHT - 11} text-anchor="end">
						{formatDate(latestPoint.recordedAt)}
					</text>
				{/if}
			</svg>

			{#if hoveredPoint}
				<div
					class="chart-tooltip"
					style={`left: ${(hoveredPoint.x / WIDTH) * 100}%; top: ${(hoveredPoint.y / HEIGHT) * 100}%`}
				>
					<span>{formatDate(hoveredPoint.recordedAt, true)}</span>
					<strong>{formatMoney(hoveredPoint.netWorthCents)}</strong>
					{#if hoveredPoint.estimated}<small>Includes estimated values</small>{/if}
				</div>
			{/if}
		</div>

		{#if selectedPoint}
			<section class="date-breakdown" aria-labelledby="date-breakdown-title" aria-live="polite">
				<header>
					<div>
						<p>Selected date</p>
						<h3 id="date-breakdown-title">{formatDate(selectedPoint.recordedAt, true)}</h3>
					</div>
					<div
						class:negative={selectedPoint.changeCents !== null && selectedPoint.changeCents < 0}
						class="selected-total"
					>
						<span>Net worth</span>
						<strong>{formatDetailedMoney(selectedPoint.netWorthCents)}</strong>
						<small>{formatSignedMoney(selectedPoint.changeCents)} from previous date</small>
					</div>
					<button
						type="button"
						aria-label="Close date breakdown"
						onclick={() => (selectedRecordedAt = null)}>×</button
					>
				</header>

				<div class="breakdown-summary">
					<div>
						<span>Account assets</span>
						<strong>{formatDetailedMoney(selectedPoint.assetCents)}</strong>
					</div>
					<div class="negative">
						<span>Current card balances</span>
						<strong>{formatCardDeduction(history.cardBalanceCents)}</strong>
					</div>
					<div>
						<span>Net worth</span>
						<strong>{formatDetailedMoney(selectedPoint.netWorthCents)}</strong>
					</div>
				</div>

				<div class="breakdown-table-wrap">
					<table>
						<caption>Account breakdown for {formatDate(selectedPoint.recordedAt, true)}</caption>
						<thead>
							<tr>
								<th scope="col">Account</th>
								<th scope="col">Balance</th>
								<th scope="col">Change</th>
								<th scope="col">Source</th>
							</tr>
						</thead>
						<tbody>
							{#each selectedBreakdown as account (account.accountId)}
								<tr>
									<th scope="row">
										<strong>{account.nickname}</strong>
										<small>{accountTypeLabel(account.accountType)}</small>
									</th>
									<td>{formatDetailedMoney(account.balanceCents)}</td>
									<td
										class:positive={account.changeCents !== null && account.changeCents > 0}
										class:negative={account.changeCents !== null && account.changeCents < 0}
									>
										{formatSignedMoney(account.changeCents)}
									</td>
									<td>
										<span
											class:estimated={account.estimated}
											class:backfilled={account.backfilled}
											class="source-pill"
										>
											{sourceLabel(account)}
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="breakdown-note">
					Changes compare with the previous available date. Current card balances are applied to
					every historical date.
				</p>
			</section>
		{/if}

		<footer>
			<span class="legend"><i></i>Net worth</span>
			<span>
				{history.includesEstimates
					? 'Older gaps use the earliest known balance for each account.'
					: 'Future balance updates extend this history automatically.'}
				{history.excludedCurrencyCount > 0
					? ` ${history.excludedCurrencyCount} non-USD ${history.excludedCurrencyCount === 1 ? 'account is' : 'accounts are'} excluded.`
					: ''}
			</span>
		</footer>
	{/if}
</section>

<style>
	.net-worth-panel {
		margin-top: 1rem;
		padding: 1.35rem 1.45rem 1.15rem;
		border: 1px solid var(--line);
		border-radius: 12px;
		background: rgba(255, 253, 249, 0.86);
		box-shadow: var(--shadow-sm);
	}

	.net-worth-heading,
	.chart-toolbar,
	.net-worth-panel footer {
		display: flex;
		gap: 1rem;
		align-items: center;
		justify-content: space-between;
	}

	.net-worth-heading p,
	.net-worth-heading h2,
	.chart-toolbar p,
	.net-worth-panel footer {
		margin: 0;
	}

	.net-worth-heading p {
		color: var(--accent);
		font-size: 0.63rem;
		font-weight: 780;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.net-worth-heading h2 {
		margin-top: 0.22rem;
		font-size: 1.1rem;
		letter-spacing: -0.025em;
	}

	.estimate-badge {
		padding: 0.32rem 0.52rem;
		border-radius: 999px;
		color: #6b4c13;
		font-size: 0.59rem;
		font-weight: 750;
		background: #fff3d8;
	}

	.net-worth-metrics {
		display: grid;
		grid-template-columns: 1.2fr 1fr 1fr;
		margin-top: 1rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		overflow: hidden;
	}

	.net-worth-metrics > div {
		display: grid;
		gap: 0.2rem;
		padding: 0.8rem 0.9rem;
		background: rgba(246, 243, 236, 0.64);
	}

	.net-worth-metrics > div + div {
		border-left: 1px solid var(--line);
	}

	.net-worth-metrics span,
	.net-worth-metrics small {
		color: var(--faint);
		font-size: 0.61rem;
	}

	.net-worth-metrics strong {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 1rem;
		font-variant-numeric: tabular-nums;
	}

	.net-worth-metrics .negative strong,
	.net-worth-metrics .negative small {
		color: var(--red);
	}

	.chart-toolbar {
		margin-top: 0.95rem;
	}

	.chart-toolbar p {
		color: var(--muted);
		font-size: 0.67rem;
	}

	.range-controls {
		display: flex;
		gap: 0.15rem;
		padding: 0.18rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--paper-soft);
	}

	.range-controls button {
		min-width: 34px;
		padding: 0.34rem 0.46rem;
		border: 0;
		border-radius: 6px;
		color: var(--faint);
		font-size: 0.61rem;
		font-weight: 720;
		background: transparent;
		cursor: pointer;
	}

	.range-controls button[aria-pressed='true'] {
		color: white;
		background: var(--ink-soft);
	}

	.chart-wrap {
		position: relative;
		margin-top: 0.45rem;
	}

	.net-worth-chart {
		display: block;
		width: 100%;
		height: auto;
		overflow: visible;
		cursor: crosshair;
	}

	.net-worth-chart:focus-visible {
		border-radius: 8px;
		outline: 3px solid color-mix(in srgb, var(--accent) 35%, transparent);
		outline-offset: 2px;
	}

	.grid-line {
		stroke: rgba(187, 180, 168, 0.42);
		stroke-dasharray: 3 5;
	}

	.value-line {
		fill: none;
		stroke: var(--accent);
		stroke-width: 3;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.value-dot {
		fill: white;
		stroke: var(--accent);
		stroke-width: 3;
	}

	.value-dot.selected {
		fill: var(--accent);
		stroke: white;
		stroke-width: 2.5;
	}

	.net-worth-chart text {
		fill: var(--faint);
		font-size: 10px;
		font-weight: 620;
	}

	.chart-tooltip {
		position: absolute;
		display: grid;
		min-width: 128px;
		gap: 0.15rem;
		padding: 0.55rem 0.65rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: white;
		box-shadow: var(--shadow-md);
		pointer-events: none;
		transform: translate(-50%, calc(-100% - 12px));
	}

	.chart-tooltip span,
	.chart-tooltip small {
		color: var(--faint);
		font-size: 0.57rem;
	}

	.chart-tooltip strong {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.75rem;
	}

	.date-breakdown {
		margin-top: 0.9rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: rgba(246, 243, 236, 0.52);
		overflow: hidden;
	}

	.date-breakdown > header {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 1rem;
		align-items: center;
		padding: 0.8rem 0.9rem;
		border-bottom: 1px solid var(--line);
		background: rgba(255, 253, 249, 0.82);
	}

	.date-breakdown header p,
	.date-breakdown header h3,
	.date-breakdown p {
		margin: 0;
	}

	.date-breakdown header p,
	.selected-total span,
	.selected-total small,
	.breakdown-summary span {
		color: var(--faint);
		font-size: 0.58rem;
	}

	.date-breakdown header p {
		font-weight: 760;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.date-breakdown h3 {
		margin-top: 0.15rem;
		font-size: 0.86rem;
	}

	.selected-total {
		display: grid;
		gap: 0.1rem;
		text-align: right;
	}

	.selected-total strong,
	.breakdown-summary strong,
	.date-breakdown td:nth-child(2),
	.date-breakdown td:nth-child(3) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-variant-numeric: tabular-nums;
	}

	.selected-total strong {
		font-size: 0.86rem;
	}

	.selected-total.negative strong,
	.selected-total.negative small,
	.breakdown-summary .negative strong,
	.date-breakdown td.negative {
		color: var(--red);
	}

	.date-breakdown td.positive {
		color: var(--positive);
	}

	.date-breakdown > header button {
		width: 28px;
		height: 28px;
		border: 1px solid var(--line);
		border-radius: 7px;
		color: var(--muted);
		font-size: 1rem;
		line-height: 1;
		background: white;
		cursor: pointer;
	}

	.breakdown-summary {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		border-bottom: 1px solid var(--line);
	}

	.breakdown-summary > div {
		display: grid;
		gap: 0.15rem;
		padding: 0.65rem 0.9rem;
	}

	.breakdown-summary > div + div {
		border-left: 1px solid var(--line);
	}

	.breakdown-summary strong {
		font-size: 0.74rem;
	}

	.breakdown-table-wrap {
		overflow-x: auto;
	}

	.date-breakdown table {
		width: 100%;
		border-collapse: collapse;
	}

	.date-breakdown caption {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.date-breakdown th,
	.date-breakdown td {
		padding: 0.58rem 0.9rem;
		border-bottom: 1px solid rgba(214, 207, 196, 0.72);
		text-align: left;
	}

	.date-breakdown thead th {
		color: var(--faint);
		font-size: 0.55rem;
		font-weight: 740;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.date-breakdown tbody th {
		display: grid;
		gap: 0.08rem;
		font-size: 0.64rem;
	}

	.date-breakdown tbody th small {
		color: var(--faint);
		font-size: 0.54rem;
		font-weight: 500;
	}

	.date-breakdown td {
		font-size: 0.63rem;
	}

	.source-pill {
		display: inline-flex;
		padding: 0.2rem 0.36rem;
		border-radius: 999px;
		color: var(--muted);
		font-size: 0.52rem;
		font-weight: 720;
		background: #e9e5dc;
	}

	.source-pill.estimated {
		color: #6b4c13;
		background: #fff0cf;
	}

	.source-pill.backfilled {
		color: #4d5672;
		background: #e7eafa;
	}

	.breakdown-note {
		padding: 0.6rem 0.9rem 0.7rem;
		color: var(--faint);
		font-size: 0.56rem;
	}

	.net-worth-panel footer {
		padding-top: 0.75rem;
		border-top: 1px solid var(--line);
		color: var(--faint);
		font-size: 0.59rem;
	}

	.legend {
		display: inline-flex;
		flex: 0 0 auto;
		gap: 0.35rem;
		align-items: center;
		color: var(--muted);
		font-weight: 700;
	}

	.legend i {
		width: 18px;
		height: 3px;
		border-radius: 999px;
		background: var(--accent);
	}

	.net-worth-loading {
		display: grid;
		gap: 0.55rem;
		margin-top: 1rem;
	}

	.net-worth-loading span {
		height: 54px;
		border-radius: 9px;
		background: linear-gradient(90deg, #e8e2d8 25%, #f8f5ee 50%, #e8e2d8 75%);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
	}

	@keyframes shimmer {
		to {
			background-position: -200% 0;
		}
	}

	.net-worth-empty {
		display: flex;
		gap: 0.85rem;
		align-items: center;
		margin-top: 1rem;
		padding: 1rem;
		border: 1px dashed var(--line-strong);
		border-radius: 10px;
		background: var(--paper-soft);
	}

	.net-worth-empty svg {
		width: 42px;
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
	}

	.net-worth-empty div {
		flex: 1;
	}

	.net-worth-empty strong {
		font-size: 0.76rem;
	}

	.net-worth-empty p {
		margin: 0.25rem 0 0;
		color: var(--muted);
		font-size: 0.65rem;
	}

	.net-worth-empty a {
		color: var(--accent);
		font-size: 0.67rem;
		font-weight: 720;
	}

	@media (max-width: 680px) {
		.net-worth-panel {
			padding: 1.1rem;
		}

		.net-worth-metrics {
			grid-template-columns: 1fr 1fr;
		}

		.net-worth-metrics > div:last-child {
			grid-column: 1 / -1;
			border-top: 1px solid var(--line);
			border-left: 0;
		}

		.chart-toolbar,
		.net-worth-panel footer {
			align-items: flex-start;
			flex-direction: column;
		}

		.net-worth-chart {
			min-width: 620px;
		}

		.chart-wrap {
			overflow-x: auto;
			padding-bottom: 0.25rem;
		}

		.date-breakdown > header {
			grid-template-columns: 1fr auto;
		}

		.selected-total {
			grid-column: 1 / -1;
			grid-row: 2;
			text-align: left;
		}

		.date-breakdown > header button {
			grid-column: 2;
			grid-row: 1;
		}

		.date-breakdown thead {
			position: absolute;
			width: 1px;
			height: 1px;
			padding: 0;
			margin: -1px;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
			border: 0;
		}

		.date-breakdown tbody {
			display: block;
		}

		.date-breakdown tbody tr {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.14rem 0.75rem;
			padding: 0.58rem 0.9rem;
			border-bottom: 1px solid rgba(214, 207, 196, 0.72);
		}

		.date-breakdown tbody th,
		.date-breakdown tbody td {
			padding: 0;
			border: 0;
		}

		.date-breakdown tbody th {
			grid-row: 1 / span 2;
		}

		.date-breakdown tbody td:nth-child(2),
		.date-breakdown tbody td:nth-child(3) {
			text-align: right;
		}

		.date-breakdown tbody td:nth-child(2) {
			grid-column: 2;
			grid-row: 1;
		}

		.date-breakdown tbody td:nth-child(3) {
			grid-column: 2;
			grid-row: 2;
		}

		.date-breakdown tbody td:nth-child(2)::before,
		.date-breakdown tbody td:nth-child(3)::before {
			margin-right: 0.3rem;
			color: var(--faint);
			font-family: inherit;
			font-size: 0.48rem;
			font-weight: 600;
			text-transform: uppercase;
		}

		.date-breakdown tbody td:nth-child(2)::before {
			content: 'Balance';
		}

		.date-breakdown tbody td:nth-child(3)::before {
			content: 'Change';
		}

		.date-breakdown tbody td:nth-child(4) {
			grid-column: 1 / -1;
			grid-row: 3;
			margin-top: 0.16rem;
		}
	}

	@media (max-width: 430px) {
		.net-worth-heading {
			align-items: flex-start;
			flex-direction: column;
		}

		.net-worth-metrics {
			grid-template-columns: 1fr;
		}

		.net-worth-metrics > div + div,
		.net-worth-metrics > div:last-child {
			grid-column: auto;
			border-top: 1px solid var(--line);
			border-left: 0;
		}

		.net-worth-empty {
			align-items: flex-start;
			flex-wrap: wrap;
		}

		.breakdown-summary {
			grid-template-columns: 1fr;
		}

		.breakdown-summary > div + div {
			border-top: 1px solid var(--line);
			border-left: 0;
		}
	}
</style>
