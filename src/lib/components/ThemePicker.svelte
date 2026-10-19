<script lang="ts">
	import { setThemePreference, theme, type ThemePreference } from '$lib/theme.svelte';
</script>

<label class="theme-picker" title="Color theme">
	<svg aria-hidden="true" viewBox="0 0 24 24">
		{#if theme.preference === 'dark'}
			<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" />
		{:else if theme.preference === 'light'}
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
		{:else}
			<rect x="3" y="4" width="18" height="13" rx="2" />
			<path d="M8 21h8m-4-4v4" />
		{/if}
	</svg>
	<select
		aria-label="Color theme"
		value={theme.preference}
		onchange={(event) => setThemePreference(event.currentTarget.value as ThemePreference)}
	>
		<option value="system">System</option>
		<option value="light">Light</option>
		<option value="dark">Dark</option>
	</select>
</label>

<style>
	.theme-picker {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
	}

	svg {
		position: absolute;
		top: 14px;
		left: 12px;
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
		pointer-events: none;
	}

	select {
		width: 110px;
		min-height: 44px;
		padding: 0.5rem 0.5rem 0.5rem 34px;
		appearance: none;
		border: 1px solid var(--line);
		border-radius: 8px;
		color: var(--muted);
		background: var(--paper);
		font-size: 0.75rem;
		font-weight: 700;
		cursor: pointer;
	}

	select:hover {
		color: var(--ink);
		border-color: var(--line-strong);
	}

	@media (max-width: 480px) {
		select {
			width: 44px;
			padding-left: 43px;
			padding-right: 0;
			font-size: 16px;
		}
	}
</style>
