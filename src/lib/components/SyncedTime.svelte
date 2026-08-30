<script lang="ts">
	import { onMount } from 'svelte';
	import {
		currentTime,
		exactTimestampLabel,
		relativeTimestampLabel,
		type TimestampAction
	} from '$lib/sync-time';

	type Props = {
		value: string | null | undefined;
		action?: TimestampAction;
		fallback?: string;
	};

	let { value, action = 'Synced', fallback }: Props = $props();
	const componentId = $props.id();
	const tooltipId = `${componentId}-exact-time`;
	let timestampElement = $state<HTMLButtonElement>();
	let tooltipElement = $state<HTMLElement>();
	let tooltipOpen = false;
	const exactLabel = $derived(exactTimestampLabel(value, action));
	const isoTimestamp = $derived(exactLabel && value ? new Date(value).toISOString() : undefined);
	const relativeLabel = $derived(relativeTimestampLabel(value, $currentTime, action, fallback));

	function positionTooltip(): void {
		if (!tooltipOpen || !timestampElement || !tooltipElement) return;
		const trigger = timestampElement.getBoundingClientRect();
		const tooltip = tooltipElement.getBoundingClientRect();
		const gutter = 8;
		const gap = 7;
		const centeredLeft = trigger.left + trigger.width / 2 - tooltip.width / 2;
		const left = Math.min(
			window.innerWidth - tooltip.width - gutter,
			Math.max(gutter, centeredLeft)
		);
		const above = trigger.top - tooltip.height - gap;
		const top =
			above >= gutter
				? above
				: Math.min(window.innerHeight - tooltip.height - gutter, trigger.bottom + gap);

		tooltipElement.style.left = `${Math.round(left)}px`;
		tooltipElement.style.top = `${Math.round(Math.max(gutter, top))}px`;
	}

	function showTooltip(): void {
		if (!exactLabel || !tooltipElement || tooltipOpen) return;
		tooltipElement.showPopover();
		tooltipOpen = true;
		positionTooltip();
	}

	function hideTooltip(): void {
		if (!tooltipElement || !tooltipOpen) return;
		tooltipElement.hidePopover();
		tooltipOpen = false;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') hideTooltip();
	}

	onMount(() => {
		const reposition = (): void => positionTooltip();
		window.addEventListener('resize', reposition);
		window.addEventListener('scroll', reposition, true);
		return () => {
			window.removeEventListener('resize', reposition);
			window.removeEventListener('scroll', reposition, true);
		};
	});
</script>

{#if exactLabel}
	<button
		bind:this={timestampElement}
		class="timestamp-trigger"
		type="button"
		aria-label={exactLabel}
		aria-describedby={tooltipId}
		onclick={showTooltip}
		onmouseenter={showTooltip}
		onmouseleave={hideTooltip}
		onfocus={showTooltip}
		onblur={hideTooltip}
		onkeydown={handleKeydown}
	>
		<time datetime={isoTimestamp}>{relativeLabel}</time>
	</button>
{:else}
	<time>{relativeLabel}</time>
{/if}

<span
	bind:this={tooltipElement}
	id={tooltipId}
	class="exact-time-tooltip"
	popover="manual"
	role="tooltip"
>
	{exactLabel ?? ''}
</span>

<style>
	.timestamp-trigger {
		margin: 0;
		padding: 0;
		border: 0;
		color: inherit;
		font: inherit;
		line-height: inherit;
		background: transparent;
		cursor: pointer;
	}

	.timestamp-trigger time {
		text-decoration: underline dotted color-mix(in srgb, currentColor 45%, transparent);
		text-decoration-thickness: 1px;
		text-underline-offset: 0.2em;
	}

	.exact-time-tooltip {
		position: fixed;
		inset: auto;
		width: max-content;
		max-width: min(32rem, calc(100vw - 1rem));
		margin: 0;
		padding: 0.48rem 0.62rem;
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 7px;
		color: white;
		font-family: inherit;
		font-size: 0.7rem;
		font-weight: 650;
		line-height: 1.35;
		text-align: left;
		background: var(--ink-soft, #1b2942);
		box-shadow: 0 8px 24px rgba(17, 24, 39, 0.22);
		pointer-events: none;
	}

	.exact-time-tooltip:popover-open {
		animation: tooltip-in 90ms ease-out;
	}

	@keyframes tooltip-in {
		from {
			opacity: 0;
			transform: translateY(2px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.exact-time-tooltip:popover-open {
			animation: none;
		}
	}
</style>
