<script lang="ts">
	import { creditBureauLabel } from '$lib/credit-scores';
	import type { CreditBureau, CreditScoreEntry } from '$lib/credit-score-types';

	let { entries }: { entries: CreditScoreEntry[] } = $props();

	const WIDTH = 840;
	const HEIGHT = 270;
	const PLOT_LEFT = 50;
	const PLOT_RIGHT = 18;
	const PLOT_TOP = 16;
	const PLOT_BOTTOM = 38;
	const MIN_SCORE = 300;
	const MAX_SCORE = 850;
	const bureaus: CreditBureau[] = ['experian', 'equifax', 'transunion', 'other'];
	const bands = [
		{ label: 'Exceptional', min: 800, max: 850, className: 'exceptional' },
		{ label: 'Very good', min: 740, max: 800, className: 'very-good' },
		{ label: 'Good', min: 670, max: 740, className: 'good' },
		{ label: 'Fair', min: 580, max: 670, className: 'fair' },
		{ label: 'Poor', min: 300, max: 580, className: 'poor' }
	];
	const ticks = [850, 800, 740, 670, 580, 300];
	const fullDate = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});

	let hoveredId = $state<string | null>(null);

	const sorted = $derived(
		entries
			.slice()
			.sort(
				(left, right) =>
					left.recordedDate.localeCompare(right.recordedDate) ||
					left.createdAt.localeCompare(right.createdAt)
			)
	);
	const chart = $derived(chartFor(sorted));
	const hovered = $derived(chart.points.find((point) => point.id === hoveredId) ?? null);
	const activeBureaus = $derived(
		bureaus.filter((bureau) => sorted.some((entry) => entry.bureau === bureau))
	);

	type ChartPoint = CreditScoreEntry & { x: number; y: number };

	function yFor(score: number): number {
		const plotHeight = HEIGHT - PLOT_TOP - PLOT_BOTTOM;
		return PLOT_TOP + ((MAX_SCORE - score) / (MAX_SCORE - MIN_SCORE)) * plotHeight;
	}

	function chartFor(history: CreditScoreEntry[]): {
		points: ChartPoint[];
		paths: Array<{ bureau: CreditBureau; d: string }>;
	} {
		if (history.length === 0) return { points: [], paths: [] };
		const firstTime = new Date(`${history[0].recordedDate}T12:00:00`).getTime();
		const lastTime = new Date(`${history.at(-1)!.recordedDate}T12:00:00`).getTime();
		const timeRange = lastTime - firstTime;
		const plotWidth = WIDTH - PLOT_LEFT - PLOT_RIGHT;
		const points = history.map<ChartPoint>((entry) => {
			const time = new Date(`${entry.recordedDate}T12:00:00`).getTime();
			return {
				...entry,
				x:
					history.length === 1 || timeRange === 0
						? PLOT_LEFT + plotWidth / 2
						: PLOT_LEFT + ((time - firstTime) / timeRange) * plotWidth,
				y: yFor(entry.score)
			};
		});
		const paths = bureaus.flatMap((bureau) => {
			const bureauPoints = points.filter((point) => point.bureau === bureau);
			if (bureauPoints.length < 2) return [];
			return [
				{
					bureau,
					d: bureauPoints
						.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
						.join(' ')
				}
			];
		});
		return { points, paths };
	}

	function formatDate(date: string): string {
		return fullDate.format(new Date(`${date}T12:00:00`));
	}

	function handlePointerMove(event: PointerEvent): void {
		if (chart.points.length === 0) return;
		const bounds = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
		const x = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
		let nearest = chart.points[0];
		for (const point of chart.points.slice(1)) {
			if (Math.abs(point.x - x) < Math.abs(nearest.x - x)) nearest = point;
		}
		hoveredId = nearest.id;
	}
</script>

