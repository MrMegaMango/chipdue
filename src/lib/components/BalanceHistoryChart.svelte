<script lang="ts">
	import type { AccountBalanceHistoryPoint } from '$lib/types';

	type HistoryRange = '1M' | '3M' | '1Y' | 'ALL';
	type ChartPoint = AccountBalanceHistoryPoint & {
		x: number;
		y: number;
		contributionsY: number | null;
	};
	type ReturnArea = { path: string; kind: 'gain' | 'loss' };

	let {
		accountId,
		accountName,
		currency,
		netContributionsCents,
		points
	}: {
		accountId: string;
		accountName: string;
		currency: string;
		netContributionsCents: number | null;
		points: AccountBalanceHistoryPoint[];
	} = $props();

	const WIDTH = 760;
	const HEIGHT = 250;
	const PLOT_LEFT = 58;
	const PLOT_RIGHT = 16;
	const PLOT_TOP = 18;
	const PLOT_BOTTOM = 35;
	const ranges: Array<{ id: HistoryRange; label: string }> = [
		{ id: '1M', label: '1M' },
		{ id: '3M', label: '3M' },
		{ id: '1Y', label: '1Y' },
		{ id: 'ALL', label: 'All' }
	];
	const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
	const fullDateLabel = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});

	let selectedRange = $state<HistoryRange>('1Y');
	let hoveredIndex = $state<number | null>(null);

	const sortedPoints = $derived.by(() =>
		points
			.filter(
				(point) =>
					Number.isFinite(new Date(point.recordedAt).getTime()) &&
					Number.isFinite(point.balanceCents)
			)
			.slice()
			.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
	);
	const visiblePoints = $derived(pointsForRange(sortedPoints, selectedRange));
	const chart = $derived(chartFor(visiblePoints));
	const latestPoint = $derived(visiblePoints.at(-1));
	const latestContributionsCents = $derived(
		latestPoint?.netContributionsCents ?? netContributionsCents
	);
	const investmentReturnCents = $derived(
		latestPoint && latestContributionsCents !== null
			? latestPoint.balanceCents - latestContributionsCents
			: null
	);
	const investmentReturnPercent = $derived(
		investmentReturnCents !== null && latestContributionsCents
			? (investmentReturnCents / Math.abs(latestContributionsCents)) * 100
			: null
	);
	const hoveredPoint = $derived(
		hoveredIndex === null ? null : (chart.points[hoveredIndex] ?? null)
	);
	const gradientId = $derived(`balance-fill-${accountId.replace(/[^A-Za-z0-9_-]/g, '')}`);

	function pointsForRange(
		allPoints: AccountBalanceHistoryPoint[],
		range: HistoryRange
	): AccountBalanceHistoryPoint[] {
		if (range === 'ALL' || allPoints.length < 2) return allPoints;
		const latest = new Date(allPoints.at(-1)!.recordedAt).getTime();
		const days = range === '1M' ? 30 : range === '3M' ? 90 : 365;
		const cutoff = latest - days * 24 * 60 * 60 * 1_000;
		const filtered = allPoints.filter((point) => new Date(point.recordedAt).getTime() >= cutoff);
		return filtered.length > 0 ? filtered : allPoints.slice(-1);
	}

	function chartFor(history: AccountBalanceHistoryPoint[]): {
		points: ChartPoint[];
		linePath: string;
		contributionLinePaths: string[];
		contributionAreaPaths: string[];
		returnAreas: ReturnArea[];
		portfolioAreaPath: string;
		ticks: Array<{ value: number; y: number }>;
	} {
		if (history.length === 0) {
			return {
				points: [],
				linePath: '',
				contributionLinePaths: [],
				contributionAreaPaths: [],
				returnAreas: [],
				portfolioAreaPath: '',
				ticks: []
			};
		}
		const hasContributions = history.some((point) => point.netContributionsCents !== null);
		const values = history.flatMap((point) => [
			point.balanceCents,
			...(point.netContributionsCents === null ? [] : [point.netContributionsCents])
		]);
		if (hasContributions) values.push(0);
		const rawMin = Math.min(...values);
		const rawMax = Math.max(...values);
		const valueRange = rawMax - rawMin;
		const padding = Math.max(
			valueRange * (hasContributions ? 0.06 : 0.14),
			Math.max(Math.abs(rawMax), 1) * 0.025,
			100
		);
		const min = hasContributions && rawMin >= 0 ? 0 : rawMin - padding;
		const max = rawMax + padding;
		const firstTime = new Date(history[0].recordedAt).getTime();
		const lastTime = new Date(history.at(-1)!.recordedAt).getTime();
		const timeRange = lastTime - firstTime;
		const plotWidth = WIDTH - PLOT_LEFT - PLOT_RIGHT;
		const plotHeight = HEIGHT - PLOT_TOP - PLOT_BOTTOM;
		const scaled = history.map<ChartPoint>((point) => {
			const time = new Date(point.recordedAt).getTime();
			return {
				...point,
				x:
					history.length === 1 || timeRange === 0
						? PLOT_LEFT + plotWidth / 2
						: PLOT_LEFT + ((time - firstTime) / timeRange) * plotWidth,
				y: PLOT_TOP + ((max - point.balanceCents) / (max - min)) * plotHeight,
				contributionsY:
					point.netContributionsCents === null
						? null
						: PLOT_TOP + ((max - point.netContributionsCents) / (max - min)) * plotHeight
			};
		});
		const linePath = scaled
			.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
			.join(' ');
		const floor = HEIGHT - PLOT_BOTTOM;
		const zeroY = PLOT_TOP + ((max - 0) / (max - min)) * plotHeight;
		const contributionGroups: Array<Array<ChartPoint & { contributionsY: number }>> = [];
		for (let index = 0; index < scaled.length; index += 1) {
			const point = scaled[index];
			if (point.contributionsY === null) continue;
			const previousPoint = scaled[index - 1];
			if (!previousPoint || previousPoint.contributionsY === null) contributionGroups.push([]);
			contributionGroups.at(-1)!.push(point as ChartPoint & { contributionsY: number });
		}
		const contributionLinePaths = contributionGroups.flatMap((group) => {
			if (group.length === 1) {
				return history.length === 1
					? [
							`M ${PLOT_LEFT} ${group[0].contributionsY} L ${WIDTH - PLOT_RIGHT} ${group[0].contributionsY}`
						]
					: [];
			}
			return [
				group
					.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.contributionsY}`)
					.join(' ')
			];
		});
		const contributionAreaPaths = contributionGroups.flatMap((group) => {
			if (group.length === 1) {
				return history.length === 1
					? [
							`M ${PLOT_LEFT} ${zeroY} L ${PLOT_LEFT} ${group[0].contributionsY} L ${WIDTH - PLOT_RIGHT} ${group[0].contributionsY} L ${WIDTH - PLOT_RIGHT} ${zeroY} Z`
						]
					: [];
			}
			return [
				`M ${group[0].x} ${zeroY} L ${group
					.map((point) => `${point.x} ${point.contributionsY}`)
					.join(' L ')} L ${group.at(-1)!.x} ${zeroY} Z`
			];
		});
		const returnAreas = contributionGroups.flatMap((group) =>
			returnAreasFor(group, history.length)
		);
		const portfolioAreaPath =
			!hasContributions && scaled.length > 1
				? `${linePath} L ${scaled.at(-1)!.x} ${floor} L ${scaled[0].x} ${floor} Z`
				: '';
		const ticks = [max, (max + min) / 2, min].map((value) => ({
			value,
			y: PLOT_TOP + ((max - value) / (max - min)) * plotHeight
		}));
		return {
			points: scaled,
			linePath,
			contributionLinePaths,
			contributionAreaPaths,
			returnAreas,
			portfolioAreaPath,
			ticks
		};
	}

	function returnAreasFor(
		group: Array<ChartPoint & { contributionsY: number }>,
		historyLength: number
	): ReturnArea[] {
		if (group.length === 1) {
			if (historyLength !== 1) return [];
			const point = group[0];
			return [
				{
					kind: point.balanceCents >= point.netContributionsCents! ? 'gain' : 'loss',
					path: `M ${PLOT_LEFT} ${point.y} L ${WIDTH - PLOT_RIGHT} ${point.y} L ${WIDTH - PLOT_RIGHT} ${point.contributionsY} L ${PLOT_LEFT} ${point.contributionsY} Z`
				}
			];
		}

		const areas: ReturnArea[] = [];
		for (let index = 1; index < group.length; index += 1) {
			const left = group[index - 1];
			const right = group[index];
			const leftReturn = left.balanceCents - left.netContributionsCents!;
			const rightReturn = right.balanceCents - right.netContributionsCents!;
			if (
				leftReturn === 0 ||
				rightReturn === 0 ||
				Math.sign(leftReturn) === Math.sign(rightReturn)
			) {
				areas.push(returnPolygon(left, right, leftReturn + rightReturn >= 0 ? 'gain' : 'loss'));
				continue;
			}

			const crossingRatio = Math.abs(leftReturn) / (Math.abs(leftReturn) + Math.abs(rightReturn));
			const crossingX = left.x + (right.x - left.x) * crossingRatio;
			const crossingY = left.y + (right.y - left.y) * crossingRatio;
			const crossing = {
				...left,
				x: crossingX,
				y: crossingY,
				contributionsY: crossingY
			};
			areas.push(returnPolygon(left, crossing, leftReturn >= 0 ? 'gain' : 'loss'));
			areas.push(returnPolygon(crossing, right, rightReturn >= 0 ? 'gain' : 'loss'));
		}
		return areas;
	}

	function returnPolygon(
		left: ChartPoint & { contributionsY: number },
		right: ChartPoint & { contributionsY: number },
		kind: ReturnArea['kind']
	): ReturnArea {
		return {
			kind,
			path: `M ${left.x} ${left.y} L ${right.x} ${right.y} L ${right.x} ${right.contributionsY} L ${left.x} ${left.contributionsY} Z`
		};
	}

	function formatMoney(balanceCents: number): string {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency,
			maximumFractionDigits: 2
		}).format(balanceCents / 100);
	}

	function formatCompactMoney(balanceCents: number): string {
		return new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency,
			notation: 'compact',
			maximumFractionDigits: 1
		}).format(balanceCents / 100);
	}

	function formatDate(recordedAt: string, full = false): string {
		return (full ? fullDateLabel : dateLabel).format(new Date(recordedAt));
	}

	function handlePointerMove(event: PointerEvent): void {
		if (chart.points.length === 0) return;
		const bounds = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
		const x = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
		let nearest = 0;
		for (let index = 1; index < chart.points.length; index += 1) {
			if (Math.abs(chart.points[index].x - x) < Math.abs(chart.points[nearest].x - x)) {
				nearest = index;
			}
		}
		hoveredIndex = nearest;
	}
</script>

<section class="balance-history" aria-labelledby={`history-title-${accountId}`}>
	<div class="history-heading">
		<div>
			<p>Portfolio history</p>
			<h4 id={`history-title-${accountId}`}>Growth breakdown</h4>
		</div>
	</div>

	{#if sortedPoints.length === 0}
		<div class="history-empty">
			<svg viewBox="0 0 48 32" aria-hidden="true">
				<path d="M3 27 13 18l8 4 9-14 15 8" />
				<path d="M3 29h42" />
			</svg>
			<div>
				<strong>No balance history yet</strong>
				<p>Add a current balance to begin tracking this brokerage account over time.</p>
			</div>
		</div>
	{:else}
		{#if latestPoint}
			<div class="history-metrics">
				<div>
					<span>Portfolio value</span>
					<strong>{formatMoney(latestPoint.balanceCents)}</strong>
				</div>
				<div class="contributions">
					<span>Net contributions</span>
					<strong>
						{latestContributionsCents === null
							? 'Not entered'
							: formatMoney(latestContributionsCents)}
					</strong>
				</div>
				<div class:negative={investmentReturnCents !== null && investmentReturnCents < 0}>
					<span>Investment return</span>
					<strong>
						{investmentReturnCents === null
							? '—'
							: `${investmentReturnCents >= 0 ? '+' : ''}${formatMoney(investmentReturnCents)}`}
					</strong>
					{#if investmentReturnPercent !== null}
						<small>
							{investmentReturnPercent >= 0 ? '+' : ''}{investmentReturnPercent.toFixed(1)}%
						</small>
					{/if}
				</div>
			</div>
		{/if}

		<div class="chart-toolbar">
			<div class="chart-legend" aria-label="Chart legend">
				<span><i class="portfolio"></i>Portfolio value</span>
				<span><i class="contributions"></i>Net contributions</span>
				<span><i class="returns"></i>Investment return</span>
			</div>
			<div class="range-controls" aria-label="Balance history range">
				{#each ranges as range (range.id)}
					<button
						type="button"
						aria-pressed={selectedRange === range.id}
						onclick={() => {
							selectedRange = range.id;
							hoveredIndex = null;
						}}
					>
						{range.label}
					</button>
				{/each}
			</div>
		</div>

		<div class="chart-wrap">
			<svg
				class="history-chart"
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				role="img"
				aria-label={`${accountName} portfolio value from ${formatDate(visiblePoints[0].recordedAt, true)} to ${formatDate(visiblePoints.at(-1)!.recordedAt, true)}`}
				onpointermove={handlePointerMove}
				onpointerleave={() => (hoveredIndex = null)}
			>
				<defs>
					<linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
						<stop offset="0%" stop-color="var(--accent)" stop-opacity="0.24" />
						<stop offset="100%" stop-color="var(--accent)" stop-opacity="0.015" />
					</linearGradient>
				</defs>
				{#each chart.ticks as tick (tick.y)}
					<line x1={PLOT_LEFT} x2={WIDTH - PLOT_RIGHT} y1={tick.y} y2={tick.y} class="grid-line" />
					<text x={PLOT_LEFT - 8} y={tick.y + 4} text-anchor="end">
						{formatCompactMoney(tick.value)}
					</text>
				{/each}
				{#if chart.portfolioAreaPath}
					<path d={chart.portfolioAreaPath} fill={`url(#${gradientId})`} />
				{/if}
				{#each chart.contributionAreaPaths as path (path)}
					<path d={path} class="contributions-area" />
				{/each}
				{#each chart.returnAreas as area, index (`${area.kind}-${index}`)}
					<path
						d={area.path}
						class:return-gain={area.kind === 'gain'}
						class:return-loss={area.kind === 'loss'}
					/>
				{/each}
				{#if chart.points.length === 1}
					<line
						x1={PLOT_LEFT}
						x2={WIDTH - PLOT_RIGHT}
						y1={chart.points[0].y}
						y2={chart.points[0].y}
						class="starting-line"
					/>
				{:else}
					<path d={chart.linePath} class="value-line" />
				{/if}
				{#each chart.contributionLinePaths as path (path)}
					<path d={path} class="contributions-line" />
				{/each}
				{#each chart.points as point, index (point.recordedAt)}
					{#if index === chart.points.length - 1 || index === hoveredIndex}
						<circle
							cx={point.x}
							cy={point.y}
							r={index === hoveredIndex ? 6 : 4.5}
							class="value-dot"
						/>
					{/if}
					{#if point.contributionsY !== null && (index === chart.points.length - 1 || index === hoveredIndex)}
						<circle
							cx={point.x}
							cy={point.contributionsY}
							r={index === hoveredIndex ? 5.5 : 4}
							class="contributions-dot"
						/>
					{/if}
				{/each}
				<text x={PLOT_LEFT} y={HEIGHT - 10}>{formatDate(visiblePoints[0].recordedAt)}</text>
				<text x={WIDTH - PLOT_RIGHT} y={HEIGHT - 10} text-anchor="end">
					{formatDate(visiblePoints.at(-1)!.recordedAt)}
				</text>
			</svg>

			{#if hoveredPoint}
				<div
					class="chart-tooltip"
					style={`left: ${(hoveredPoint.x / WIDTH) * 100}%; top: ${(hoveredPoint.y / HEIGHT) * 100}%`}
				>
					<strong>Portfolio {formatMoney(hoveredPoint.balanceCents)}</strong>
					{#if hoveredPoint.netContributionsCents !== null}
						<span>Contributions {formatMoney(hoveredPoint.netContributionsCents)}</span>
						<span>
							Return {hoveredPoint.balanceCents - hoveredPoint.netContributionsCents >= 0
								? '+'
								: ''}{formatMoney(hoveredPoint.balanceCents - hoveredPoint.netContributionsCents)}
						</span>
					{/if}
					<span>{formatDate(hoveredPoint.recordedAt, true)}</span>
				</div>
			{/if}
		</div>

		<p class="history-footnote">
			{#if latestContributionsCents === null}
				Add net contributions in account details to separate deposits from investment return.
			{:else if sortedPoints.length === 1}
				History starts here. Each saved balance or successful sync adds a new point.
			{:else}
				{visiblePoints.length} snapshots · {formatDate(
					visiblePoints[0].recordedAt,
					true
				)}–{formatDate(visiblePoints.at(-1)!.recordedAt, true)}
			{/if}
		</p>
		{#if latestContributionsCents !== null}
			<p class="return-explainer">
				Investment return is value minus net contributions. It includes market movement, dividends,
				interest, and fees.
			</p>
		{/if}

		<table class="visually-hidden">
			<caption>{accountName} portfolio history</caption>
			<thead><tr><th>Date</th><th>Portfolio value</th><th>Net contributions</th></tr></thead>
			<tbody>
				{#each visiblePoints as point (point.recordedAt)}
					<tr
						><td>{formatDate(point.recordedAt, true)}</td><td>{formatMoney(point.balanceCents)}</td
						><td
							>{point.netContributionsCents === null
								? 'Not entered'
								: formatMoney(point.netContributionsCents)}</td
						></tr
					>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<style>
	.balance-history {
		margin-top: 1rem;
		padding: 0.9rem;
		border: 1px solid var(--line);
		border-radius: 11px;
		background: linear-gradient(180deg, rgba(233, 237, 255, 0.48), rgba(255, 253, 249, 0.65));
	}

	.history-heading {
		display: flex;
		gap: 1rem;
		align-items: flex-start;
		justify-content: space-between;
	}

	.history-heading p {
		margin: 0 0 0.2rem;
		color: var(--faint);
		font-size: 0.54rem;
		font-weight: 760;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.history-heading h4 {
		margin: 0;
		font-size: 0.76rem;
	}

	.history-metrics {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1px;
		margin-top: 0.75rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--line);
		overflow: hidden;
	}

	.history-metrics > div {
		display: grid;
		min-width: 0;
		padding: 0.58rem 0.65rem;
		background: rgba(255, 253, 249, 0.92);
	}

	.history-metrics span {
		margin-bottom: 0.16rem;
		color: var(--faint);
		font-size: 0.52rem;
		font-weight: 720;
		letter-spacing: 0.035em;
		text-transform: uppercase;
	}

	.history-metrics strong {
		overflow: hidden;
		font-size: 0.78rem;
		letter-spacing: -0.018em;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.history-metrics > div:last-child strong,
	.history-metrics > div:last-child small {
		color: var(--positive);
	}

	.history-metrics > div.negative strong,
	.history-metrics > div.negative small {
		color: var(--red);
	}

	.history-metrics small {
		font-size: 0.58rem;
		font-weight: 720;
	}

	.chart-toolbar {
		display: flex;
		gap: 0.7rem;
		align-items: center;
		justify-content: space-between;
		margin: 0.58rem 0 0.22rem;
	}

	.chart-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.72rem;
		align-items: center;
		color: var(--faint);
		font-size: 0.54rem;
		font-weight: 660;
	}

	.chart-legend span {
		display: inline-flex;
		gap: 0.3rem;
		align-items: center;
	}

	.chart-legend i {
		display: inline-block;
		width: 15px;
		height: 0;
		border-top: 2px solid var(--accent);
	}

	.chart-legend i.contributions {
		width: 13px;
		height: 8px;
		border: 1px solid var(--amber);
		border-radius: 2px;
		background: color-mix(in srgb, var(--amber) 26%, transparent);
	}

	.chart-legend i.returns {
		width: 13px;
		height: 8px;
		border: 0;
		border-radius: 2px;
		background: linear-gradient(90deg, var(--positive) 0 50%, var(--red) 50% 100%);
		opacity: 0.62;
	}

	.range-controls {
		display: flex;
		gap: 0.22rem;
		justify-content: flex-end;
		margin: 0;
	}

	.range-controls button {
		min-width: 35px;
		padding: 0.28rem 0.45rem;
		border: 0;
		border-radius: 6px;
		color: var(--faint);
		font-size: 0.56rem;
		font-weight: 740;
		background: transparent;
		cursor: pointer;
	}

	.range-controls button:hover,
	.range-controls button[aria-pressed='true'] {
		color: var(--accent-dark);
		background: white;
		box-shadow: 0 0 0 1px var(--line);
	}

	.chart-wrap {
		position: relative;
	}

	.history-chart {
		display: block;
		width: 100%;
		height: auto;
		min-height: 165px;
		overflow: visible;
		touch-action: pan-y;
	}

	.history-chart text {
		fill: var(--faint);
		font-size: 10px;
		font-weight: 620;
	}

	.grid-line {
		stroke: var(--line);
		stroke-width: 1;
		stroke-dasharray: 3 5;
	}

	.starting-line {
		stroke: var(--accent);
		stroke-width: 3;
		stroke-linecap: round;
		opacity: 0.86;
		vector-effect: non-scaling-stroke;
	}

	.value-line {
		fill: none;
		stroke: var(--accent);
		stroke-width: 3;
		stroke-linecap: round;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}

	.value-dot {
		fill: white;
		stroke: var(--accent);
		stroke-width: 3;
		vector-effect: non-scaling-stroke;
	}

	.contributions-area {
		fill: var(--amber);
		fill-opacity: 0.2;
	}

	.return-gain {
		fill: var(--positive);
		fill-opacity: 0.25;
	}

	.return-loss {
		fill: var(--red);
		fill-opacity: 0.23;
	}

	.contributions-line {
		fill: none;
		stroke: var(--amber);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}

	.contributions-dot {
		fill: white;
		stroke: var(--amber);
		stroke-width: 2.5;
		vector-effect: non-scaling-stroke;
	}

	.chart-tooltip {
		position: absolute;
		display: grid;
		z-index: 2;
		min-width: 104px;
		padding: 0.45rem 0.55rem;
		border: 1px solid var(--ink-soft);
		border-radius: 7px;
		color: white;
		font-size: 0.57rem;
		line-height: 1.4;
		background: var(--ink-soft);
		box-shadow: 0 8px 20px rgba(17, 24, 39, 0.18);
		pointer-events: none;
		transform: translate(-50%, calc(-100% - 9px));
	}

	.chart-tooltip span {
		opacity: 0.76;
	}

	.history-footnote {
		margin: 0.15rem 0 0;
		color: var(--faint);
		font-size: 0.56rem;
		line-height: 1.45;
	}

	.return-explainer {
		margin: 0.3rem 0 0;
		color: var(--faint);
		font-size: 0.54rem;
		line-height: 1.45;
	}

	.history-empty {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		margin-top: 0.75rem;
		padding: 0.75rem;
		border: 1px dashed var(--line-strong);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.52);
	}

	.history-empty svg {
		width: 42px;
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.history-empty strong {
		font-size: 0.66rem;
	}

	.history-empty p {
		margin: 0.2rem 0 0;
		color: var(--faint);
		font-size: 0.58rem;
		line-height: 1.45;
	}

	.visually-hidden {
		position: absolute;
		display: block;
		width: 1px;
		max-width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
		contain: strict;
	}

	@media (max-width: 640px) {
		.balance-history {
			padding: 0.75rem;
		}

		.history-chart {
			min-height: 145px;
		}

		.history-metrics {
			grid-template-columns: 1fr 1fr;
		}

		.history-metrics > div:first-child {
			grid-column: 1 / -1;
		}

		.chart-toolbar {
			align-items: flex-start;
			flex-direction: column;
		}

		.range-controls {
			align-self: flex-end;
		}
	}
</style>