<section class="score-chart-panel" aria-labelledby="credit-score-trend-title">
	<div class="score-chart-heading">
		<div>
			<p>Score history</p>
			<h2 id="credit-score-trend-title">Your trend</h2>
		</div>
		{#if activeBureaus.length > 0}
			<div class="score-legend" aria-label="Credit bureau legend">
				{#each activeBureaus as bureau (bureau)}
					<span class={bureau}><i></i>{creditBureauLabel(bureau)}</span>
				{/each}
			</div>
		{/if}
	</div>

	{#if sorted.length === 0}
		<div class="score-chart-empty">
			<strong>Your trend starts with the first reading</strong>
			<p>Add scores from the same bureau over time for a clean comparison.</p>
		</div>
	{:else}
		<div class="score-chart-wrap">
			{#if hovered}
				<div class="score-tooltip" aria-live="polite">
					<strong>{hovered.score}</strong>
					<span>{creditBureauLabel(hovered.bureau)} · {formatDate(hovered.recordedDate)}</span>
				</div>
			{/if}
			<svg
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				role="img"
				aria-label={`Credit score history from ${formatDate(sorted[0].recordedDate)} to ${formatDate(sorted.at(-1)!.recordedDate)}`}
				onpointermove={handlePointerMove}
				onpointerleave={() => (hoveredId = null)}
			>
				{#each bands as band (band.label)}
					<rect
						x={PLOT_LEFT}
						y={yFor(band.max)}
						width={WIDTH - PLOT_LEFT - PLOT_RIGHT}
						height={yFor(band.min) - yFor(band.max)}
						class={`score-band ${band.className}`}
					/>
				{/each}
				{#each ticks as tick (tick)}
					<line x1={PLOT_LEFT} x2={WIDTH - PLOT_RIGHT} y1={yFor(tick)} y2={yFor(tick)} />
					<text x={PLOT_LEFT - 8} y={yFor(tick) + 4} text-anchor="end">{tick}</text>
				{/each}
				{#each chart.paths as path (path.bureau)}
					<path d={path.d} class={`score-line ${path.bureau}`} />
				{/each}
				{#each chart.points as point (point.id)}
					<circle
						cx={point.x}
						cy={point.y}
						r={hoveredId === point.id ? 6 : 4.5}
						class={`score-point ${point.bureau}`}
					/>
				{/each}
				<text class="date-label" x={PLOT_LEFT} y={HEIGHT - 10} text-anchor="start">
					{formatDate(sorted[0].recordedDate)}
				</text>
				<text class="date-label" x={WIDTH - PLOT_RIGHT} y={HEIGHT - 10} text-anchor="end">
					{formatDate(sorted.at(-1)!.recordedDate)}
				</text>
			</svg>
		</div>
		<p class="score-chart-note">
			Compare readings from the same bureau and scoring model. Different sources can update on
			different days and may show different scores.
		</p>
	{/if}
</section>

<style>
	.score-chart-panel {
		margin: 0 0 2.4rem;
		padding: 1.2rem;
		border: 1px solid var(--line);
		border-radius: 14px;
		background: var(--paper);
		box-shadow: var(--shadow-sm);
	}

	.score-chart-heading {
		display: flex;
		gap: 1rem;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 0.85rem;
	}

	.score-chart-heading p {
		margin: 0 0 0.2rem;
		color: var(--accent);
		font-size: 0.6rem;
		font-weight: 760;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.score-chart-heading h2 {
		margin: 0;
		font-size: 1.1rem;
		letter-spacing: -0.025em;
	}

	.score-legend {
		display: flex;
		gap: 0.8rem;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.score-legend span {
		display: inline-flex;
		gap: 0.32rem;
		align-items: center;
		color: var(--muted);
		font-size: 0.6rem;
		font-weight: 680;
	}

	.score-legend i {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--bureau-color);
	}

	.score-chart-wrap {
		position: relative;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: #fff;
	}

	svg {
		display: block;
		width: 100%;
		height: auto;
		touch-action: none;
	}

	.score-band.exceptional {
		fill: rgba(8, 127, 117, 0.12);
	}

	.score-band.very-good {
		fill: rgba(8, 127, 117, 0.075);
	}

	.score-band.good {
		fill: rgba(61, 90, 254, 0.055);
	}

	.score-band.fair {
		fill: rgba(155, 90, 22, 0.07);
	}

	.score-band.poor {
		fill: rgba(182, 63, 84, 0.065);
	}

	line {
		stroke: rgba(70, 81, 99, 0.18);
		stroke-width: 1;
	}

	text {
		fill: var(--faint);
		font-size: 10px;
		font-family: inherit;
	}

	.date-label {
		font-size: 9px;
	}

	.score-line {
		fill: none;
		stroke: var(--bureau-color);
		stroke-width: 3;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.score-point {
		fill: white;
		stroke: var(--bureau-color);
		stroke-width: 3;
		transition: r 120ms ease;
	}

	.experian {
		--bureau-color: #3d5afe;
	}

	.equifax {
		--bureau-color: #087f75;
	}

	.transunion {
		--bureau-color: #9b5a16;
	}

	.other {
		--bureau-color: #7c4d9f;
	}

	.score-tooltip {
		position: absolute;
		z-index: 2;
		top: 0.75rem;
		right: 0.75rem;
		display: grid;
		gap: 0.1rem;
		padding: 0.5rem 0.65rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: rgba(255, 253, 249, 0.94);
		box-shadow: var(--shadow-sm);
		pointer-events: none;
	}

	.score-tooltip strong {
		font-size: 1rem;
	}

	.score-tooltip span,
	.score-chart-note,
	.score-chart-empty p {
		color: var(--muted);
		font-size: 0.6rem;
	}

	.score-chart-note {
		margin: 0.65rem 0 0;
		line-height: 1.5;
	}

	.score-chart-empty {
		padding: 2.3rem 1rem;
		border: 1px dashed var(--line-strong);
		border-radius: 10px;
		text-align: center;
		background: var(--paper-soft);
	}

	.score-chart-empty p {
		margin: 0.35rem 0 0;
	}

	@media (max-width: 620px) {
		.score-chart-heading {
			flex-direction: column;
		}

		.score-legend {
			justify-content: flex-start;
		}
	}
</style>
